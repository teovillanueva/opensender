/**
 * Ports (SPEC §2.1). An interface exists only with ≥2 real implementations or
 * a test that needs it. EmailProvider: SES adapter + in-memory test fake.
 */

export interface TenantInfo {
  tenantName: string;
  tenantId: string;
  sendingStatus: string;
}

/** SES-side verification states, normalized (SPEC §7 / R03 §5.3). */
export type ProviderVerificationStatus =
  | "NOT_STARTED"
  | "PENDING"
  | "SUCCESS"
  | "FAILED"
  | "TEMPORARY_FAILURE";

export interface DomainIdentity {
  dkimTokens: string[];
  /** Region-dependent DKIM CNAME target zone — never hardcode (R03 §5.2). */
  signingHostedZone: string;
}

export interface DomainVerification extends DomainIdentity {
  dkimStatus: ProviderVerificationStatus;
  mailFromStatus: ProviderVerificationStatus;
  verificationError?: string;
  lastCheckedAt?: string;
}

export interface OutgoingMessage {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  /** Exactly one of these shapes reaches the provider (SPEC §6.2). */
  content: { kind: "simple"; html?: string; text?: string } | { kind: "raw"; mime: Uint8Array };
  tenantName: string;
  configurationSetName: string;
  /** Sanitized SES message tags incl. internal email_id/team_id (SPEC §6.4). */
  tags: Record<string, string>;
}

export interface EmailProvider {
  /** Create the reputation-isolation tenant backing a Team (SES v2 Tenant). */
  createTenant(tenantName: string): Promise<TenantInfo>;
  getTenant(tenantName: string): Promise<TenantInfo | undefined>;
  deleteTenant(tenantName: string): Promise<void>;

  /** Easy DKIM 2048 identity; the config set must already exist (SPEC §7). */
  createDomainIdentity(domain: string, configurationSetName: string): Promise<DomainIdentity>;
  putMailFromAttributes(domain: string, mailFromDomain: string): Promise<void>;
  deleteDomainIdentity(domain: string): Promise<void>;
  getDomainVerification(domain: string): Promise<DomainVerification | undefined>;

  /** Config set with the EventBridge event destination (SPEC §7 step 4). */
  createConfigurationSet(
    name: string,
    tracking: { clickTracking: boolean; openTracking: boolean },
  ): Promise<void>;
  updateConfigurationSetTracking(
    name: string,
    tracking: { clickTracking: boolean; openTracking: boolean },
  ): Promise<void>;
  deleteConfigurationSet(name: string): Promise<void>;

  associateTenantResource(tenantName: string, resourceArn: string): Promise<void>;
  disassociateTenantResource(tenantName: string, resourceArn: string): Promise<void>;
  identityArn(domain: string): string;
  configurationSetArn(name: string): string;

  /** Tenant send; returns the provider message id (SPEC §6). */
  sendEmail(message: OutgoingMessage): Promise<{ providerMessageId: string }>;
}

export interface BlobStore {
  put(key: string, body: Uint8Array | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
  /** Presigned download URL (SPEC §5.14: 1h expiry). */
  presignGet(key: string, expiresInSeconds: number, filename?: string): Promise<string>;
}

export interface SchedulerPort {
  /** One-time schedule firing at `at`; self-deletes after completion. */
  createSchedule(name: string, at: Date, payload: Record<string, unknown>): Promise<string>;
  updateSchedule(name: string, at: Date, payload: Record<string, unknown>): Promise<void>;
  deleteSchedule(name: string): Promise<void>;
}

export interface QueuePublisher {
  /** Enqueue a JSON message, optionally delayed (SQS caps delay at 900s). */
  enqueue(message: Record<string, unknown>, delaySeconds?: number): Promise<void>;
}

/** Operator alerting channel (SPEC §15): tenant freezes, auto-freezes, and any
 * other event the operator must see. Backed by the ops SNS topic in prod. */
export interface AlertPublisher {
  publish(subject: string, message: string): Promise<void>;
}

/** Injected everywhere time or identity is generated, so tests are exact. */
/** Minimal DNS read used to observe the receiving MX record (SPEC §9) —
 * SES never reports it, so the instance resolves it directly. */
export interface DnsResolver {
  /** MX exchange hostnames for `hostname`; may throw on NXDOMAIN/no data. */
  resolveMx(hostname: string): Promise<string[]>;
}

export type Clock = () => Date;
export type IdGenerator = () => string;
