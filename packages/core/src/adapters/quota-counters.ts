import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Clock } from "../ports.js";

/**
 * Ascending per-team send counters (SPEC §5.2): daily and monthly usage,
 * surfaced as x-resend-daily-quota / x-resend-monthly-quota on POST /emails*
 * responses. Atomic ADD; daily items expire via TTL after 3 days, monthly
 * after 40.
 */

export interface QuotaUsage {
  daily: number;
  monthly: number;
}

export class QuotaCounters {
  constructor(
    private readonly deps: { client: DynamoDBDocumentClient; table: string; clock: Clock },
  ) {}

  private periods() {
    const now = this.deps.clock();
    const iso = now.toISOString();
    return {
      day: iso.slice(0, 10),
      month: iso.slice(0, 7),
      epoch: Math.floor(now.getTime() / 1000),
    };
  }

  private async add(pk: string, count: number, ttlSeconds: number, epoch: number): Promise<number> {
    const result = await this.deps.client.send(
      new UpdateCommand({
        TableName: this.deps.table,
        Key: { pk, sk: "quota" },
        UpdateExpression: "ADD #count :count SET #ttl = if_not_exists(#ttl, :ttl)",
        ExpressionAttributeNames: { "#count": "count", "#ttl": "_ttl" },
        ExpressionAttributeValues: { ":count": count, ":ttl": epoch + ttlSeconds },
        ReturnValues: "ALL_NEW",
      }),
    );
    return Number(result.Attributes?.count ?? count);
  }

  /** Increment both counters by `count` accepted sends; returns new usage. */
  async record(teamId: string, count: number): Promise<QuotaUsage> {
    const { day, month, epoch } = this.periods();
    const [daily, monthly] = await Promise.all([
      this.add(`quota#${teamId}#d#${day}`, count, 3 * 86_400, epoch),
      this.add(`quota#${teamId}#m#${month}`, count, 40 * 86_400, epoch),
    ]);
    return { daily, monthly };
  }

  private async get(pk: string): Promise<number> {
    const result = await this.deps.client.send(
      new GetCommand({
        TableName: this.deps.table,
        Key: { pk, sk: "quota" },
      }),
    );
    return Number(result.Item?.count ?? 0);
  }

  /** Current usage without incrementing (error responses still show it). */
  async current(teamId: string): Promise<QuotaUsage> {
    const { day, month } = this.periods();
    const [daily, monthly] = await Promise.all([
      this.get(`quota#${teamId}#d#${day}`),
      this.get(`quota#${teamId}#m#${month}`),
    ]);
    return { daily, monthly };
  }
}
