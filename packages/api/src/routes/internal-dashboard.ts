import type {
  Auth,
  DomainsPort,
  EmailsPort,
  OAuthGrantsPort,
  QueuePublisher,
  QuotaUsage,
  StoredSuppression,
  TeamsPort,
  WebhooksPort,
} from "@opensender/core";
import { SuppressionExistsError, toWireEmail } from "@opensender/core";
import { Hono } from "hono";
import { errors, sendJson } from "../errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_STATUSES = new Set([
  "queued",
  "scheduled",
  "sent",
  "delivered",
  "delivery_delayed",
  "bounced",
  "complained",
  "failed",
  "canceled",
  "received",
]);

export interface DashboardRouteDeps {
  emails: Pick<
    EmailsPort,
    | "getEmail"
    | "listEmails"
    | "listEvents"
    | "listSuppressions"
    | "getSuppression"
    | "addSuppression"
    | "removeSuppression"
    | "metricsSummary"
  >;
  webhooks: Pick<WebhooksPort, "getEndpoint" | "listDeliveries" | "getDelivery">;
  teams: Pick<TeamsPort, "getTeam" | "quotasFor">;
  quotaUsage: (teamId: string) => Promise<QuotaUsage>;
  /** Publishes a webhook-dispatch message to replay a stored delivery. */
  webhookReplay: QueuePublisher;
  /** Resolves the dashboard session — OAuth grants belong to a user, not a key. */
  auth: { api: Pick<Auth["api"], "getSession"> };
  oauthGrants: OAuthGrantsPort;
  /** Validates that a grant's domain restriction names this team's domains. */
  domains: Pick<DomainsPort, "getDomain">;
}

function clampLimit(raw: string | undefined, fallback: number): number {
  return Math.min(Math.max(Number(raw ?? fallback) || fallback, 1), 100);
}

/**
 * x-internal dashboard surface (SPEC §13): read models and actions the Resend
 * public API does not cover — delivery logs, an email's event timeline,
 * webhook delivery logs + replay, usage/quota, and simple metrics. All
 * team-scoped via the authenticated principal and cursor-paginated.
 */
