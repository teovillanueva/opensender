import {
  AlreadyExistsException,
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  CreateEmailIdentityCommand,
  CreateTenantCommand,
  CreateTenantResourceAssociationCommand,
  DeleteConfigurationSetCommand,
  DeleteEmailIdentityCommand,
  DeleteTenantCommand,
  DeleteTenantResourceAssociationCommand,
  type DkimStatus,
  GetEmailIdentityCommand,
  GetTenantCommand,
  type MailFromDomainStatus,
  NotFoundException,
  PutEmailIdentityMailFromAttributesCommand,
  type SESv2Client,
  SendEmailCommand,
  UpdateConfigurationSetEventDestinationCommand,
} from "@aws-sdk/client-sesv2";
import type {
  DomainIdentity,
  DomainVerification,
  EmailProvider,
  OutgoingMessage,
  ProviderVerificationStatus,
  TenantInfo,
} from "../ports.js";

const EVENT_DESTINATION_NAME = "eventbridge";

/**
 * The full MatchingEventTypes enum (SPEC §7 step 4), minus OPEN/CLICK when
 * the domain's tracking toggles are off — SES only injects the tracking
 * pixel / rewrites links for event types the destination matches.
 */
function matchingEventTypes(tracking: { clickTracking: boolean; openTracking: boolean }) {
  const base = [
    "SEND",
    "REJECT",
    "BOUNCE",
    "COMPLAINT",
    "DELIVERY",
    "RENDERING_FAILURE",
    "DELIVERY_DELAY",
    "SUBSCRIPTION",
  ] as const;
  return [
    ...base,
    ...(tracking.openTracking ? (["OPEN"] as const) : []),
    ...(tracking.clickTracking ? (["CLICK"] as const) : []),
  ];
}

function normalizeStatus(
  status: DkimStatus | MailFromDomainStatus | string | undefined,
): ProviderVerificationStatus {
  switch (status) {
    case "SUCCESS":
      return "SUCCESS";
    case "PENDING":
      return "PENDING";
    case "FAILED":
      return "FAILED";
    case "TEMPORARY_FAILURE":
      return "TEMPORARY_FAILURE";
    default:
      return "NOT_STARTED";
  }
}

export interface SesEmailProviderConfig {
  region: string;
  accountId: string;
  /** Default EventBridge bus — SES event destinations support only it. */
  eventBusArn?: string;
}

/**
 * SES v2 adapter for the EmailProvider port. CreateTenant has NO reputation
 * policy parameter — Standard is auto-assigned; changes go through
 * UpdateReputationEntityPolicy on the tenant ARN (SPEC §6.3, R03 §1.4).
 */
export class SesEmailProvider implements EmailProvider {
  private readonly eventBusArn: string;

  constructor(
    private readonly client: SESv2Client,
    private readonly config: SesEmailProviderConfig,
  ) {
    this.eventBusArn =
      config.eventBusArn ?? `arn:aws:events:${config.region}:${config.accountId}:event-bus/default`;
  }

  identityArn(domain: string): string {
    return `arn:aws:ses:${this.config.region}:${this.config.accountId}:identity/${domain}`;
  }

  configurationSetArn(name: string): string {
    return `arn:aws:ses:${this.config.region}:${this.config.accountId}:configuration-set/${name}`;
  }

  async createTenant(tenantName: string): Promise<TenantInfo> {
    const result = await this.client.send(new CreateTenantCommand({ TenantName: tenantName }));
    return {
      tenantName: result.TenantName ?? tenantName,
      tenantId: result.TenantId ?? "",
      sendingStatus: result.SendingStatus ?? "ENABLED",
    };
  }

  async getTenant(tenantName: string): Promise<TenantInfo | undefined> {
    try {
      const result = await this.client.send(new GetTenantCommand({ TenantName: tenantName }));
      return {
        tenantName: result.Tenant?.TenantName ?? tenantName,
        tenantId: result.Tenant?.TenantId ?? "",
        sendingStatus: result.Tenant?.SendingStatus ?? "ENABLED",
      };
    } catch (error) {
      if (error instanceof NotFoundException) return undefined;
      throw error;
    }
  }

  async deleteTenant(tenantName: string): Promise<void> {
    try {
      await this.client.send(new DeleteTenantCommand({ TenantName: tenantName }));
    } catch (error) {
      if (error instanceof NotFoundException) return;
      throw error;
    }
  }

  async createDomainIdentity(
    domain: string,
    configurationSetName: string,
  ): Promise<DomainIdentity> {
    const result = await this.client.send(
      new CreateEmailIdentityCommand({
        EmailIdentity: domain,
        ConfigurationSetName: configurationSetName,
        DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
      }),
    );
    return {
      dkimTokens: result.DkimAttributes?.Tokens ?? [],
      // Never hardcode: region-dependent (us-east-1 is dkim.amazonses.com).
      signingHostedZone: result.DkimAttributes?.SigningHostedZone ?? "dkim.amazonses.com",
    };
  }

