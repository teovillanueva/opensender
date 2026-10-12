import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Entity } from "electrodb";

/**
 * Single-table layout (SPEC §4). ElectroDB owns key construction; DynamoDB
 * syntax never leaves this directory. Index budget:
 *   primary  — entity CRUD by id (or by token hash for ApiKey lookups)
 *   gsi1     — team-scoped listings + better-auth model partitions
 *   gsi2/3   — better-auth field lookups (written by the auth adapter, raw)
 */

export interface TableConfig {
  client: DynamoDBDocumentClient;
  table: string;
}

export function createTeamEntity({ client, table }: TableConfig) {
  return new Entity(
    {
      model: { entity: "team", version: "1", service: "opensender" },
      attributes: {
        teamId: { type: "string", required: true },
        name: { type: "string", required: true },
        sesTenantName: { type: "string", required: true },
        // Quotas resolve from the plan via instance config at read time —
        // one source of truth, no stale denormalized numbers (SPEC §4).
        plan: { type: "string", required: true },
        status: { type: ["active", "frozen"] as const, required: true },
        createdAt: { type: "string", required: true },
      },
      indexes: {
        byId: {
          pk: { field: "pk", composite: ["teamId"] },
          sk: { field: "sk", composite: [] },
        },
      },
    },
    { client, table },
  );
}

export function createApiKeyEntity({ client, table }: TableConfig) {
  return new Entity(
    {
      model: { entity: "apiKey", version: "1", service: "opensender" },
      attributes: {
        keyId: { type: "string", required: true },
        teamId: { type: "string", required: true },
        name: { type: "string", required: true },
        permission: { type: ["full_access", "sending_access"] as const, required: true },
        domainId: { type: "string" },
        tokenHash: { type: "string", required: true },
        lastUsedAt: { type: "string" },
        createdAt: { type: "string", required: true },
      },
      indexes: {
        byId: {
          pk: { field: "pk", composite: ["keyId"] },
          sk: { field: "sk", composite: [] },
        },
        byTeam: {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["teamId"] },
          sk: { field: "gsi1sk", composite: ["createdAt", "keyId"] },
        },
        byTokenHash: {
          index: "gsi2",
          pk: { field: "gsi2pk", composite: ["tokenHash"] },
          sk: { field: "gsi2sk", composite: [] },
        },
      },
    },
    { client, table },
  );
}

export function createDomainEntity({ client, table }: TableConfig) {
  return new Entity(
    {
      model: { entity: "domain", version: "1", service: "opensender" },
      attributes: {
        domainId: { type: "string", required: true },
        teamId: { type: "string", required: true },
        name: { type: "string", required: true },
        region: { type: "string", required: true },
        status: {
          type: ["not_started", "pending", "verified", "failed", "temporary_failure"] as const,
          required: true,
        },
        clickTracking: { type: "boolean", required: true },
        openTracking: { type: "boolean", required: true },
        tls: { type: ["opportunistic", "enforced"] as const, required: true },
        inboundEnabled: { type: "boolean", required: true },
        dkimTokens: { type: "list", items: { type: "string" }, required: true },
        signingHostedZone: { type: "string", required: true },
        configurationSetName: { type: "string", required: true },
        dkimStatus: { type: "string", required: true },
        mailFromStatus: { type: "string", required: true },
        // DNS-observed receiving MX state; absent on pre-existing rows.
        inboundMxStatus: { type: "string", required: false },
        createdAt: { type: "string", required: true },
      },
      indexes: {
        byId: {
          pk: { field: "pk", composite: ["domainId"] },
          sk: { field: "sk", composite: [] },
        },
        byTeam: {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["teamId"] },
          sk: { field: "gsi1sk", composite: ["createdAt", "domainId"] },
        },
        byName: {
          index: "gsi2",
          pk: { field: "gsi2pk", composite: ["name"] },
          sk: { field: "gsi2sk", composite: [] },
        },
        byStatus: {
          index: "gsi3",
          pk: { field: "gsi3pk", composite: ["status"] },
          sk: { field: "gsi3sk", composite: ["domainId"] },
        },
      },
    },
    { client, table },
  );
}

