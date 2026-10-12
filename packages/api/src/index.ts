import { publicOpenapiDocument } from "@opensender/contract";
import type {
  ApiKeysPort,
  Auth,
  BootstrapPort,
  BroadcastsPort,
  ContactsPort,
  DomainsPort,
  OAuthGrantsPort,
  QueuePublisher,
  RateLimiterPort,
  SegmentsPort,
  TeamsPort,
  WebhooksPort,
} from "@opensender/core";
import { OAUTH_SCOPES } from "@opensender/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { errors, ResendApiError, sendError, sendJson } from "./errors.js";
import { mcpRoutes } from "./mcp/index.js";
import {
  type AuthenticateDeps,
  authenticate,
  enforceKeyPermissions,
} from "./middleware/authenticate.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { type BroadcastSenderPort, broadcastRoutes } from "./routes/broadcasts.js";
import { domainRoutes } from "./routes/domains.js";
import { type EmailsRouteDeps, emailRoutes } from "./routes/emails.js";
import { bootstrapRoutes } from "./routes/internal.js";
import { dashboardRoutes } from "./routes/internal-dashboard.js";
import { receivingRoutes } from "./routes/receiving.js";
import { segmentRoutes } from "./routes/segments.js";
import { type UnsubscribeContactsPort, unsubscribeRoutes } from "./routes/unsubscribe.js";
import { webhookRoutes } from "./routes/webhooks.js";

export { errors, ResendApiError } from "./errors.js";
export type { Principal } from "./middleware/authenticate.js";

export interface AppDeps {
  apiKeys: ApiKeysPort;
  teams: TeamsPort;
  domains: DomainsPort;
  emails: EmailsRouteDeps["emails"];
  idempotency: EmailsRouteDeps["idempotency"];
  quotaUsage: EmailsRouteDeps["quotaUsage"];
  now: EmailsRouteDeps["now"];
  webhooks: WebhooksPort;
  segments: SegmentsPort;
  contacts: ContactsPort;
  broadcasts: BroadcastsPort;
  /** Fan-out trigger for broadcast sends; implemented by the Infra phase. */
  broadcastSender: BroadcastSenderPort;
  /** Team-agnostic contact resolver for the public unsubscribe flow. */
  unsubscribeContacts: UnsubscribeContactsPort;
  /** HMAC secret backing signed one-click unsubscribe tokens (SPEC §11.2). */
  unsubscribeSecret: string;
  /** Publishes webhook-dispatch messages for the dashboard replay action. */
  webhookReplay: QueuePublisher;
  rateLimiter: RateLimiterPort;
  auth: Auth;
  /** Verifies OAuth JWT access tokens (absent in tests that don't need it). */
  oauthTokens?: AuthenticateDeps["oauthTokens"];
  /** Lists/revokes OAuth grants for the connected-apps dashboard page. */
  oauthGrants: OAuthGrantsPort;
  bootstrap: BootstrapPort;
  /** Origin allowed to make credentialed browser requests (the dashboard). */
  dashboardOrigin: string;
  /**
   * Public origin of the API (e.g. https://api.mailing.example.com). Behind the
   * router the Lambda sees its function URL in `c.req.url`, so OAuth
   * discovery documents must NOT derive the origin from the request. Falls
   * back to the request origin when absent (tests, local).
   */
  apiOrigin?: string | undefined;
  /**
   * Liveness probe backend (SPEC §15): one light DynamoDB read, never SES.
   * `/health` returns 503 if it throws. Optional so tests/local skip the read.
   */
  health?: (() => Promise<void>) | undefined;
  /**
   * Structured reporter for unhandled route errors (SPEC §15). Injected by the
   * Lambda composition root (Powertools logger + Sentry); defaults to `console`
   * for local/test runs so the HTTP layer keeps no Powertools dependency.
   */
  logger?: { error(message: string, extra?: Record<string, unknown>): void } | undefined;
}

const publicOpenapiBody = JSON.stringify(publicOpenapiDocument);

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];

