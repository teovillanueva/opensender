import { resolveMx } from "node:dns/promises";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SchedulerClient } from "@aws-sdk/client-scheduler";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { SNSClient } from "@aws-sdk/client-sns";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  ApiKeysService,
  BroadcastsService,
  type Contact,
  ContactsService,
  createApiKeyEntity,
  createBroadcastEntity,
  createContactEntity,
  createDomainEntity,
  createEmailEntity,
  createEmailEventEntity,
  createSegmentEntity,
  createSuppressionEntity,
  createTeamEntity,
  createWebhookDeliveryEntity,
  createWebhookEndpointEntity,
  DomainsService,
  EmailsService,
  EventBridgeScheduler,
  EventsService,
  IdempotencyStore,
  QuotaCounters,
  RateLimiter,
  ReputationCounters,
  ReputationService,
  S3BlobStore,
  SegmentsService,
  SesEmailProvider,
  SnsAlertPublisher,
  SqsQueuePublisher,
  TeamsService,
  WebhooksService,
} from "@opensender/core";
import { Resource } from "sst";
import { instanceConfig } from "../../../instance.config.js";
import { recordMetric } from "./observability.js";

/**
 * Shared composition pieces (SPEC §2.1): each Lambda's entry file builds its
 * context from these, memoized at module scope across warm starts.
 */

export const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
export const table = Resource.Table.name;
export const clock = () => new Date();

export function createEmailProvider(): SesEmailProvider {
  return new SesEmailProvider(new SESv2Client({}), {
    region: instanceConfig.region,
    accountId: process.env.AWS_ACCOUNT_ID ?? "",
  });
}

export function createTeamsService(provider = createEmailProvider()): TeamsService {
  return new TeamsService({
    teams: createTeamEntity({ client: dynamo, table }),
    emailProvider: provider,
    config: { plans: instanceConfig.plans, defaultPlan: instanceConfig.defaultPlan },
    clock,
  });
}

export function createDomainsService(
  provider = createEmailProvider(),
  teams = createTeamsService(provider),
): DomainsService {
  return new DomainsService({
    domains: createDomainEntity({ client: dynamo, table }),
    emitter: createEventsService(),
    emailProvider: provider,
    teams,
    region: instanceConfig.region,
    // Observes the receiving MX (SES never reports it; SPEC §9).
    dns: {
      resolveMx: async (hostname) => (await resolveMx(hostname)).map((mx) => mx.exchange),
    },
    clock,
    idGenerator: () => crypto.randomUUID(),
  });
}

export function createApiKeysService(): ApiKeysService {
  return new ApiKeysService({
    apiKeys: createApiKeyEntity({ client: dynamo, table }),
    clock,
    idGenerator: () => crypto.randomUUID(),
  });
}

export function createRateLimiter(): RateLimiter {
  return new RateLimiter({ client: dynamo, table, clock });
}

export function createWebhooksService(): WebhooksService {
  return new WebhooksService({
    endpoints: createWebhookEndpointEntity({ client: dynamo, table }),
    // Delivery-log reads (dashboard §13.6); the dispatcher writes them.
    deliveries: createWebhookDeliveryEntity({ client: dynamo, table }),
    clock,
    idGenerator: () => crypto.randomUUID(),
  });
}

/** Re-enqueues a stored webhook delivery for replay (dashboard §13.6). */
export function createWebhookReplayPublisher(): SqsQueuePublisher {
  return new SqsQueuePublisher(new SQSClient({}), Resource.WebhookDeliveries.url);
}

export function createEventsService(): EventsService {
  return new EventsService({
    events: createEmailEventEntity({ client: dynamo, table }),
    webhooks: createWebhooksService(),
    deliveries: new SqsQueuePublisher(new SQSClient({}), Resource.WebhookDeliveries.url),
    clock,
    idGenerator: () => crypto.randomUUID(),
  });
}

