export {
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
} from "./adapters/dynamo-entities.js";
export { EventBridgeScheduler } from "./adapters/eventbridge-scheduler.js";
export type { IdempotencyClaim } from "./adapters/idempotency-store.js";
export { IdempotencyStore } from "./adapters/idempotency-store.js";
export type { QuotaUsage } from "./adapters/quota-counters.js";
export { QuotaCounters } from "./adapters/quota-counters.js";
export type { RateLimitDecision } from "./adapters/rate-limiter.js";
export { RateLimiter } from "./adapters/rate-limiter.js";
export type { ReputationWindow } from "./adapters/reputation-counters.js";
export { ReputationCounters } from "./adapters/reputation-counters.js";
export { S3BlobStore } from "./adapters/s3-blob-store.js";
export { SesEmailProvider } from "./adapters/ses.js";
export { SnsAlertPublisher } from "./adapters/sns-alert-publisher.js";
export { SqsQueuePublisher } from "./adapters/sqs-queue.js";
export type { ApiKey, ApiKeyPermission, VerifiedKey } from "./api-keys/api-keys.js";
export { ApiKeysService } from "./api-keys/api-keys.js";
export type { Auth } from "./auth/auth.js";
export { createAuth } from "./auth/auth.js";
export {
  BootstrapService,
  BootstrapTokenMismatchError,
  BootstrapUnavailableError,
} from "./auth/bootstrap.js";
export type { GrantKey, OAuthGrant, OAuthGrantsPort } from "./auth/oauth-grants.js";
export { createOAuthGrants } from "./auth/oauth-grants.js";
export type { KeyPermission, OAuthScope } from "./auth/oauth-scopes.js";
export { OAUTH_SCOPES, permissionForScopes } from "./auth/oauth-scopes.js";
export type { OAuthPrincipal, OAuthTokenVerifier } from "./auth/oauth-verifier.js";
export { createOAuthTokenVerifier } from "./auth/oauth-verifier.js";
export type { Broadcast, BroadcastStatKey, BroadcastStatus } from "./broadcasts/broadcasts.js";
export { BroadcastsService } from "./broadcasts/broadcasts.js";
export type { MergeContext } from "./broadcasts/merge-tags.js";
export { renderMergeTags } from "./broadcasts/merge-tags.js";
export type { UnsubscribeTokenPayload } from "./broadcasts/unsubscribe-token.js";
export {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "./broadcasts/unsubscribe-token.js";
export type { Contact } from "./contacts/contacts.js";
export { ContactsService } from "./contacts/contacts.js";
export type { Domain, DomainStatus } from "./domains/domains.js";
export {
  DomainAlreadyExistsError,
  DomainsService,
  UnsupportedRegionError,
} from "./domains/domains.js";
export type { DomainRecord } from "./domains/records.js";
export { buildDomainRecords, domainStatus, toWireStatus } from "./domains/records.js";
export type {
  MetricsSummary,
  StoredAttachmentMeta,
  StoredEmail,
  StoredSuppression,
} from "./emails/emails.js";
export {
  EmailsService,
  outboundEmailEventData,
  SendRejectedError,
  SuppressionExistsError,
} from "./emails/emails.js";
export { parseScheduledAt } from "./emails/scheduled-at.js";
export type { EmailStatus } from "./emails/state-machine.js";
export { transition } from "./emails/state-machine.js";
export type { SendRequest } from "./emails/validate.js";
export { SendValidationError, validateSendRequest } from "./emails/validate.js";
export { deriveTextFromHtml, toWireEmail } from "./emails/wire.js";
export type { DomainEvent } from "./events/emitter.js";
export { EventsService } from "./events/emitter.js";
export { EventProcessorService } from "./events/processor.js";
export type { SesEventDetail } from "./events/ses-mapping.js";
export { mapSesEvent } from "./events/ses-mapping.js";
export { SafeFetchError, safeFetch } from "./http/safe-fetch.js";
export { InboundService } from "./inbound/inbound.js";
export type {
  AlertPublisher,
  BlobStore,
  Clock,
  EmailProvider,
  IdGenerator,
  QueuePublisher,
  SchedulerPort,
  TenantInfo,
} from "./ports.js";
export type { GuardrailsConfig } from "./reputation/reputation.js";
export { ReputationService } from "./reputation/reputation.js";
export type { Segment } from "./segments/segments.js";
export { SegmentsService } from "./segments/segments.js";
// Service ports: the public method surface of each service, usable
// structurally (fakes in api tests) without the classes' private state.
export type {
  ApiKeysPort,
  BootstrapPort,
  BroadcastsPort,
  ContactsPort,
  DomainsPort,
  EmailsPort,
  RateLimiterPort,
  SegmentsPort,
  TeamsPort,
  WebhooksPort,
} from "./service-ports.js";
export type { PlanConfig, Team, TeamsConfig } from "./teams/teams.js";
export { TeamsService, tenantNameForTeam } from "./teams/teams.js";
export type { ParsedTenantStatusEvent } from "./teams/tenant-status.js";
export { parseTenantStatusEvent } from "./teams/tenant-status.js";
export type { DeliveryMessage, DispatchOutcome } from "./webhooks/dispatcher.js";
export { RETRY_DELAY_SECONDS, WebhookDispatchService } from "./webhooks/dispatcher.js";
export { generateSigningSecret, signWebhookPayload } from "./webhooks/signing.js";
export type { WebhookEndpoint } from "./webhooks/webhooks.js";
export { WebhooksService } from "./webhooks/webhooks.js";
export { toWireTimestamp } from "./wire.js";