  async putMailFromAttributes(domain: string, mailFromDomain: string): Promise<void> {
    await this.client.send(
      new PutEmailIdentityMailFromAttributesCommand({
        EmailIdentity: domain,
        MailFromDomain: mailFromDomain,
        BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
      }),
    );
  }

  async deleteDomainIdentity(domain: string): Promise<void> {
    try {
      await this.client.send(new DeleteEmailIdentityCommand({ EmailIdentity: domain }));
    } catch (error) {
      if (error instanceof NotFoundException) return;
      throw error;
    }
  }

  async getDomainVerification(domain: string): Promise<DomainVerification | undefined> {
    try {
      const result = await this.client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
      const verification: DomainVerification = {
        dkimTokens: result.DkimAttributes?.Tokens ?? [],
        signingHostedZone: result.DkimAttributes?.SigningHostedZone ?? "dkim.amazonses.com",
        dkimStatus: normalizeStatus(result.DkimAttributes?.Status),
        mailFromStatus: normalizeStatus(result.MailFromAttributes?.MailFromDomainStatus),
      };
      const errorType = result.VerificationInfo?.ErrorType;
      if (errorType) verification.verificationError = errorType;
      const lastChecked = result.VerificationInfo?.LastCheckedTimestamp;
      if (lastChecked) verification.lastCheckedAt = lastChecked.toISOString();
      return verification;
    } catch (error) {
      if (error instanceof NotFoundException) return undefined;
      throw error;
    }
  }

  async createConfigurationSet(
    name: string,
    tracking: { clickTracking: boolean; openTracking: boolean },
  ): Promise<void> {
    await this.client.send(new CreateConfigurationSetCommand({ ConfigurationSetName: name }));
    await this.client.send(
      new CreateConfigurationSetEventDestinationCommand({
        ConfigurationSetName: name,
        EventDestinationName: EVENT_DESTINATION_NAME,
        EventDestination: {
          Enabled: true,
          MatchingEventTypes: [...matchingEventTypes(tracking)],
          EventBridgeDestination: { EventBusArn: this.eventBusArn },
        },
      }),
    );
  }

  async updateConfigurationSetTracking(
    name: string,
    tracking: { clickTracking: boolean; openTracking: boolean },
  ): Promise<void> {
    await this.client.send(
      new UpdateConfigurationSetEventDestinationCommand({
        ConfigurationSetName: name,
        EventDestinationName: EVENT_DESTINATION_NAME,
        EventDestination: {
          Enabled: true,
          MatchingEventTypes: [...matchingEventTypes(tracking)],
          EventBridgeDestination: { EventBusArn: this.eventBusArn },
        },
      }),
    );
  }

  async deleteConfigurationSet(name: string): Promise<void> {
    try {
      await this.client.send(new DeleteConfigurationSetCommand({ ConfigurationSetName: name }));
    } catch (error) {
      if (error instanceof NotFoundException) return;
      throw error;
    }
  }

  async associateTenantResource(tenantName: string, resourceArn: string): Promise<void> {
    try {
      await this.client.send(
        new CreateTenantResourceAssociationCommand({
          TenantName: tenantName,
          ResourceArn: resourceArn,
        }),
      );
    } catch (error) {
      // Convergent: re-running an association is not an error for us.
      if (error instanceof AlreadyExistsException) return;
      throw error;
    }
  }

  async sendEmail(message: OutgoingMessage): Promise<{ providerMessageId: string }> {
    const destination = {
      ToAddresses: message.to,
      ...(message.cc.length ? { CcAddresses: message.cc } : {}),
      ...(message.bcc.length ? { BccAddresses: message.bcc } : {}),
    };
    const content =
      message.content.kind === "simple"
        ? {
            Simple: {
              Subject: { Data: message.subject, Charset: "UTF-8" },
              Body: {
                ...(message.content.html
                  ? { Html: { Data: message.content.html, Charset: "UTF-8" } }
                  : {}),
                ...(message.content.text
                  ? { Text: { Data: message.content.text, Charset: "UTF-8" } }
                  : {}),
              },
            },
          }
        : { Raw: { Data: message.content.mime } };
    const result = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: message.from,
        Destination: destination,
        ...(message.replyTo.length ? { ReplyToAddresses: message.replyTo } : {}),
        Content: content,
        TenantName: message.tenantName,
        ConfigurationSetName: message.configurationSetName,
        EmailTags: Object.entries(message.tags).map(([Name, Value]) => ({ Name, Value })),
      }),
    );
    return { providerMessageId: result.MessageId ?? "" };
  }

  async disassociateTenantResource(tenantName: string, resourceArn: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteTenantResourceAssociationCommand({
          TenantName: tenantName,
          ResourceArn: resourceArn,
        }),
      );
    } catch (error) {
      if (error instanceof NotFoundException) return;
      throw error;
    }
  }
}
