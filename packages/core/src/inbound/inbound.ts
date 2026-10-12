import PostalMime from "postal-mime";
import type { EmailEntity } from "../adapters/dynamo-entities.js";
import type { DomainsService } from "../domains/domains.js";
import type { StoredAttachmentMeta, StoredEmail } from "../emails/emails.js";
import type { EventsService } from "../events/emitter.js";
import type { BlobStore, Clock, IdGenerator } from "../ports.js";

/**
 * Inbound processing (SPEC §9): parse the raw MIME from S3 with postal-mime,
 * store the Email (direction inbound) + attachments, keep SES verdicts in
 * internal metadata, and emit `email.received` — metadata only, no body or
 * attachment URLs (R02 §6). Content is served via GET /emails/receiving/*.
 */

export interface SesVerdicts {
  spamVerdict?: string;
  virusVerdict?: string;
  spfVerdict?: string;
  dkimVerdict?: string;
  dmarcVerdict?: string;
}

export interface InboundServiceDeps {
  emails: EmailEntity;
  blobs: BlobStore;
  domains: Pick<DomainsService, "getDomainByName">;
  emitter: Pick<EventsService, "emit">;
  clock: Clock;
  idGenerator: IdGenerator;
}

interface StoredInboundAttachment extends StoredAttachmentMeta {
  contentId?: string;
  contentDisposition?: string;
}

export class InboundService {
  constructor(private readonly deps: InboundServiceDeps) {}

  /**
   * Returns the stored email, or undefined when no recipient domain has
   * inbound enabled (the catch-all rule fires for every verified identity,
   * so send-only domains reach here and must be dropped).
   */
  async process(input: {
    messageId: string;
    recipients: string[];
    rawMime: Uint8Array;
    verdicts: SesVerdicts;
  }): Promise<StoredEmail | undefined> {
    const teamId = await this.resolveInboundTeam(input.recipients);
    if (!teamId) return undefined;

    const parsed = await PostalMime.parse(input.rawMime);
    const emailId = this.deps.idGenerator();
    const createdAt = this.deps.clock().toISOString();

    const attachments: StoredInboundAttachment[] = [];
    for (const attachment of parsed.attachments ?? []) {
      const attachmentId = this.deps.idGenerator();
      const blobKey = `inbound/${emailId}/${attachmentId}`;
      const bytes =
        attachment.content instanceof ArrayBuffer
          ? new Uint8Array(attachment.content)
          : new TextEncoder().encode(String(attachment.content));
      await this.deps.blobs.put(blobKey, bytes, attachment.mimeType);
      attachments.push({
        attachmentId,
        filename: attachment.filename ?? "attachment",
        ...(attachment.mimeType === undefined ? {} : { contentType: attachment.mimeType }),
        sizeBytes: bytes.byteLength,
        blobKey,
        ...(attachment.contentId ? { contentId: attachment.contentId.replace(/[<>]/g, "") } : {}),
        ...(attachment.disposition ? { contentDisposition: attachment.disposition } : {}),
      });
    }

    const headers: Record<string, string> = {};
    for (const header of parsed.headers ?? []) {
      headers[header.key] = header.value;
    }

    const to = (parsed.to ?? []).map((address) => address.address ?? "").filter(Boolean);
    const cc = (parsed.cc ?? []).map((address) => address.address ?? "").filter(Boolean);

    const email: StoredEmail = {
      emailId,
      teamId,
      direction: "inbound",
      from: parsed.from?.address ?? input.recipients[0] ?? "unknown",
      to: to.length > 0 ? to : input.recipients,
      cc: cc.length > 0 ? cc : undefined,
      subject: parsed.subject ?? "",
      html: parsed.html ?? undefined,
      text: parsed.text ?? undefined,
      status: "received",
      messageId: input.messageId,
      createdAt,
      attachments: attachments.length ? attachments : undefined,
      headers,
      // Verdicts are internal (dashboard-only) — never in the public payload.
      verdicts: { ...input.verdicts },
    };

    const item = Object.fromEntries(Object.entries(email).filter(([, v]) => v !== undefined));
    // biome-ignore lint/suspicious/noExplicitAny: filtered clone of a typed literal
    await this.deps.emails.create(item as any).go();

    // email.received is metadata-only (SPEC §9.3): no html/text/headers, no
    // attachment content or URLs — just the attachment metadata.
    await this.deps.emitter.emit(teamId, {
      type: "email.received",
      emailId,
      data: {
        email_id: emailId,
        created_at: createdAt,
        from: email.from,
        to: email.to,
        bcc: [],
        cc: cc,
        message_id: input.messageId,
        subject: email.subject,
        attachments: attachments.map((attachment) => ({
          id: attachment.attachmentId,
          filename: attachment.filename,
          content_type: attachment.contentType ?? "application/octet-stream",
          content_disposition: attachment.contentDisposition ?? "attachment",
          ...(attachment.contentId ? { content_id: attachment.contentId } : {}),
        })),
      },
    });

    return email;
  }

  private async resolveInboundTeam(recipients: string[]): Promise<string | undefined> {
    for (const recipient of recipients) {
      const domainName = recipient.split("@")[1]?.toLowerCase();
      if (!domainName) continue;
      const domain = await this.deps.domains.getDomainByName(domainName);
      if (domain?.inboundEnabled) return domain.teamId;
    }
    return undefined;
  }
}