export function createEmailEntity({ client, table }: TableConfig) {
  return new Entity(
    {
      model: { entity: "email", version: "1", service: "opensender" },
      attributes: {
        emailId: { type: "string", required: true },
        teamId: { type: "string", required: true },
        direction: { type: ["outbound", "inbound"] as const, required: true },
        from: { type: "string", required: true },
        to: { type: "list", items: { type: "string" }, required: true },
        cc: { type: "list", items: { type: "string" } },
        bcc: { type: "list", items: { type: "string" } },
        replyTo: { type: "list", items: { type: "string" } },
        subject: { type: "string", required: true },
        // Inline when small; blob key when the pair would threaten the
        // 400 KB item cap (SPEC §4: inline if <200 KB).
        html: { type: "string" },
        text: { type: "string" },
        htmlBlobKey: { type: "string" },
        textBlobKey: { type: "string" },
        headers: { type: "any" },
        tags: { type: "any" },
        attachments: { type: "any" },
        status: {
          type: [
            "queued",
            "scheduled",
            "sent",
            "delivered",
            "delivery_delayed",
            "bounced",
            "complained",
            "failed",
            "canceled",
            "received",
          ] as const,
          required: true,
        },
        scheduledAt: { type: "string" },
        scheduleArn: { type: "string" },
        sesMessageId: { type: "string" },
        messageId: { type: "string" },
        // Set on broadcast sends; delivery events attribute stats to it (§11).
        broadcastId: { type: "string" },
        // The API key that sent it; absent on session sends and inbound.
        apiKeyId: { type: "string" },
        createdAt: { type: "string", required: true },
        lastEventAt: { type: "string" },
      },
      indexes: {
        byId: {
          pk: { field: "pk", composite: ["emailId"] },
          sk: { field: "sk", composite: [] },
        },
        byTeam: {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["teamId"] },
          sk: { field: "gsi1sk", composite: ["createdAt", "emailId"] },
        },
        bySesMessageId: {
          index: "gsi2",
          pk: { field: "gsi2pk", composite: ["sesMessageId"] },
          sk: { field: "gsi2sk", composite: [] },
        },
      },
    },
    { client, table },
  );
}

export function createEmailEventEntity({ client, table }: TableConfig) {
  return new Entity(
    {
      model: { entity: "emailEvent", version: "1", service: "opensender" },
      attributes: {
        emailId: { type: "string", required: true },
        eventId: { type: "string", required: true },
        type: { type: "string", required: true },
        occurredAt: { type: "string", required: true },
        payload: { type: "any" },
      },
      indexes: {
        byEmail: {
          // sk is the eventId alone: deterministic ids from the processor
          // must collide on redelivery regardless of processing time.
          pk: { field: "pk", composite: ["emailId"] },
          sk: { field: "sk", composite: ["eventId"] },
        },
      },
    },
    { client, table },
  );
}

export function createSuppressionEntity({ client, table }: TableConfig) {
  return new Entity(
    {
      model: { entity: "suppression", version: "1", service: "opensender" },
      attributes: {
        teamId: { type: "string", required: true },
        email: { type: "string", required: true },
        reason: { type: ["hard_bounce", "complaint", "manual"] as const, required: true },
        sourceEmailId: { type: "string" },
        createdAt: { type: "string", required: true },
      },
      indexes: {
        byTeamEmail: {
          pk: { field: "pk", composite: ["teamId", "email"] },
          sk: { field: "sk", composite: [] },
        },
        byTeam: {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["teamId"] },
          sk: { field: "gsi1sk", composite: ["createdAt", "email"] },
        },
      },
    },
    { client, table },
  );
}

export function createWebhookEndpointEntity({ client, table }: TableConfig) {
  return new Entity(
    {
      model: { entity: "webhookEndpoint", version: "1", service: "opensender" },
      attributes: {
        endpointId: { type: "string", required: true },
        teamId: { type: "string", required: true },
        endpoint: { type: "string", required: true },
        events: { type: "list", items: { type: "string" }, required: true },
        signingSecret: { type: "string", required: true },
        status: { type: ["enabled", "disabled"] as const, required: true },
        consecutiveFailures: { type: "number", required: true, default: 0 },
        createdAt: { type: "string", required: true },
      },
      indexes: {
        byId: {
          pk: { field: "pk", composite: ["endpointId"] },
          sk: { field: "sk", composite: [] },
        },
        byTeam: {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["teamId"] },
          sk: { field: "gsi1sk", composite: ["createdAt", "endpointId"] },
        },
      },
    },
    { client, table },
  );
}

export function createWebhookDeliveryEntity({ client, table }: TableConfig) {
  return new Entity(
    {
      model: { entity: "webhookDelivery", version: "1", service: "opensender" },
      attributes: {
        endpointId: { type: "string", required: true },
        deliveryId: { type: "string", required: true },
        svixId: { type: "string", required: true },
        type: { type: "string", required: true },
        attempt: { type: "number", required: true },
        statusCode: { type: "number" },
        durationMs: { type: "number" },
        outcome: { type: ["success", "failure"] as const, required: true },
        error: { type: "string" },
        payload: { type: "string", required: true },
        createdAt: { type: "string", required: true },
        _ttl: { type: "number", required: true, hidden: true },
      },
      indexes: {
        byEndpoint: {
          pk: { field: "pk", composite: ["endpointId"] },
          sk: { field: "sk", composite: ["createdAt", "deliveryId"] },
        },
      },
    },
    { client, table },
  );
}

