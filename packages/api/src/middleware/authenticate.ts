import type { ApiKeysPort, Auth, OAuthTokenVerifier, VerifiedKey } from "@opensender/core";
import type { Context, MiddlewareHandler } from "hono";
import { errors } from "../errors.js";

/**
 * Principal resolution for the public surface (SPEC §5, §13): a Resend-style
 * bearer key, an OAuth JWT access token, or — dogfooding —
 * a dashboard session whose active organization is the team. Fixture
 * semantics: no Authorization header ⇒ 401 missing_api_key; a bearer that
 * doesn't verify ⇒ 400 validation_error.
 */

export interface Principal {
  teamId: string;
  /** Session principals act with full access; keys carry their permission. */
  permission: "full_access" | "sending_access";
  apiKey?: VerifiedKey;
  /** OAuth grants narrowed to specific sending domains. */
  allowedDomainIds?: string[] | undefined;
}

declare module "hono" {
  interface ContextVariableMap {
    principal: Principal;
  }
}

export interface AuthenticateDeps {
  apiKeys: ApiKeysPort;
  auth: Auth;
  /** Verifies OAuth JWT access tokens into a team-scoped principal. */
  oauthTokens?: OAuthTokenVerifier | undefined;
}

async function sessionPrincipal(c: Context, deps: AuthenticateDeps): Promise<Principal | null> {
  const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
  const teamId = session?.session.activeOrganizationId;
  if (!session || !teamId) return null;
  // activeOrganizationId is a session snapshot: better-auth does NOT touch a
  // member's sessions on removal, so membership must be re-checked or a
  // removed member would keep team access until their session expires.
  const context = await deps.auth.$context;
  const membership = await context.adapter.findOne({
    model: "member",
    where: [
      { field: "organizationId", value: teamId },
      { field: "userId", value: session.user.id },
    ],
  });
  if (!membership) return null;
  return { teamId, permission: "full_access" };
}

export function authenticate(deps: AuthenticateDeps): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("authorization");
    if (!header) {
      const principal = await sessionPrincipal(c, deps);
      if (!principal) throw errors.missingApiKey();
      c.set("principal", principal);
      return next();
    }

    const token = header.replace(/^Bearer\s+/i, "");

    // OAuth access tokens are JWTs (three dot-separated segments) carrying
    // team + scope claims; `re_` keys never contain dots, so the shape check
    // can't shadow a real key. Both invalid paths converge on the same 400.
    if (deps.oauthTokens && token.split(".").length === 3) {
      const principal = await deps.oauthTokens(token);
      if (!principal) throw errors.invalidApiKey();
      c.set("principal", principal);
      return next();
    }

    const verified = await deps.apiKeys.verifyToken(token);
    if (!verified) throw errors.invalidApiKey();
    c.set("principal", {
      teamId: verified.teamId,
      permission: verified.permission,
      apiKey: verified,
    });
    return next();
  };
}

/** sending_access keys reach only POST /emails* (SPEC §16, fixture 37). */
export function enforceKeyPermissions(): MiddlewareHandler {
  return async (c, next) => {
    const principal = c.get("principal");
    if (principal.permission !== "full_access") {
      const isSendRoute =
        c.req.method === "POST" && (c.req.path === "/emails" || c.req.path === "/emails/batch");
      if (!isSendRoute) throw errors.restrictedApiKey();
    }
    return next();
  };
}
