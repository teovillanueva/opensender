import type { ApiKeyEntity } from "../adapters/dynamo-entities.js";
import type { Clock, IdGenerator } from "../ports.js";
import { generateToken, hashesEqual, hashToken, looksLikeToken } from "./token.js";

export type ApiKeyPermission = "full_access" | "sending_access";

export interface ApiKey {
  keyId: string;
  teamId: string;
  name: string;
  permission: ApiKeyPermission;
  domainId?: string;
  lastUsedAt?: string;
  createdAt: string;
}

export interface VerifiedKey {
  keyId: string;
  teamId: string;
  permission: ApiKeyPermission;
  domainId?: string;
}

export interface ApiKeysServiceDeps {
  apiKeys: ApiKeyEntity;
  clock: Clock;
  idGenerator: IdGenerator;
}

export class ApiKeysService {
  constructor(private readonly deps: ApiKeysServiceDeps) {}

  /** The plaintext token appears exactly once: in this return value. */
  async createKey(input: {
    teamId: string;
    name: string;
    permission: ApiKeyPermission;
    domainId?: string;
  }): Promise<{ key: ApiKey; token: string }> {
    const { apiKeys, clock, idGenerator } = this.deps;
    const token = generateToken();
    const key: ApiKey = {
      keyId: idGenerator(),
      teamId: input.teamId,
      name: input.name,
      permission: input.permission,
      ...(input.domainId === undefined ? {} : { domainId: input.domainId }),
      createdAt: clock().toISOString(),
    };
    await apiKeys.create({ ...key, tokenHash: hashToken(token) }).go();
    return { key, token };
  }

  /**
   * Resolves a presented bearer token to its key, or undefined. Lookup is by
   * SHA-256 hash; the digest comparison is constant-time on top of it.
   * Updates lastUsedAt fire-and-forget — verification never waits on it.
   */
  async verifyToken(token: string): Promise<VerifiedKey | undefined> {
    if (!looksLikeToken(token)) return undefined;
    const presentedHash = hashToken(token);
    const result = await this.deps.apiKeys.query.byTokenHash({ tokenHash: presentedHash }).go();
    const record = result.data[0];
    if (!record || !hashesEqual(record.tokenHash, presentedHash)) return undefined;

    this.deps.apiKeys
      .patch({ keyId: record.keyId })
      .set({ lastUsedAt: this.deps.clock().toISOString() })
      .go()
      .catch(() => {
        // lastUsedAt is advisory; a failed touch must not fail the request.
      });

    return {
      keyId: record.keyId,
      teamId: record.teamId,
      permission: record.permission,
      ...(record.domainId === undefined ? {} : { domainId: record.domainId }),
    };
  }

  async listKeys(teamId: string): Promise<ApiKey[]> {
    const result = await this.deps.apiKeys.query.byTeam({ teamId }).go({ pages: "all" });
    return result.data
      .map(({ tokenHash: _tokenHash, ...key }) => key)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Deletes only when the key belongs to the team; returns whether it did. */
  async deleteKey(teamId: string, keyId: string): Promise<boolean> {
    const existing = await this.deps.apiKeys.get({ keyId }).go();
    if (!existing.data || existing.data.teamId !== teamId) return false;
    await this.deps.apiKeys.delete({ keyId }).go();
    return true;
  }
}