export function createSegmentEntity({ client, table }: TableConfig) {
  return new Entity(
    {
      model: { entity: "segment", version: "1", service: "opensender" },
      attributes: {
        segmentId: { type: "string", required: true },
        teamId: { type: "string", required: true },
        name: { type: "string", required: true },
        createdAt: { type: "string", required: true },
      },
      indexes: {
        byId: {
          pk: { field: "pk", composite: ["segmentId"] },
          sk: { field: "sk", composite: [] },
        },
        byTeam: {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["teamId"] },
          sk: { field: "gsi1sk", composite: ["createdAt", "segmentId"] },
        },
      },
    },
    { client, table },
  );
}

export function createContactEntity({ client, table }: TableConfig) {
  return new Entity(
    {
      model: { entity: "contact", version: "1", service: "opensender" },
      attributes: {
        contactId: { type: "string", required: true },
        teamId: { type: "string", required: true },
        segmentId: { type: "string", required: true },
        email: { type: "string", required: true },
        firstName: { type: "string" },
        lastName: { type: "string" },
        unsubscribed: { type: "boolean", required: true, default: false },
        createdAt: { type: "string", required: true },
      },
      indexes: {
        byId: {
          pk: { field: "pk", composite: ["contactId"] },
          sk: { field: "sk", composite: [] },
        },
        bySegment: {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["segmentId"] },
          sk: { field: "gsi1sk", composite: ["createdAt", "contactId"] },
        },
        // Unique per (segment, email): the by-email lookup that also backs
        // contact GET/PATCH/DELETE when the path segment is an address.
        bySegmentEmail: {
          index: "gsi2",
          pk: { field: "gsi2pk", composite: ["segmentId"] },
          sk: { field: "gsi2sk", composite: ["email"] },
        },
      },
    },
    { client, table },
  );
}

export function createBroadcastEntity({ client, table }: TableConfig) {
  return new Entity(
    {
      model: { entity: "broadcast", version: "1", service: "opensender" },
      attributes: {
        broadcastId: { type: "string", required: true },
        teamId: { type: "string", required: true },
        segmentId: { type: "string", required: true },
        from: { type: "string", required: true },
        subject: { type: "string", required: true },
        replyTo: { type: "string" },
        name: { type: "string" },
        // Broadcast templates are small — stored inline, never in S3 (SPEC §11).
        html: { type: "string" },
        text: { type: "string" },
        status: {
          type: ["draft", "scheduled", "sending", "sent", "canceled"] as const,
          required: true,
        },
        scheduledAt: { type: "string" },
        scheduleArn: { type: "string" },
        // Outstanding fan-out pages; the page that decrements this to <=0 flips
        // the broadcast to `sent` (SPEC §11). Set when fan-out starts.
        pendingPages: { type: "number" },
        // Aggregate counters incremented by the event processor as SES events
        // land; a fixed key set keeps atomic ADDs on nested paths well-defined.
        stats: {
          type: "map",
          properties: {
            sent: { type: "number", required: true, default: 0 },
            delivered: { type: "number", required: true, default: 0 },
            delivery_delayed: { type: "number", required: true, default: 0 },
            bounced: { type: "number", required: true, default: 0 },
            complained: { type: "number", required: true, default: 0 },
            failed: { type: "number", required: true, default: 0 },
            opened: { type: "number", required: true, default: 0 },
            clicked: { type: "number", required: true, default: 0 },
            unsubscribed: { type: "number", required: true, default: 0 },
          },
        },
        createdAt: { type: "string", required: true },
      },
      indexes: {
        byId: {
          pk: { field: "pk", composite: ["broadcastId"] },
          sk: { field: "sk", composite: [] },
        },
        byTeam: {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["teamId"] },
          sk: { field: "gsi1sk", composite: ["createdAt", "broadcastId"] },
        },
      },
    },
    { client, table },
  );
}

export type TeamEntity = ReturnType<typeof createTeamEntity>;
export type ApiKeyEntity = ReturnType<typeof createApiKeyEntity>;
export type DomainEntity = ReturnType<typeof createDomainEntity>;
export type EmailEntity = ReturnType<typeof createEmailEntity>;
export type EmailEventEntity = ReturnType<typeof createEmailEventEntity>;
export type SuppressionEntity = ReturnType<typeof createSuppressionEntity>;
export type WebhookEndpointEntity = ReturnType<typeof createWebhookEndpointEntity>;
export type WebhookDeliveryEntity = ReturnType<typeof createWebhookDeliveryEntity>;
export type SegmentEntity = ReturnType<typeof createSegmentEntity>;
export type ContactEntity = ReturnType<typeof createContactEntity>;
export type BroadcastEntity = ReturnType<typeof createBroadcastEntity>;
