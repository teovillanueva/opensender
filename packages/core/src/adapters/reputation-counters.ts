import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Clock } from "../ports.js";

/**
 * Per-team reputation counters (SPEC §12): recipients sent to, hard-bounced
 * and complained, in a daily tumbling window. The window is the UTC day — a bounded, atomic bucket
 * that expires by TTL, so no sliding-window bookkeeping is needed. The
 * ReputationService reads the current day's bucket to compute rolling rates and
 * auto-freeze a team whose bounce/complaint ratio breaches the configured
 * thresholds. Same atomic-ADD shape as the quota counters.
 */

export interface ReputationWindow {
  sends: number;
  bounces: number;
  complaints: number;
}

type ReputationField = keyof ReputationWindow;

/** Bounce/complaint counters outlive the send-quota TTL a little so a late
 * event still lands in the day it belongs to. */
const WINDOW_TTL_SECONDS = 3 * 86_400;

export class ReputationCounters {
  constructor(
    private readonly deps: { client: DynamoDBDocumentClient; table: string; clock: Clock },
  ) {}

  private key(teamId: string): { pk: string; sk: string } {
    const day = this.deps.clock().toISOString().slice(0, 10);
    return { pk: `reputation#${teamId}#${day}`, sk: "reputation" };
  }

  private async add(teamId: string, field: ReputationField, count: number): Promise<void> {
    const epoch = Math.floor(this.deps.clock().getTime() / 1000);
    await this.deps.client.send(
      new UpdateCommand({
        TableName: this.deps.table,
        Key: this.key(teamId),
        UpdateExpression: "ADD #f :c SET #ttl = if_not_exists(#ttl, :ttl)",
        ExpressionAttributeNames: { "#f": field, "#ttl": "_ttl" },
        ExpressionAttributeValues: { ":c": count, ":ttl": epoch + WINDOW_TTL_SECONDS },
      }),
    );
  }

  recordSends(teamId: string, recipients: number): Promise<void> {
    return this.add(teamId, "sends", recipients);
  }

  recordBounce(teamId: string, recipients = 1): Promise<void> {
    return this.add(teamId, "bounces", recipients);
  }

  recordComplaint(teamId: string, recipients = 1): Promise<void> {
    return this.add(teamId, "complaints", recipients);
  }

  async current(teamId: string): Promise<ReputationWindow> {
    const result = await this.deps.client.send(
      new GetCommand({ TableName: this.deps.table, Key: this.key(teamId) }),
    );
    const item = result.Item ?? {};
    return {
      sends: Number(item.sends ?? 0),
      bounces: Number(item.bounces ?? 0),
      complaints: Number(item.complaints ?? 0),
    };
  }
}
