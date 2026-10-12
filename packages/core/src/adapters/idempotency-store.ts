import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Clock } from "../ports.js";

/**
 * Idempotency records (SPEC §5.7): 24h retention via the table TTL, one
 * conditional write claims the key, and error responses release it — errors
 * never consume the key (fixtures 25-27).
 */

export interface StoredIdempotentResponse {
  status: number;
  body: string;
}

export type IdempotencyClaim =
  | { kind: "claimed" }
  | { kind: "in_flight" }
  | { kind: "replay"; response: StoredIdempotentResponse }
  | { kind: "mismatch" };

export interface IdempotencyStoreDeps {
  client: DynamoDBDocumentClient;
  table: string;
  clock: Clock;
}

const TTL_SECONDS = 24 * 60 * 60;

export class IdempotencyStore {
  constructor(private readonly deps: IdempotencyStoreDeps) {}

  private key(teamId: string, endpoint: string, idempotencyKey: string) {
    return { pk: `idem#${teamId}#${endpoint}#${idempotencyKey}`, sk: "idem" };
  }

  async claim(
    teamId: string,
    endpoint: string,
    idempotencyKey: string,
    bodyHash: string,
  ): Promise<IdempotencyClaim> {
    const { client, table, clock } = this.deps;
    const now = Math.floor(clock().getTime() / 1000);
    try {
      await client.send(
        new PutCommand({
          TableName: table,
          Item: {
            ...this.key(teamId, endpoint, idempotencyKey),
            bodyHash,
            state: "in_flight",
            _ttl: now + TTL_SECONDS,
          },
          ConditionExpression: "attribute_not_exists(pk) OR #ttl < :now",
          ExpressionAttributeNames: { "#ttl": "_ttl" },
          ExpressionAttributeValues: { ":now": now },
        }),
      );
      return { kind: "claimed" };
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
    }

    const existing = await client.send(
      new GetCommand({ TableName: table, Key: this.key(teamId, endpoint, idempotencyKey) }),
    );
    const item = existing.Item;
    if (!item) return { kind: "in_flight" };
    if (item.bodyHash !== bodyHash) return { kind: "mismatch" };
    if (item.state === "completed") {
      return {
        kind: "replay",
        response: { status: Number(item.responseStatus), body: String(item.responseBody) },
      };
    }
    return { kind: "in_flight" };
  }

  /** Success path: pin the byte-identical response for replays. */
  async complete(
    teamId: string,
    endpoint: string,
    idempotencyKey: string,
    response: StoredIdempotentResponse,
  ): Promise<void> {
    await this.deps.client.send(
      new UpdateCommand({
        TableName: this.deps.table,
        Key: this.key(teamId, endpoint, idempotencyKey),
        UpdateExpression: "SET #state = :completed, responseStatus = :status, responseBody = :body",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: {
          ":completed": "completed",
          ":status": response.status,
          ":body": response.body,
        },
      }),
    );
  }

  /** Error path: release the claim so a retry can succeed. */
  async release(teamId: string, endpoint: string, idempotencyKey: string): Promise<void> {
    await this.deps.client.send(
      new DeleteCommand({
        TableName: this.deps.table,
        Key: this.key(teamId, endpoint, idempotencyKey),
      }),
    );
  }
}
