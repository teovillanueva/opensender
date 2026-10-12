import type { RateLimiter } from "./adapters/rate-limiter.js";
import type { ApiKeysService } from "./api-keys/api-keys.js";
import type { BootstrapService } from "./auth/bootstrap.js";
import type { BroadcastsService } from "./broadcasts/broadcasts.js";
import type { ContactsService } from "./contacts/contacts.js";
import type { DomainsService } from "./domains/domains.js";
import type { EmailsService } from "./emails/emails.js";
import type { SegmentsService } from "./segments/segments.js";
import type { TeamsService } from "./teams/teams.js";
import type { WebhooksService } from "./webhooks/webhooks.js";

export type ApiKeysPort = Pick<
  ApiKeysService,
  "createKey" | "verifyToken" | "listKeys" | "deleteKey"
>;
export type TeamsPort = Pick<TeamsService, "createTeam" | "getTeam" | "quotasFor">;
export type RateLimiterPort = Pick<RateLimiter, "consume">;
export type BootstrapPort = Pick<BootstrapService, "needsBootstrap" | "createFirstAdmin">;
export type EmailsPort = Pick<
  EmailsService,
  | "send"
  | "getEmail"
  | "getInboundEmail"
  | "listEmails"
  | "listEmailsByCursor"
  | "listEvents"
  | "updateScheduledAt"
  | "cancel"
  | "attachmentDownloadUrl"
  | "sendScheduled"
  | "listSuppressions"
  | "getSuppression"
  | "addSuppression"
  | "removeSuppression"
  | "metricsSummary"
>;
export type DomainsPort = Pick<
  DomainsService,
  | "createDomain"
  | "getDomain"
  | "listDomains"
  | "recordsFor"
  | "requestVerification"
  | "refreshVerification"
  | "updateDomain"
  | "setInboundEnabled"
  | "deleteDomain"
>;
export type WebhooksPort = Pick<
  WebhooksService,
  | "createEndpoint"
  | "getEndpoint"
  | "listEndpoints"
  | "updateEndpoint"
  | "deleteEndpoint"
  | "listDeliveries"
  | "getDelivery"
>;
export type SegmentsPort = Pick<
  SegmentsService,
  "create" | "get" | "list" | "updateName" | "delete"
>;
export type ContactsPort = Pick<
  ContactsService,
  "create" | "getByIdOrEmail" | "list" | "listSendable" | "update" | "setUnsubscribed" | "delete"
>;
export type BroadcastsPort = Pick<
  BroadcastsService,
  | "create"
  | "get"
  | "list"
  | "update"
  | "delete"
  | "markStatus"
  | "setSchedule"
  | "setPendingPages"
  | "completePage"
  | "incrementStat"
>;