/** Fixture 04: known path + wrong method is 405, not 404. */
function pathKnownUnderOtherMethod(app: Hono, method: string, path: string): boolean {
  return app.routes.some((route) => {
    if (!METHODS.includes(route.method) || route.method === method) return false;
    const pattern = `^${route.path.replace(/:[^/]+/g, "[^/]+").replace(/\*/g, ".*")}$`;
    return new RegExp(pattern).test(path);
  });
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // OAuth discovery: the two documents MCP hosts walk from a
  // /mcp 401 (WWW-Authenticate → protected resource → authorization server).
  // Registered ahead of the CORS middleware because browsers (MCP Inspector)
  // fetch them from arbitrary origins — they answer with a wildcard instead
  // of the dashboard-only policy below.
  app.get("/.well-known/oauth-protected-resource", (c) => {
    const origin = deps.apiOrigin ?? new URL(c.req.url).origin;
    return c.body(
      JSON.stringify({
        resource: origin,
        authorization_servers: [`${origin}/auth`],
        bearer_methods_supported: ["header"],
        scopes_supported: [...OAUTH_SCOPES],
      }),
      200,
      {
        "content-type": "application/json",
        "cache-control": "public, max-age=15, stale-while-revalidate=15, stale-if-error=86400",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET",
      },
    );
  });
  // RFC 8414 root alias for issuers with a path component (ours is /auth);
  // better-auth serves it once the request reaches its handler.
  app.get("/.well-known/oauth-authorization-server/*", (c) => deps.auth.handler(c.req.raw));

  // Public API is server-to-server; only the dashboard origin gets CORS, and
  // only with credentials for the session-cookie (dogfooding) path (SPEC §16).
  app.use(
    "*",
    cors({
      origin: deps.dashboardOrigin,
      credentials: true,
      allowHeaders: ["authorization", "content-type", "idempotency-key", "x-batch-validation"],
    }),
  );

  app.get("/openapi.json", (c) =>
    c.body(publicOpenapiBody, 200, { "content-type": "application/json" }),
  );

  // Uptime probe (x-internal): one light DynamoDB read, never SES (SPEC §15).
  // Better Stack polls this every 1–3 min; a DynamoDB outage flips it to 503.
  app.get("/health", async (c) => {
    try {
      await deps.health?.();
      return sendJson(c, 200, { status: "ok" });
    } catch {
      return sendJson(c, 503, { status: "error" });
    }
  });

  // Dashboard auth (better-auth owns everything under /auth).
  app.on(["GET", "POST"], "/auth/*", (c) => deps.auth.handler(c.req.raw));

  // First-run admin bootstrap (x-internal, token-gated).
  app.route("/internal/bootstrap", bootstrapRoutes(deps));

  // Public one-click unsubscribe (SPEC §11.2) — no auth, mounted outside the
  // authed group like the bootstrap surface.
  app.route("/unsubscribe", unsubscribeRoutes(deps));

  // MCP server (SPEC §14): bearer auth + rate limiting, but capability is
  // filtered by registered tools rather than the path-based key-permission
  // guard, so it mounts outside the `authed` group with its own middleware.
  app.route("/mcp", mcpRoutes(deps));

  // Resend-compatible surface: bearer key or dashboard session. Fixture 37:
  // the restricted-key 401 carries no ratelimit headers, so the permission
  // check precedes the bucket.
  const authed = new Hono();
  authed.use("*", authenticate(deps));
  authed.use("*", enforceKeyPermissions());
  authed.use("*", rateLimit(deps));
  authed.route("/api-keys", apiKeyRoutes(deps));
  authed.route("/domains", domainRoutes(deps));
  // Register the more specific /emails/receiving before /emails/:id.
  authed.route("/emails/receiving", receivingRoutes(deps));
  authed.route("/emails", emailRoutes(deps));
  authed.route("/webhooks", webhookRoutes(deps));
  // Same segment records under both labels: /audiences is the deprecated alias.
  authed.route("/audiences", segmentRoutes(deps, { objectName: "audience" }));
  authed.route("/segments", segmentRoutes(deps, { objectName: "segment" }));
  authed.route("/broadcasts", broadcastRoutes(deps));
  // x-internal dashboard surface (delivery logs, timelines, webhook replay,
  // usage) — authenticated by the dashboard session, mounted under /internal
  // alongside the unauthenticated /internal/bootstrap.
  authed.route(
    "/internal",
    dashboardRoutes({
      emails: deps.emails,
      webhooks: deps.webhooks,
      teams: deps.teams,
      quotaUsage: deps.quotaUsage,
      webhookReplay: deps.webhookReplay,
      auth: deps.auth,
      oauthGrants: deps.oauthGrants,
      domains: deps.domains,
    }),
  );
  app.route("/", authed);

  app.notFound((c) => {
    if (pathKnownUnderOtherMethod(app, c.req.method, c.req.path)) {
      return sendError(c, errors.methodNotAllowed(c.req.method));
    }
    return sendError(c, errors.notFound("Not found"));
  });

  app.onError((error, c) => {
    if (error instanceof ResendApiError) return sendError(c, error);
    (deps.logger ?? console).error("unhandled error", { error, path: c.req.path });
    return sendError(c, errors.internal());
  });

  return app;
}
