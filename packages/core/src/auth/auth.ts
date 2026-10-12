import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { admin } from "better-auth/plugins/admin";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import type { DBAdapter } from "better-auth/types";
import { dynamodbAdapter } from "../adapters/better-auth-dynamodb.js";
import type { TableConfig } from "../adapters/dynamo-entities.js";
import type { TeamsService } from "../teams/teams.js";
import { OAUTH_SCOPES } from "./oauth-scopes.js";

export interface CreateAuthDeps extends TableConfig {
  secret: string;
  /** Public origin of the API, e.g. https://api.mailing.example.com */
  baseURL: string;
  /** Origins allowed to talk to the auth endpoints (the dashboard). */
  trustedOrigins: string[];
  /**
   * Dashboard origin, e.g. https://mailing.example.com. OAuth login/consent
   * pages live there, not on the API origin, so the plugin needs absolute
   * URLs for its redirect screens.
   */
  dashboardOrigin: string;
  /** SPEC §13.1: when false, sign-up is rejected server-side. */
  signupOpen: boolean;
  teams: TeamsService;
}

/**
 * Dashboard auth (SPEC §13). Teams are better-auth organizations; the
 * afterCreateOrganization hook makes the SES tenant + domain Team record, so
 * an org and its Team share the same id, 1:1. If the hook throws, the org
 * row exists without a Team — recreating is safe because createTeam is
 * convergent (deterministic tenant name, AlreadyExists tolerated).
 *
 * Also an OAuth 2.1 provider (Resend parity): the
 * oauthProvider plugin serves authorize/token/revoke plus RFC 7591 dynamic
 * client registration under `/auth/oauth2/*`, issuing 15-minute JWT access
 * tokens signed by the jwt plugin's JWKS. A grant is consented against ONE
 * team: the postLogin hook pins `referenceId` to the session's active
 * organization, and every token issuance re-checks that the user still
 * belongs to that team (grants must not outlive membership).
 */
export function createAuth({
  client,
  table,
  secret,
  baseURL,
  trustedOrigins,
  dashboardOrigin,
  signupOpen,
  teams,
}: CreateAuthDeps) {
  // Plugin hooks run at request time, long after `auth` exists; closing over
  // the instance is the only adapter handle better-auth offers config code.
  // The ref is typed independently of `auth` to break the type circularity
  // (hooks are part of auth's own initializer).
  // biome-ignore lint/suspicious/noExplicitAny: DBAdapter's options generic is invariant; the ref only needs the adapter surface.
  let adapterRef: { $context: Promise<{ adapter: DBAdapter<any> }> };
  // biome-ignore lint/suspicious/noExplicitAny: same as above.
  const getAdapter = async (): Promise<DBAdapter<any>> => (await adapterRef.$context).adapter;

  const membershipExists = async (userId: string, teamId: string): Promise<boolean> => {
    const adapter = await getAdapter();
    const membership = await adapter.findOne({
      model: "member",
      where: [
        { field: "organizationId", value: teamId },
        { field: "userId", value: userId },
      ],
    });
    return membership !== null;
  };

  const activeTeamId = (session: Record<string, unknown>): string | undefined =>
    (session.activeOrganizationId as string | undefined) ?? undefined;

  const auth = betterAuth({
    database: dynamodbAdapter({ client, table }),
    secret,
    baseURL,
    basePath: "/auth",
    trustedOrigins,
    // The jwt plugin's session-JWT endpoint (`/auth/token`) is unrelated to
    // the OAuth surface; disable it so bearer JWTs only ever originate from
    // `/auth/oauth2/token` with team-scoped claims.
    disabledPaths: ["/token"],
    // NOTE: session cookieCache is intentionally OFF. The API derives the acting
    // team from `session.activeOrganizationId`, which changes on team
    // switch/create; a cached session cookie would serve a stale (or absent)
    // active org for up to its TTL, making a just-switched team's requests fail.
    // Correctness of the team context outweighs saving one session read.
    emailAndPassword: {
      enabled: true,
      disableSignUp: !signupOpen,
    },
    plugins: [
      admin(),
      organization({
        organizationHooks: {
          afterCreateOrganization: async ({ organization: org }) => {
            await teams.createTeam({ teamId: org.id, name: org.name });
          },
          // Renames go through the org surface; mirror them onto the Team
          // record so usage/metrics don't show a stale name.
          afterUpdateOrganization: async ({ organization: org }) => {
            if (org?.name) await teams.updateName(org.id, org.name);
          },
        },
      }),
      // Registers our per-grant sending-domain restriction model with the
      // adapter (better-auth adapters are schema-aware; unregistered models
      // throw). Rows are managed by createOAuthGrants, never by better-auth.
      {
        id: "opensender-oauth-grant-domains",
        schema: {
          oauthGrantDomains: {
            fields: {
              clientId: { type: "string", required: true },
              userId: { type: "string", required: true },
              referenceId: { type: "string", required: true },
              domainIds: { type: "string[]", required: false },
              createdAt: { type: "date", required: false },
            },
          },
        },
      },
      jwt(),
      oauthProvider({
        loginPage: `${dashboardOrigin}/login`,
        consentPage: `${dashboardOrigin}/consent`,
        scopes: [...OAUTH_SCOPES],
        // Resend parity: 15-minute JWT access tokens; no M2M grant in v1.
        accessTokenExpiresIn: 15 * 60,
        grantTypes: ["authorization_code", "refresh_token"],
        // MCP hosts request the API or its /mcp URL as the RFC 8707 resource.
        validAudiences: [baseURL, `${baseURL}/mcp`],
        allowDynamicClientRegistration: true,
        // Public-client self-registration keeps the MCP connect flow
        // zero-config; the flag is scoped to public clients by the plugin.
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: ["emails:send", "offline_access"],
        clientRegistrationAllowedScopes: ["full_access"],
        clientReference: ({ session }) => (session ? activeTeamId(session) : undefined),
        postLogin: {
          // The consent screen owns team selection inline (Resend-style
          // Team dropdown), so the flow NEVER detours to a separate page:
          // shouldRedirect is a constant false and `page` is unreachable.
          // consentReferenceId still pins the grant to the active org the
          // consent screen just set.
          page: `${dashboardOrigin}/consent`,
          shouldRedirect: async () => false,
          consentReferenceId: async ({ user, session }) => {
            const teamId = activeTeamId(session);
            if (!teamId) {
              throw new APIError("BAD_REQUEST", {
                error: "set_team",
                error_description: "an active team is required before consenting",
              });
            }
            if (!(await membershipExists(user.id, teamId))) {
              throw new APIError("FORBIDDEN", {
                error: "not_a_member",
                error_description: "the user does not belong to the selected team",
              });
            }
            return teamId;
          },
        },
        // Runs on every issuance — authorization_code AND refresh_token — so
        // a grant stops minting tokens the moment the user leaves the team
        // (mirrors the sessionPrincipal staleness guard in the API).
        customAccessTokenClaims: async ({ user, referenceId }) => {
          if (!user || !referenceId) {
            throw new APIError("BAD_REQUEST", {
              error: "invalid_grant",
              error_description: "token is not bound to a user and team",
            });
          }
          if (!(await membershipExists(user.id, referenceId))) {
            throw new APIError("FORBIDDEN", {
              error: "not_a_member",
              error_description: "the user no longer belongs to the granted team",
            });
          }
          return { team_id: referenceId };
        },
      }),
    ],
  });

  adapterRef = auth;
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