export function dashboardRoutes(deps: DashboardRouteDeps): Hono {
  const app = new Hono();

  // OAuth grant management. Grants belong to a
  // user+team pair, so this surface requires the dashboard session — an API
  // key resolves a team but no user, and is rejected like a missing key.
  app.get("/oauth-grants", async (c) => {
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw errors.missingApiKey();
    const grants = await deps.oauthGrants.listGrants(session.user.id, c.get("principal").teamId);
    return sendJson(c, 200, {
      object: "list",
      data: grants.map((grant) => ({
        id: grant.id,
        client_id: grant.clientId,
        client_name: grant.clientName,
        scopes: grant.scopes,
        created_at: grant.createdAt,
        last_used_at: grant.lastUsedAt,
        domain_ids: grant.domainIds,
      })),
    });
  });

  // Narrow a grant to specific sending domains, Resend's "Domain" picker.
  // Called by the consent screen BEFORE accepting consent, so the very first
  // token issued already carries the restriction.
  app.post("/oauth-grants/domains", async (c) => {
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw errors.missingApiKey();
    const teamId = c.get("principal").teamId;
    const body = (await c.req.json().catch(() => undefined)) as
      | { client_id?: unknown; domain_ids?: unknown }
      | undefined;
    const clientId = typeof body?.client_id === "string" ? body.client_id : "";
    if (!clientId) throw errors.invalidParameter("`client_id` is required.");
    const domainIds =
      body?.domain_ids === null
        ? null
        : Array.isArray(body?.domain_ids) &&
            body.domain_ids.every((id): id is string => typeof id === "string")
          ? body.domain_ids
          : undefined;
    if (domainIds === undefined) {
      throw errors.invalidParameter("`domain_ids` must be an array of domain ids or null.");
    }
    // The restriction must only ever name this team's domains.
    for (const domainId of domainIds ?? []) {
      if (!(await deps.domains.getDomain(teamId, domainId))) {
        throw errors.invalidParameter(`Unknown domain id: ${domainId}`);
      }
    }
    await deps.oauthGrants.setGrantDomains(
      { clientId, userId: session.user.id, teamId },
      domainIds,
    );
    return sendJson(c, 200, { client_id: clientId, domain_ids: domainIds });
  });

  app.post("/oauth-grants/:id/revoke", async (c) => {
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw errors.missingApiKey();
    const id = c.req.param("id");
    const revoked = await deps.oauthGrants.revokeGrant(
      session.user.id,
      c.get("principal").teamId,
      id,
    );
    if (!revoked) throw errors.notFound("Grant not found");
    return sendJson(c, 200, { id, revoked: true });
  });

  // Emails list (delivery log): newest-first, cursor-paginated; direction,
  // status and date-range filters (SPEC §13.3).
  app.get("/emails", async (c) => {
    const teamId = c.get("principal").teamId;
    const limit = clampLimit(c.req.query("limit"), 25);
    const direction = c.req.query("direction") === "inbound" ? "inbound" : "outbound";
    const cursor = c.req.query("cursor") ?? undefined;
    const status = c.req.query("status");
    if (status && !EMAIL_STATUSES.has(status)) {
      throw errors.invalidParameter("Unknown `status` filter.");
    }
    const result = await deps.emails.listEmails(teamId, limit, direction, cursor, {
      status: status || undefined,
      after: parseInstant(c.req.query("after"), "after"),
      before: parseInstant(c.req.query("before"), "before"),
      apiKeyId: c.req.query("api_key_id") || undefined,
    });
    return sendJson(c, 200, {
      object: "list",
      has_more: result.cursor !== null,
      cursor: result.cursor,
      data: result.emails.map((email) => toWireEmail(email)),
    });
  });

  // Aggregated outbound metrics (SPEC §13): volume, outcomes, per-domain.
  app.get("/metrics", async (c) => {
    const teamId = c.get("principal").teamId;
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 15) || 15, 1), 90);
    const domain = c.req.query("domain") || undefined;
    const summary = await deps.emails.metricsSummary(teamId, days, domain);
    const { attempted, delivered, bounced, complained } = summary.totals;
    return sendJson(c, 200, {
      object: "metrics",
      days,
      ...summary,
      rates: {
        deliverability: attempted > 0 ? delivered / attempted : null,
        bounce: attempted > 0 ? bounced / attempted : null,
        complaint: attempted > 0 ? complained / attempted : null,
      },
    });
  });

  // Suppression list (SPEC §13): newest-first, cursor-paginated.
  app.get("/suppressions", async (c) => {
    const teamId = c.get("principal").teamId;
    const limit = clampLimit(c.req.query("limit"), 25);
    const cursor = c.req.query("cursor") ?? undefined;
    const result = await deps.emails.listSuppressions(teamId, limit, cursor);
    return sendJson(c, 200, {
      object: "list",
      has_more: result.cursor !== null,
      cursor: result.cursor,
      data: result.suppressions.map((suppression) => wireSuppression(suppression)),
    });
  });

  // Manual suppression add (dashboard "Add email address").
  app.post("/suppressions", async (c) => {
    const teamId = c.get("principal").teamId;
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown };
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email.includes("@")) {
      throw errors.invalidParameter("The `email` field must be a valid address.");
    }
    try {
      const suppression = await deps.emails.addSuppression(teamId, email);
      return sendJson(c, 201, wireSuppression(suppression));
    } catch (error) {
      if (error instanceof SuppressionExistsError) {
        throw errors.invalidParameter(error.message);
      }
      throw error;
    }
  });

  // Suppression detail: the entry plus the source bounce/complaint event
  // payload (carries the SMTP diagnostic when SES reported one).
  app.get("/suppressions/:email", async (c) => {
    const teamId = c.get("principal").teamId;
    const suppression = await deps.emails.getSuppression(teamId, c.req.param("email") ?? "");
    if (!suppression) throw errors.notFound("Suppression not found");
    let sourceEvent: unknown = null;
    if (suppression.sourceEmailId) {
      const events = await deps.emails.listEvents(teamId, suppression.sourceEmailId);
      sourceEvent =
        events
          .filter((event) => event.type === "email.bounced" || event.type === "email.complained")
          .at(-1)?.payload ?? null;
    }
    return sendJson(c, 200, { ...wireSuppression(suppression), source_event: sourceEvent });
  });

  app.delete("/suppressions/:email", async (c) => {
    const teamId = c.get("principal").teamId;
    const email = c.req.param("email") ?? "";
    const removed = await deps.emails.removeSuppression(teamId, email);
    if (!removed) throw errors.notFound("Suppression not found");
    return sendJson(c, 200, { object: "suppression", email: email.toLowerCase(), deleted: true });
  });

  // Email detail with its event timeline (SPEC §13.3).
  app.get("/emails/:id", async (c) => {
    const teamId = c.get("principal").teamId;
    const id = c.req.param("id") ?? "";
    const email = await deps.emails.getEmail(teamId, id);
    if (!email) throw errors.notFound("Email not found");
    const events = await deps.emails.listEvents(teamId, id);
    return sendJson(c, 200, {
      ...toWireEmail(email),
      events: events.map((event) => ({
        type: event.type,
        occurred_at: event.occurredAt,
        ...(event.payload === undefined ? {} : { data: event.payload }),
      })),
    });
  });

  // Webhook delivery log for one endpoint (SPEC §13.6).
  app.get("/webhooks/:id/deliveries", async (c) => {
    const endpoint = await requireEndpoint(c.get("principal").teamId, c.req.param("id") ?? "");
    const limit = clampLimit(c.req.query("limit"), 25);
    const cursor = c.req.query("cursor") ?? undefined;
    const result = await deps.webhooks.listDeliveries(endpoint.endpointId, limit, cursor);
    return sendJson(c, 200, {
      object: "list",
      has_more: result.cursor !== null,
      cursor: result.cursor,
      data: result.deliveries.map((delivery) => ({
        id: delivery.deliveryId,
        svix_id: delivery.svixId,
        type: delivery.type,
        attempt: delivery.attempt,
        outcome: delivery.outcome,
        ...(delivery.statusCode === undefined ? {} : { status_code: delivery.statusCode }),
        ...(delivery.durationMs === undefined ? {} : { duration_ms: delivery.durationMs }),
        ...(delivery.error === undefined ? {} : { error: delivery.error }),
        created_at: delivery.createdAt,
      })),
    });
  });

  // Replay a stored delivery through the dispatcher (SPEC §13.6): re-enqueue
  // the original signed payload; a fresh attempt is logged on delivery.
  app.post("/webhooks/:id/deliveries/:deliveryId/replay", async (c) => {
    const endpoint = await requireEndpoint(c.get("principal").teamId, c.req.param("id") ?? "");
    const deliveryId = c.req.param("deliveryId") ?? "";
    const delivery = await deps.webhooks.getDelivery(endpoint.endpointId, deliveryId);
    if (!delivery) throw errors.notFound("Delivery not found");
    await deps.webhookReplay.enqueue({
      endpointId: endpoint.endpointId,
      svixId: delivery.svixId,
      type: delivery.type,
      body: delivery.payload,
    });
    return sendJson(c, 202, { object: "webhook_delivery", id: deliveryId, replayed: true });
  });

  // Usage: quota consumption, plan limits, and tenant status (SPEC §13.9).
  app.get("/usage", async (c) => {
    const teamId = c.get("principal").teamId;
    const team = await deps.teams.getTeam(teamId);
    if (!team) throw errors.notFound("Team not found");
    const [usage, limits] = [await deps.quotaUsage(teamId), deps.teams.quotasFor(team)];
    return sendJson(c, 200, {
      object: "usage",
      team: { id: team.teamId, name: team.name, status: team.status, plan: team.plan },
      sent: { daily: usage.daily, monthly: usage.monthly },
      limits: {
        daily_email_limit: limits.dailyEmailLimit,
        api_rate_limit_per_second: limits.apiRateLimitPerSecond,
      },
    });
  });

  async function requireEndpoint(teamId: string, id: string) {
    if (!UUID_PATTERN.test(id)) {
      throw errors.invalidParameter("The `id` must be a valid UUID.");
    }
    const endpoint = await deps.webhooks.getEndpoint(teamId, id);
    if (!endpoint) throw errors.notFound("Webhook not found");
    return endpoint;
  }

  return app;
}

function wireSuppression(suppression: StoredSuppression): Record<string, unknown> {
  return {
    object: "suppression",
    email: suppression.email,
    reason: suppression.reason,
    source_email_id: suppression.sourceEmailId ?? null,
    created_at: new Date(suppression.createdAt).toISOString(),
  };
}

/** Validate an optional ISO date/instant query param, normalizing to ISO. */
function parseInstant(raw: string | undefined, name: string): string | undefined {
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw errors.invalidParameter(`The \`${name}\` field must be an ISO 8601 date.`);
  }
  return parsed.toISOString();
}
