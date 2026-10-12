/**
 * OAuth 2.1 scope surface (Resend parity): `emails:send` grants the same
 * capability as a `sending_access` API key, `full_access` the same as a
 * `full_access` key, and `offline_access` opts into refresh tokens. The API
 * middleware maps a token's granted scopes onto the existing Principal
 * permission, so everything downstream of authentication is scope-agnostic.
 */

export const OAUTH_SCOPES = ["emails:send", "full_access", "offline_access"] as const;

export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export type KeyPermission = "full_access" | "sending_access";

/** Broadest permission the granted scopes carry; null when none applies. */
export function permissionForScopes(scopes: readonly string[]): KeyPermission | null {
  if (scopes.includes("full_access")) return "full_access";
  if (scopes.includes("emails:send")) return "sending_access";
  return null;
}
