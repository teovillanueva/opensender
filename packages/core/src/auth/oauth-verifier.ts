import type { JSONWebKeySet } from "jose";
import { createLocalJWKSet, jwtVerify } from "jose";
import type { Auth } from "./auth.js";
import type { OAuthGrantsPort } from "./oauth-grants.js";
import { type KeyPermission, permissionForScopes } from "./oauth-scopes.js";

/**
 * OAuth access-token verification for the API (SPEC §16).
 * JWT-only by design: opaque tokens are rejected, so verification is a local
 * signature check against our own JWKS — no per-request introspection call.
 * The keyset comes from the jwt plugin in-process (`auth.api.getJwks`), not
 * over HTTP: the API and the auth server are the same Lambda.
 *
 * When the grant was narrowed to specific sending domains, the verifier
 * resolves the restriction from the grant record (keyed by the token's
 * azp + sub + team_id claims) and attaches it to the principal. The lookup
 * is one primary-key read, softened by a short in-memory cache.
 */

export interface OAuthPrincipal {
  /** The team the grant was consented against (`team_id` claim). */
  teamId: string;
  /** Mapped from the token's granted scopes. */
  permission: KeyPermission;
  /** Sending-domain restriction from the grant; absent = all domains. */
  allowedDomainIds?: string[];
}

export type OAuthTokenVerifier = (token: string) => Promise<OAuthPrincipal | null>;

interface CreateVerifierDeps {
  auth: Auth;
  /** Public origin of the API, e.g. https://api.mailing.example.com */
  baseURL: string;
  /** Resolves per-grant domain restrictions; omit to skip (tests). */
  grants?: Pick<OAuthGrantsPort, "getGrantDomains">;
  /** Cache TTL for grant-domain lookups; 0 disables caching (tests). */
  grantDomainsCacheTtlMs?: number;
}

function isUnknownKeyError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "ERR_JWKS_NO_MATCHING_KEY" || code === "ERR_JWKS_MULTIPLE_MATCHING_KEYS";
}

export function createOAuthTokenVerifier({
  auth,
  baseURL,
  grants,
  grantDomainsCacheTtlMs = 60_000,
}: CreateVerifierDeps): OAuthTokenVerifier {
  // Claim contract pinned by the core integration test: the issuer is the
  // auth handler's base (origin + /auth basePath) and the audience is the
  // RFC 8707 resource the client requested (the API, or its /mcp surface).
  const issuer = `${baseURL}/auth`;
  const audience = [baseURL, `${baseURL}/mcp`];

  let keySet: ReturnType<typeof createLocalJWKSet> | undefined;
  const loadKeySet = async (refresh: boolean) => {
    if (!keySet || refresh) {
      const jwks = (await auth.api.getJwks()) as JSONWebKeySet;
      keySet = createLocalJWKSet(jwks);
    }
    return keySet;
  };

  const domainsCache = new Map<string, { value: string[] | undefined; expiresAt: number }>();
  const domainsFor = async (
    clientId: string,
    userId: string,
    teamId: string,
  ): Promise<string[] | undefined> => {
    if (!grants) return undefined;
    const key = `${clientId}#${userId}#${teamId}`;
    const cached = domainsCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = await grants.getGrantDomains({ clientId, userId, teamId });
    domainsCache.set(key, { value, expiresAt: Date.now() + grantDomainsCacheTtlMs });
    return value;
  };

  return async (token) => {
    // Two attempts: cached keyset first, then one refresh — an unknown `kid`
    // usually means the signing key rotated under a warm container.
    for (const refresh of [false, true]) {
      try {
        const { payload } = await jwtVerify(token, await loadKeySet(refresh), {
          issuer,
          audience,
        });
        const teamId = payload.team_id;
        const scope = payload.scope;
        if (typeof teamId !== "string" || typeof scope !== "string") return null;
        const permission = permissionForScopes(scope.split(" "));
        if (!permission) return null;
        const allowedDomainIds =
          typeof payload.azp === "string" && typeof payload.sub === "string"
            ? await domainsFor(payload.azp, payload.sub, teamId)
            : undefined;
        return {
          teamId,
          permission,
          ...(allowedDomainIds ? { allowedDomainIds } : {}),
        };
      } catch (error) {
        if (!refresh && isUnknownKeyError(error)) continue;
        // Expired, bad signature, wrong iss/aud, malformed: all just an
        // invalid bearer to the caller.
        return null;
      }
    }
    return null;
  };
}