export function createQuotaCounters(): QuotaCounters {
  return new QuotaCounters({ client: dynamo, table, clock });
}

export function createReputationCounters(): ReputationCounters {
  return new ReputationCounters({ client: dynamo, table, clock });
}

/**
 * `recordSends` port for EmailsService that both feeds the reputation window
 * and emits the `sends` EMF metric (SPEC §15). EmailsService calls this on
 * every accepted send, so wrapping it here counts sends uniformly across the
 * API, broadcast-fanout, and scheduled-sender Lambdas without a core dependency
 * on Powertools.
 */
function createSendsRecorder(): {
  recordSends(teamId: string, recipients: number): Promise<void>;
} {
  const counters = createReputationCounters();
  return {
    // One call per accepted email: the metric counts emails, the reputation
    // window counts recipients (the unit SES rates are computed in).
    async recordSends(teamId: string, recipients: number): Promise<void> {
      recordMetric("sends", 1);
      await counters.recordSends(teamId, recipients);
    },
  };
}

/**
 * Operator alert channel (SPEC §15). Lazy: `Resource.OpsAlerts` throws unless
 * the importing function is linked to the topic, and this context module is
 * imported by every Lambda — only the event-processor and tenant-status
 * functions publish alerts, so only those link OpsAlerts.
 */
export function createAlertPublisher(): SnsAlertPublisher {
  return new SnsAlertPublisher(new SNSClient({}), Resource.OpsAlerts.arn);
}

/** Reputation guardrails (SPEC §12): auto-freeze on bounce/complaint spikes. */
export function createReputationService(): ReputationService {
  return new ReputationService({
    counters: createReputationCounters(),
    teams: createTeamsService(),
    alerts: createAlertPublisher(),
    config: instanceConfig.guardrails,
  });
}

export function createIdempotencyStore(): IdempotencyStore {
  return new IdempotencyStore({ client: dynamo, table, clock });
}

/** Raw inbound MIME lives in the InboundBucket (SES writes it there). */
export function createInboundBlobStore(): S3BlobStore {
  return new S3BlobStore(new S3Client({}), Resource.InboundBucket.name);
}

/**
 * All attachment bodies — outbound and inbound alike — live in the
 * AttachmentsBucket, the single bucket `attachmentDownloadUrl` presigns from.
 */
export function createAttachmentsBlobStore(): S3BlobStore {
  return new S3BlobStore(new S3Client({}), Resource.AttachmentsBucket.name);
}

export function createScheduler(): EventBridgeScheduler {
  return new EventBridgeScheduler(new SchedulerClient({}), {
    groupName: process.env.SCHEDULE_GROUP_NAME ?? "",
    targetArn: process.env.SCHEDULED_SENDER_ARN ?? "",
    roleArn: process.env.SCHEDULER_ROLE_ARN ?? "",
  });
}

export function createEmailsService(
  provider = createEmailProvider(),
  teams = createTeamsService(provider),
  domains = createDomainsService(provider, teams),
): EmailsService {
  return new EmailsService({
    emails: createEmailEntity({ client: dynamo, table }),
    // Read side for the dashboard email-detail timeline (SPEC §13.3).
    events: createEmailEventEntity({ client: dynamo, table }),
    emitter: createEventsService(),
    suppressions: createSuppressionEntity({ client: dynamo, table }),
    quotas: createQuotaCounters(),
    // Feed the reputation window and emit the `sends` metric; the counters need
    // no SNS link (recordSends only), so this stays available to the Api and
    // send Lambdas.
    reputation: createSendsRecorder(),
    blobs: createAttachmentsBlobStore(),
    emailProvider: provider,
    teams,
    domains,
    scheduler: createScheduler(),
    clock,
    idGenerator: () => crypto.randomUUID(),
  });
}

// --- Marketing surface (SPEC §11): segments, contacts, broadcasts ---

