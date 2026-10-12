import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Clock } from "../ports.js";

/**
 * Fixed-window limiter, 1-second windows, one atomic counter per team per
 * second (SPEC §5.2: 10 req/s per TEAM, shared across all its keys). ADD is
 * atomic in DynamoDB, so concurrent Lambdas can never double-admit; the item
 * self-expires via the table TTL.
 */

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window resets — always 1 with w=1. */
  resetSeconds: number;
}

export interface RateLimiterDeps {
  client: DynamoDBDocumentClient;
  table: string;
  clock: Clock;
}

export class RateLimiter {
  constructor(private readonly deps: RateLimiterDeps) {}

  async consume(teamId: string, limit: number): Promise<RateLimitDecision> {
    const { client, table, clock } = this.deps;
    const epochSecond = Math.floor(clock().getTime() / 1000);
    const result = await client.send(
      new UpdateCommand({
        TableName: table,
        Key: { pk: `ratelimit#${teamId}`, sk: String(epochSecond) },
        UpdateExpression: "ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)",
        ExpressionAttributeNames: { "#count": "count", "#ttl": "_ttl" },
        ExpressionAttributeValues: { ":one": 1, ":ttl": epochSecond + 120 },
        ReturnValues: "ALL_NEW",
      }),
    );
    const count = Number(result.Attributes?.count ?? 1);
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetSeconds: 1,
    };
  }
}
