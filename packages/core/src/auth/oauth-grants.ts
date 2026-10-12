import type { Auth } from "./auth.js";

/**
 * Dashboard-facing management of OAuth grants.
 * A "grant" is a consent row plus the refresh tokens minted under it.
 * Deleting the consent alone is NOT revocation: the plugin's refresh grant
 * never re-reads consent, so a live refresh token would keep minting access
 * tokens for its 30-day life. Revoking here also marks every matching
 * refresh token revoked and drops opaque access tokens hanging off them
 * (outstanding JWTs die at their 15-minute expiry — accepted trade-off).
 *
 * Grants can additionally be narrowed to specific sending domains (Resend's
 * "Domain" picker under Sending access). The restriction lives in our own
 * `oauthGrantDomains` model — the plugin has no per-grant metadata — keyed
 * deterministically by (clientId, userId, teamId) so the token verifier can
 * resolve it with a single primary-key read.
 */

export interface OAuthGrant {
  /** Consent id — the handle revocation takes. */
  id: string;
  clientId: string;
  clientName: string | null;
  scopes: string[];
  createdAt: string | null;
  /** Newest refresh-token issuance for this grant — access tokens live 15
   * minutes, so an active app refreshes on that cadence. */
  lastUsedAt: string | null;
  /** Sending-domain restriction; null = all domains. */
  domainIds: string[] | null;
}

export interface GrantKey {
  clientId: string;
  userId: string;
  teamId: string;
}

export interface OAuthGrantsPort {
  listGrants(userId: string, teamId: string): Promise<OAuthGrant[]>;
  /** False when the grant doesn't exist or belongs to another user/team. */
  revokeGrant(userId: string, teamId: string, consentId: string): Promise<boolean>;
  /** Narrow (or clear, with null) the domains a grant may send from. */
  setGrantDomains(key: GrantKey, domainIds: string[] | null): Promise<void>;
  /** The restriction for a grant; undefined = unrestricted. */
  getGrantDomains(key: GrantKey): Promise<string[] | undefined>;
}

interface ConsentRow {
  id: string;
  clientId: string;
  userId: string;
  referenceId?: string;
  scopes?: string[];
  createdAt?: string;
}

interface RefreshRow {
  id: string;
  clientId: string;
  referenceId?: string;
  revoked?: string | null;
  createdAt?: string;
}

interface GrantDomainsRow {
  id: string;
  domainIds?: string[];
}

const GRANT_DOMAINS_MODEL = "oauthGrantDomains";

/** One row per (clientId, userId, teamId); clientId is the indexed field. */
function grantDomainsWhere({ clientId, userId, teamId }: GrantKey) {
  return [
    { field: "clientId", value: clientId },
    { field: "userId", value: userId },
    { field: "referenceId", value: teamId },
  ];
}

export function createOAuthGrants(
  auth: Auth,
  clock: () => Date = () => new Date(),
): OAuthGrantsPort {
  const adapter = async () => (await auth.$context).adapter;

  const getGrantDomains = async (key: GrantKey): Promise<string[] | undefined> => {
    const db = await adapter();
    const row = await db.findOne<GrantDomainsRow>({
      model: GRANT_DOMAINS_MODEL,
      where: grantDomainsWhere(key),
    });
    return row?.domainIds && row.domainIds.length > 0 ? row.domainIds : undefined;
  };

  return {
    async listGrants(userId, teamId) {
      const db = await adapter();
      const consents = await db.findMany<ConsentRow>({
        model: "oauthConsent",
        where: [{ field: "userId", value: userId }],
      });
      const refreshTokens = await db.findMany<RefreshRow>({
        model: "oauthRefreshToken",
        where: [{ field: "userId", value: userId }],
      });
      return Promise.all(
        consents
          .filter((consent) => consent.referenceId === teamId)
          .map(async (consent) => {
            const client = await db.findOne<{ name?: string }>({
              model: "oauthClient",
              where: [{ field: "clientId", value: consent.clientId }],
            });
            // Rotation keeps one row per refresh (old ones just get marked
            // revoked), so the newest createdAt IS the last interaction.
            const lastUsedAt = refreshTokens
              .filter((row) => row.clientId === consent.clientId && row.referenceId === teamId)
              .map((row) => String(row.createdAt ?? ""))
              .sort()
              .at(-1);
            const domainIds = await getGrantDomains({
              clientId: consent.clientId,
              userId,
              teamId,
            });
            return {
              id: consent.id,
              clientId: consent.clientId,
              clientName: client?.name ?? null,
              scopes: consent.scopes ?? [],
              createdAt: consent.createdAt ? String(consent.createdAt) : null,
              lastUsedAt: lastUsedAt || null,
              domainIds: domainIds ?? null,
            };
          }),
      );
    },

    async revokeGrant(userId, teamId, consentId) {
      const db = await adapter();
      const consent = await db.findOne<ConsentRow>({
        model: "oauthConsent",
        where: [{ field: "id", value: consentId }],
      });
      if (!consent || consent.userId !== userId || consent.referenceId !== teamId) return false;

      // Refresh tokens have no userId GSI (hot path is by hashed token);
      // revocation is rare, so the in-memory filter over the model is fine.
      const refreshTokens = await db.findMany<RefreshRow>({
        model: "oauthRefreshToken",
        where: [{ field: "userId", value: userId }],
      });
      for (const token of refreshTokens) {
        if (token.clientId !== consent.clientId || token.referenceId !== teamId || token.revoked) {
          continue;
        }
        await db.update({
          model: "oauthRefreshToken",
          where: [{ field: "id", value: token.id }],
          update: { revoked: clock() },
        });
        await db.deleteMany({
          model: "oauthAccessToken",
          where: [{ field: "refreshId", value: token.id }],
        });
      }

      await db.deleteMany({
        model: GRANT_DOMAINS_MODEL,
        where: grantDomainsWhere({ clientId: consent.clientId, userId, teamId }),
      });
      await db.delete({ model: "oauthConsent", where: [{ field: "id", value: consentId }] });
      return true;
    },

    async setGrantDomains(key, domainIds) {
      const db = await adapter();
      await db.deleteMany({ model: GRANT_DOMAINS_MODEL, where: grantDomainsWhere(key) });
      if (domainIds && domainIds.length > 0) {
        await db.create({
          model: GRANT_DOMAINS_MODEL,
          data: {
            clientId: key.clientId,
            userId: key.userId,
            referenceId: key.teamId,
            domainIds,
            createdAt: clock(),
          },
        });
      }
    },

    getGrantDomains,
  };
}