export function createSegmentsService(): SegmentsService {
  return new SegmentsService({
    segments: createSegmentEntity({ client: dynamo, table }),
    emitter: createEventsService(),
    clock,
    idGenerator: () => crypto.randomUUID(),
  });
}

export function createContactsService(): ContactsService {
  return new ContactsService({
    contacts: createContactEntity({ client: dynamo, table }),
    emitter: createEventsService(),
    clock,
    idGenerator: () => crypto.randomUUID(),
  });
}

export function createBroadcastsService(): BroadcastsService {
  return new BroadcastsService({
    broadcasts: createBroadcastEntity({ client: dynamo, table }),
    emitter: createEventsService(),
    clock,
    idGenerator: () => crypto.randomUUID(),
  });
}

/**
 * HMAC secret backing signed one-click unsubscribe tokens (SPEC §11.2). Lazy:
 * `Resource.UnsubscribeSecret` throws unless the *importing* function is linked
 * to it, so this must never be read at module scope — only the Api and
 * broadcast-fanout functions are linked, and every other Lambda imports this
 * module too.
 */
export function getUnsubscribeSecret(): string {
  return Resource.UnsubscribeSecret.value;
}
/** Public API origin — the base for per-recipient unsubscribe URLs. */
export const apiBaseUrl = process.env.API_BASE_URL ?? "";

/** Publisher for the broadcast fan-out queue (start + page messages). */
export function createBroadcastFanoutPublisher(): SqsQueuePublisher {
  return new SqsQueuePublisher(new SQSClient({}), Resource.BroadcastFanout.url);
}

/**
 * One-time scheduler for deferred broadcasts. Unlike the email scheduler, the
 * target is the fan-out SQS queue itself (universal target): at fire time
 * EventBridge Scheduler delivers the `start` message body straight to the
 * queue, so the deferred path reuses the same consumer as send-now.
 */
function createBroadcastScheduler(): EventBridgeScheduler {
  return new EventBridgeScheduler(new SchedulerClient({}), {
    groupName: process.env.SCHEDULE_GROUP_NAME ?? "",
    targetArn: process.env.BROADCAST_FANOUT_QUEUE_ARN ?? "",
    roleArn: process.env.BROADCAST_SCHEDULER_ROLE_ARN ?? "",
  });
}

/**
 * `broadcastSender` port (implemented for the API layer): send-now enqueues a
 * `start` message immediately; a deferred send registers a one-time schedule
 * that publishes the same `start` message when it fires.
 */
export function createBroadcastSender(): {
  send(broadcastId: string, teamId: string, scheduledAt?: string): Promise<void>;
} {
  const publisher = createBroadcastFanoutPublisher();
  const scheduler = createBroadcastScheduler();
  return {
    async send(broadcastId: string, teamId: string, scheduledAt?: string): Promise<void> {
      const message = { kind: "start", broadcastId, teamId };
      if (scheduledAt === undefined) {
        await publisher.enqueue(message);
        return;
      }
      await scheduler.createSchedule(`broadcast-${broadcastId}`, new Date(scheduledAt), message);
    },
  };
}

/**
 * `unsubscribeContacts` port for the PUBLIC unsubscribe flow: the signed token
 * carries no team, so the read is team-agnostic (primary-key get), unlike the
 * authed `ContactsPort.getByIdOrEmail`.
 */
export function createUnsubscribeContacts(): {
  getById(contactId: string): Promise<Contact | undefined>;
  setUnsubscribed(contact: Contact, unsubscribed: boolean): Promise<Contact>;
} {
  const entity = createContactEntity({ client: dynamo, table });
  const contacts = createContactsService();
  return {
    async getById(contactId: string): Promise<Contact | undefined> {
      const result = await entity.get({ contactId }).go();
      return (result.data ?? undefined) as Contact | undefined;
    },
    setUnsubscribed(contact: Contact, unsubscribed: boolean): Promise<Contact> {
      return contacts.setUnsubscribed(contact, unsubscribed);
    },
  };
}
