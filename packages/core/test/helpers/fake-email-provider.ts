import type {
  BlobStore,
  DomainIdentity,
  DomainVerification,
  EmailProvider,
  OutgoingMessage,
  ProviderVerificationStatus,
  QueuePublisher,
  SchedulerPort,
  TenantInfo,
} from "../../src/ports.js";

/** In-memory EmailProvider — records every SES-shaped mutation for asserts. */
export class FakeEmailProvider implements EmailProvider {
  readonly tenants = new Map<string, TenantInfo>();
  readonly identities = new Map<string, { configurationSetName: string; mailFrom?: string }>();
  readonly configurationSets = new Map<string, { clickTracking: boolean; openTracking: boolean }>();
  readonly associations = new Set<string>();
  verificationState: {
    dkimStatus: ProviderVerificationStatus;
    mailFromStatus: ProviderVerificationStatus;
  } = { dkimStatus: "PENDING", mailFromStatus: "PENDING" };
  failNextCreate = false;

  async createTenant(tenantName: string): Promise<TenantInfo> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("simulated CreateTenant failure");
    }
    const info: TenantInfo = {
      tenantName,
      tenantId: `fake-${tenantName}`,
      sendingStatus: "ENABLED",
    };
    this.tenants.set(tenantName, info);
    return info;
  }

  async getTenant(tenantName: string): Promise<TenantInfo | undefined> {
    return this.tenants.get(tenantName);
  }

  async deleteTenant(tenantName: string): Promise<void> {
    this.tenants.delete(tenantName);
  }

  async createDomainIdentity(
    domain: string,
    configurationSetName: string,
  ): Promise<DomainIdentity> {
    this.identities.set(domain, { configurationSetName });
    return {
      dkimTokens: ["token1", "token2", "token3"],
      signingHostedZone: "dkim.amazonses.com",
    };
  }

  async putMailFromAttributes(domain: string, mailFromDomain: string): Promise<void> {
    const identity = this.identities.get(domain);
    if (identity) identity.mailFrom = mailFromDomain;
  }

  async deleteDomainIdentity(domain: string): Promise<void> {
    this.identities.delete(domain);
  }

  async getDomainVerification(domain: string): Promise<DomainVerification | undefined> {
    if (!this.identities.has(domain)) return undefined;
    return {
      dkimTokens: ["token1", "token2", "token3"],
      signingHostedZone: "dkim.amazonses.com",
      ...this.verificationState,
    };
  }

  async createConfigurationSet(
    name: string,
    tracking: { clickTracking: boolean; openTracking: boolean },
  ): Promise<void> {
    this.configurationSets.set(name, tracking);
  }

  async updateConfigurationSetTracking(
    name: string,
    tracking: { clickTracking: boolean; openTracking: boolean },
  ): Promise<void> {
    this.configurationSets.set(name, tracking);
  }

  async deleteConfigurationSet(name: string): Promise<void> {
    this.configurationSets.delete(name);
  }

  async associateTenantResource(tenantName: string, resourceArn: string): Promise<void> {
    this.associations.add(`${tenantName}|${resourceArn}`);
  }

  async disassociateTenantResource(tenantName: string, resourceArn: string): Promise<void> {
    this.associations.delete(`${tenantName}|${resourceArn}`);
  }

  identityArn(domain: string): string {
    return `arn:fake:identity/${domain}`;
  }

  configurationSetArn(name: string): string {
    return `arn:fake:configuration-set/${name}`;
  }

  readonly sentMessages: OutgoingMessage[] = [];
  failNextSend = false;

  async sendEmail(message: OutgoingMessage): Promise<{ providerMessageId: string }> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("simulated SendEmail failure");
    }
    this.sentMessages.push(message);
    return { providerMessageId: `ses-msg-${this.sentMessages.length}` };
  }
}

/** In-memory BlobStore. */
export class FakeBlobStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();

  async put(key: string, body: Uint8Array | string): Promise<void> {
    this.blobs.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(key);
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  async presignGet(key: string): Promise<string> {
    return `https://blobs.example/${key}?signed`;
  }
}

/** In-memory QueuePublisher recording enqueued messages. */
export class FakeQueuePublisher implements QueuePublisher {
  readonly messages: Array<{ message: Record<string, unknown>; delaySeconds?: number }> = [];

  async enqueue(message: Record<string, unknown>, delaySeconds?: number): Promise<void> {
    this.messages.push(delaySeconds === undefined ? { message } : { message, delaySeconds });
  }
}

/** In-memory SchedulerPort. */
export class FakeScheduler implements SchedulerPort {
  readonly schedules = new Map<string, { at: Date; payload: Record<string, unknown> }>();

  async createSchedule(name: string, at: Date, payload: Record<string, unknown>): Promise<string> {
    this.schedules.set(name, { at, payload });
    return `arn:fake:schedule/${name}`;
  }

  async updateSchedule(name: string, at: Date, payload: Record<string, unknown>): Promise<void> {
    this.schedules.set(name, { at, payload });
  }

  async deleteSchedule(name: string): Promise<void> {
    this.schedules.delete(name);
  }
}
