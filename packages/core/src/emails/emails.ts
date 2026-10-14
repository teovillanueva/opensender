import type {
  EmailEntity,
  EmailEventEntity,
  SuppressionEntity,
} from "../adapters/dynamo-entities.js";
import type { QuotaCounters, QuotaUsage } from "../adapters/quota-counters.js";
import type { DomainsService } from "../domains/domains.js";
import type { EventsService } from "../events/emitter.js";
import { SafeFetchError, safeFetch } from "../http/safe-fetch.js";
import type { BlobStore, Clock, EmailProvider, IdGenerator, SchedulerPort } from "../ports.js";
import type { TeamsService } from "../teams/teams.js";
import type { ResolvedAttachment } from "./build-message.js";
import {
  buildRawMime,
  buildSimpleContent,
  needsRawMime,
  resolveContentType,
} from "./build-message.js";
import type { EmailStatus } from "./state-machine.js";
import { transition } from "./state-machine.js";
import type { SendRequest } from "./validate.js";

export class SendRejectedError extends Error {
  constructor(
    readonly statusCode: number,
    readonly errorName: string,
    message: string,
  ) {
    super(message);
  }
}

export interface StoredAttachmentMeta {
  attachmentId: string;
  filename: string;
  contentType?: string;
  /** Inline part referenced from the html as `cid:<contentId>`. */
  contentId?: string;
  sizeBytes: number;
  blobKey: string;
}

export interface StoredEmail {
  emailId: string;
  teamId: string;
  direction: "outbound" | "inbound";
  from: string;
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  replyTo?: string[] | undefined;
  subject: string;
  html?: string | undefined;
  text?: string | undefined;
  status: EmailStatus;
  scheduledAt?: string | undefined;
  sesMessageId?: string | undefined;
  messageId?: string | undefined;
  createdAt: string;
  attachments?: StoredAttachmentMeta[] | undefined;
  /** Request tags as sent (unsanitized); echoed on webhook events as `data.tags`. */
  tags?: Array<{ name: string; value: string }> | undefined;
  /** Inbound only: parsed headers, and SES verdicts (internal, never on the wire). */
  headers?: Record<string, string> | undefined;
  verdicts?: Record<string, string | undefined> | undefined;
  /** Set on broadcast sends so delivery events attribute to the broadcast (SPEC §11). */
  broadcastId?: string | undefined;
  /** The API key that sent it; absent on session (dashboard) sends and inbound. */
  apiKeyId?: string | undefined;
}

/** ~4.5 MB of raw bytes per request (SPEC §3.1, 6 MB sync-invoke cap). */
const MAX_INLINE_ATTACHMENT_BYTES = Math.floor(4.5 * 1024 * 1024);
const MAX_PATH_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/**
 * Combined html+text byte cap. Bodies are stored inline in the DynamoDB item
 * (the S3 body-offload seam is not yet wired), so a pair large enough to breach
 * DynamoDB's 400 KB item limit would make persist() throw AFTER SES has already
 * accepted the message — the client would see a 500 for an email that actually
 * went out, with no DB record. Capping here, before the provider call, turns
 * that into a clean 422. 256 KB leaves headroom for keys, headers, attachment
 * metadata and event bookkeeping.
 */
const MAX_BODY_BYTES = 256 * 1024;
/** SES tag charset (SPEC §6.4). */
const TAG_SANITIZE = /[^a-zA-Z0-9_-]/g;

function bodyByteLength(request: SendRequest): number {
  return (
    (request.html ? Buffer.byteLength(request.html, "utf8") : 0) +
    (request.text ? Buffer.byteLength(request.text, "utf8") : 0)
  );
}

/** Replace oversized bodies with a marker so the `failed` record still persists
 * (a batch item is recorded, not dropped) without breaching the item limit. */
function withStrippedBodies(request: SendRequest): SendRequest {
  const marker = "[email body omitted: exceeded maximum size]";
  return {
    ...request,
    ...(request.html === undefined ? {} : { html: marker }),
    ...(request.text === undefined ? {} : { text: marker }),
  };
}

/** Deterministic schedule name — create/update/delete all derive it. */
function scheduleNameFor(emailId: string): string {
  return `email-${emailId}`;
}

/** One entry in an email's event timeline (SPEC §13.3, dashboard detail). */
export interface EmailTimelineEvent {
  type: string;
  occurredAt: string;
  payload?: unknown;
}

/** Optional narrowing for the dashboard email list (SPEC §13.3). */
export interface EmailListFilters {
  status?: string | undefined;
  /** ISO instant lower bound (inclusive). */
  after?: string | undefined;
  /** ISO instant upper bound. */
  before?: string | undefined;
  /** Only emails sent with this API key (unset on pre-existing rows). */
  apiKeyId?: string | undefined;
}

export interface StoredSuppression {
  teamId: string;
  email: string;
  reason: "hard_bounce" | "complaint" | "manual";
  sourceEmailId?: string;
  createdAt: string;
}

export class SuppressionExistsError extends Error {}

interface MetricsDay {
  date: string;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  /** Inbound volume (receiving is counted, never rated). */
  received: number;
}

interface MetricsDomain {
  domain: string;
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  /** Inbound volume addressed to this domain. */
  received: number;
}

export interface MetricsSummary {
  start: string;
  end: string;
  totals: {
    sent: number;
    /** Sends that reached the provider — the denominator for all rates. */
    attempted: number;
    delivered: number;
    bounced: number;
    complained: number;
    failed: number;
    received: number;
  };
  daily: MetricsDay[];
  domains: MetricsDomain[];
}

/** The bare domain of a from value, handling `Name <a@b.com>` display forms. */
function senderDomain(from: string): string {
  const address = from.match(/<([^>]+)>/)?.[1] ?? from;
  return address.split("@")[1]?.trim().toLowerCase() ?? "unknown";
}

export interface EmailsServiceDeps {
  emails: EmailEntity;
  /** Read-only source for the dashboard event timeline; absent on the write-only
   * composition roots (send/scheduled-send) that never render a timeline. */
  events?: EmailEventEntity;
  emitter: Pick<EventsService, "emit">;
  suppressions: SuppressionEntity;
  quotas: QuotaCounters;
  /** Reputation window counters (SPEC §12). Optional so write-only roots and
   * tests that don't exercise guardrails can omit it. */
  reputation?: { recordSends(teamId: string, recipients: number): Promise<void> } | undefined;
  blobs: BlobStore;
  emailProvider: EmailProvider;
  teams: Pick<TeamsService, "getTeam" | "quotasFor">;
  domains: Pick<DomainsService, "listDomains">;
  scheduler: SchedulerPort;
  clock: Clock;
  idGenerator: IdGenerator;
}

/** Outbound email events share this data shape (R02 §3.1 + message_id). */
export function outboundEmailEventData(email: StoredEmail): Record<string, unknown> {
  return {
    email_id: email.emailId,
    created_at: new Date(email.createdAt).toISOString(),
    from: email.from,
    to: email.to,
    subject: email.subject,
    ...(email.messageId === undefined ? {} : { message_id: email.messageId }),
    // Upstream's object form ({ name: value }); receivers join events on these.
    ...(email.tags?.length
      ? { tags: Object.fromEntries(email.tags.map((tag) => [tag.name, tag.value])) }
      : {}),
  };
}

/** SES message tags: the request's (sanitized) plus the internal correlation pair. */
function sesTagsFor(
  emailId: string,
  teamId: string,
  tags: Array<{ name: string; value: string }>,
): Record<string, string> {
  return {
    ...Object.fromEntries(
      tags.map((tag) => [
        tag.name.replace(TAG_SANITIZE, "_"),
        tag.value.replace(TAG_SANITIZE, "_"),
      ]),
    ),
    email_id: emailId,
    team_id: teamId.replace(TAG_SANITIZE, "_"),
  };
}

export class EmailsService {
  constructor(private readonly deps: EmailsServiceDeps) {}

  /**
   * The send pipeline (SPEC §6): validate happened at the boundary; here:
   * checkDomain → checkSuppression → checkQuota → buildMessage → send →
   * persist → record event. `enforceSync: false` (batch items) accepts the
   * email and marks it failed instead of rejecting the request (fixture 32).
   */
  async send(
    teamId: string,
    request: SendRequest,
    options: {
      enforceSync: boolean;
      broadcastId?: string;
      emailId?: string;
      apiKeyId?: string;
      /** OAuth grant narrowed to specific domains: the
       * resolved from-domain must be one of these ids. */
      allowedDomainIds?: string[] | undefined;
    },
  ): Promise<{ email: StoredEmail; usage: QuotaUsage; deduped?: boolean }> {
    const { clock, idGenerator, quotas } = this.deps;
    const emailId = options.emailId ?? idGenerator();
    const createdAt = clock().toISOString();

    // Idempotent broadcast fan-out (SPEC §11): the fan-out passes a deterministic
    // emailId per (broadcastId, contactId). An at-least-once SQS redelivery that
    // re-runs this send finds the already-persisted row and returns it WITHOUT a
    // second SES send. A consistent read closes the eventual-consistency gap on a
    // fast redelivery; SQS visibility serializes redeliveries of the same page,
    // so this check-then-send has no concurrent race. Single-API sends pass no
    // emailId (random id each call) and skip this path entirely.
    if (options.emailId) {
      const existing = await this.deps.emails.get({ emailId }).go({ consistent: true });
      if (existing.data) {
        return {
          email: existing.data as StoredEmail,
          usage: await quotas.current(teamId),
          deduped: true,
        };
      }
    }

    const oversize = bodyByteLength(request) > MAX_BODY_BYTES;

    let failure: SendRejectedError | undefined;
    let fromDomain: Awaited<ReturnType<typeof this.verifiedDomainFor>> | undefined;
    try {
      if (oversize) {
        throw new SendRejectedError(
          422,
          "validation_error",
          `The email body exceeds the maximum size of ${MAX_BODY_BYTES / 1024} KB.`,
        );
      }
      await this.checkTeamActive(teamId);
      fromDomain = await this.verifiedDomainFor(teamId, request.from);
      if (options.allowedDomainIds && !options.allowedDomainIds.includes(fromDomain.domainId)) {
        throw new SendRejectedError(
          401,
          "restricted_api_key",
          "This authorization is restricted to specific sending domains and cannot send from this domain.",
        );
      }
      await this.checkSuppressions(teamId, request);
      await this.checkDailyQuota(teamId);
    } catch (error) {
      if (!(error instanceof SendRejectedError) || options.enforceSync) throw error;
      failure = error;
    }

    let email: StoredEmail;
    if (failure) {
      email = await this.persist(
        teamId,
        emailId,
        createdAt,
        oversize ? withStrippedBodies(request) : request,
        "failed",
        [],
        { ...(options.apiKeyId ? { apiKeyId: options.apiKeyId } : {}) },
      );
    } else if (request.scheduledAt !== undefined) {
      // Attachment bytes are resolved and stored NOW: the request is gone by
      // fire time, so the blobs are the only durable copy (SPEC §10).
      const attachments = await this.resolveAttachments(request);
      email = await this.persist(
        teamId,
        emailId,
        createdAt,
        request,
        "scheduled",
        await this.storeAttachments(emailId, attachments),
        { ...(options.apiKeyId ? { apiKeyId: options.apiKeyId } : {}) },
      );
      const scheduleArn = await this.deps.scheduler.createSchedule(
        scheduleNameFor(emailId),
        new Date(request.scheduledAt),
        { emailId },
      );
      await this.deps.emails.patch({ emailId }).set({ scheduleArn }).go();
      await this.deps.emitter.emit(teamId, {
        type: "email.scheduled",
        emailId,
        data: outboundEmailEventData(email),
      });
    } else {
      const attachments = await this.resolveAttachments(request);
      const content = needsRawMime(request)
        ? await buildRawMime(request, attachments)
        : buildSimpleContent(request);

      const team = await this.deps.teams.getTeam(teamId);
      if (!team) throw new Error(`team ${teamId} has no Team record`);
      const domain = fromDomain as NonNullable<typeof fromDomain>;

      const { providerMessageId } = await this.deps.emailProvider.sendEmail({
        from: request.from,
        to: request.to,
        cc: request.cc,
        bcc: request.bcc,
        replyTo: request.replyTo,
        subject: request.subject,
        content,
        tenantName: team.sesTenantName,
        configurationSetName: domain.configurationSetName,
        tags: sesTagsFor(emailId, teamId, request.tags),
      });

      email = await this.persist(
        teamId,
        emailId,
        createdAt,
        request,
        "sent",
        await this.storeAttachments(emailId, attachments),
        {
          sesMessageId: providerMessageId,
          ...(options.broadcastId ? { broadcastId: options.broadcastId } : {}),
          ...(options.apiKeyId ? { apiKeyId: options.apiKeyId } : {}),
        },
      );
      await this.deps.emitter.emit(teamId, {
        type: "email.sent",
        emailId,
        data: outboundEmailEventData(email),
      });
    }

    const usage = await quotas.record(teamId, 1);
    // Reputation + the `sends` metric count only a real send — never a persisted
    // failure, and never a scheduled email at creation time (sendScheduled
    // records when it actually sends). This keeps the auto-freeze denominator
    // honest and lands the count in the same daily bucket as its bounces (§12).
    if (email.status === "sent") {
      await this.deps.reputation?.recordSends(
        teamId,
        request.to.length + request.cc.length + request.bcc.length,
      );
    }
    return { email, usage };
  }

  /** Reject sends from a frozen team (SPEC §12) with a clear, actionable error. */
  private async checkTeamActive(teamId: string): Promise<void> {
    const team = await this.deps.teams.getTeam(teamId);
    if (!team) throw new Error(`team ${teamId} has no Team record`);
    if (team.status === "frozen") {
      throw new SendRejectedError(
        403,
        "restricted",
        "Your account's sending is currently paused. Please contact support to restore sending.",
      );
    }
  }

  private async verifiedDomainFor(teamId: string, from: string) {
    const address = from.match(/<([^<>]+)>$/)?.[1] ?? from;
    const domainName = address.split("@")[1]?.toLowerCase() ?? "";
    const domains = await this.deps.domains.listDomains(teamId);
    const domain = domains.find((entry) => entry.name === domainName);
    if (domain?.status !== "verified") {
      throw new SendRejectedError(
        403,
        "validation_error",
        `The ${domainName} domain is not verified. Please, add and verify your domain on https://resend.com/domains`,
      );
    }
    return domain;
  }

  private async checkSuppressions(teamId: string, request: SendRequest): Promise<void> {
    for (const recipient of [...request.to, ...request.cc, ...request.bcc]) {
      const hit = await this.deps.suppressions.get({ teamId, email: recipient.toLowerCase() }).go();
      if (hit.data) {
        throw new SendRejectedError(
          422,
          "validation_error",
          `The recipient ${recipient} is on the suppression list.`,
        );
      }
    }
  }

  private async checkDailyQuota(teamId: string): Promise<void> {
    const team = await this.deps.teams.getTeam(teamId);
    if (!team) throw new Error(`team ${teamId} has no Team record`);
    const usage = await this.deps.quotas.current(teamId);
    const limit = this.deps.teams.quotasFor(team).dailyEmailLimit;
    if (usage.daily >= limit) {
      throw new SendRejectedError(
        429,
        "daily_quota_exceeded",
        `You have reached your daily email sending quota (${limit}).`,
      );
    }
  }

  private async resolveAttachments(request: SendRequest): Promise<ResolvedAttachment[]> {
    const resolved: ResolvedAttachment[] = [];
    for (const attachment of request.attachments) {
      if (attachment.content !== undefined) {
        const content = Buffer.from(attachment.content, "base64");
        if (content.byteLength > MAX_INLINE_ATTACHMENT_BYTES) {
          throw new SendRejectedError(
            422,
            "invalid_attachment",
            "Inline attachments are limited to ~4.5 MB; use `path` for larger files.",
          );
        }
        resolved.push({
          filename: attachment.filename,
          content,
          contentType: resolveContentType(attachment.filename, attachment.contentType),
          contentId: attachment.contentId,
        });
      } else if (attachment.path !== undefined) {
        try {
          const fetched = await safeFetch(attachment.path, {
            maxBytes: MAX_PATH_ATTACHMENT_BYTES,
          });
          resolved.push({
            filename: attachment.filename,
            content: fetched.body,
            contentType: resolveContentType(
              attachment.filename,
              attachment.contentType,
              fetched.contentType,
            ),
            contentId: attachment.contentId,
          });
        } catch (error) {
          if (error instanceof SafeFetchError) {
            throw new SendRejectedError(
              422,
              "invalid_attachment",
              `Could not download the attachment at \`${attachment.path}\`.`,
            );
          }
          throw error;
        }
      }
    }
    return resolved;
  }

  private async storeAttachments(
    emailId: string,
    attachments: ResolvedAttachment[],
  ): Promise<StoredAttachmentMeta[]> {
    const stored: StoredAttachmentMeta[] = [];
    for (const attachment of attachments) {
      const attachmentId = this.deps.idGenerator();
      const blobKey = `attachments/${emailId}/${attachmentId}`;
      await this.deps.blobs.put(blobKey, attachment.content, attachment.contentType);
      stored.push({
        attachmentId,
        filename: attachment.filename,
        ...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
        ...(attachment.contentId === undefined ? {} : { contentId: attachment.contentId }),
        sizeBytes: attachment.content.byteLength,
        blobKey,
      });
    }
    return stored;
  }

  private async persist(
    teamId: string,
    emailId: string,
    createdAt: string,
    request: SendRequest,
    status: EmailStatus,
    attachments: StoredAttachmentMeta[],
    extras: { sesMessageId?: string; broadcastId?: string; apiKeyId?: string } = {},
  ): Promise<StoredEmail> {
    const { sesMessageId, broadcastId, apiKeyId } = extras;
    const email: StoredEmail = {
      emailId,
      teamId,
      direction: "outbound",
      from: request.from,
      to: request.to,
      cc: request.cc.length ? request.cc : undefined,
      bcc: request.bcc.length ? request.bcc : undefined,
      replyTo: request.replyTo.length ? request.replyTo : undefined,
      subject: request.subject,
      html: request.html,
      text: request.text,
      status,
      scheduledAt: request.scheduledAt,
      sesMessageId,
      messageId: sesMessageId ? `<${sesMessageId}@email.amazonses.com>` : undefined,
      createdAt,
      attachments: attachments.length ? attachments : undefined,
      tags: request.tags.length ? request.tags : undefined,
      broadcastId,
      apiKeyId,
    };
    // exactOptionalPropertyTypes: ElectroDB's create() rejects explicit
    // undefined values — persist only the keys that are present.
    const item = Object.fromEntries(
      Object.entries(email).filter(([, value]) => value !== undefined),
    );
    // biome-ignore lint/suspicious/noExplicitAny: filtered clone of a typed literal
    await this.deps.emails.create(item as any).go();
    return email;
  }

  async getEmail(teamId: string, emailId: string): Promise<StoredEmail | undefined> {
    const result = await this.deps.emails.get({ emailId }).go();
    const email = result.data ?? undefined;
    return email && email.teamId === teamId ? (email as StoredEmail) : undefined;
  }

  async listEmails(
    teamId: string,
    limit: number,
    direction: "outbound" | "inbound" = "outbound",
    cursor?: string,
    filters?: EmailListFilters,
  ): Promise<{ emails: StoredEmail[]; cursor: string | null }> {
    // One DynamoDB page per call, newest-first, filtered by direction in memory
    // (both directions are low-volume per page at this scale). The opaque DB
    // cursor is returned verbatim so the dashboard can page without skips or
    // dupes even when a page filters down to few rows (SPEC §5.3/§5.14/§13).
    // Date bounds ride the byTeam sort key (createdAt); status is a filter
    // expression, so a heavily filtered page may come back short — the cursor
    // still advances correctly.
    const { after, before, status, apiKeyId } = filters ?? {};
    let query = this.deps.emails.query
      .byTeam({ teamId })
      .between({ createdAt: after ?? "" }, { createdAt: before ?? "￿" });
    if (status) {
      query = query.where((attr, op) => op.eq(attr.status, status as StoredEmail["status"]));
    }
    if (apiKeyId) {
      query = query.where((attr, op) => op.eq(attr.apiKeyId, apiKeyId));
    }
    const result = await query.go({ limit, order: "desc", ...(cursor ? { cursor } : {}) });
    const emails = (result.data as StoredEmail[]).filter((email) => email.direction === direction);
    return { emails, cursor: result.cursor ?? null };
  }

  /**
   * Public `GET /emails` page (upstream semantics): newest-first outbound
   * emails; `after` = the page older than that email id, `before` = the page
   * newer than it. The cursor email anchors the full byTeam sort key
   * (createdAt, emailId), so same-instant sends neither repeat nor skip.
   * Returns undefined when the cursor id is not one of the team's emails.
   */
  async listEmailsByCursor(
    teamId: string,
    limit: number,
    cursor: { after?: string | undefined; before?: string | undefined } = {},
  ): Promise<{ emails: StoredEmail[]; hasMore: boolean } | undefined> {
    const anchorId = cursor.after ?? cursor.before;
    let anchor: StoredEmail | undefined;
    if (anchorId !== undefined) {
      anchor = await this.getEmail(teamId, anchorId);
      if (!anchor) return undefined;
    }
    const byTeam = this.deps.emails.query.byTeam({ teamId });
    const anchorKey = anchor && { createdAt: anchor.createdAt, emailId: anchor.emailId };
    const query =
      anchorKey === undefined
        ? byTeam
        : cursor.after !== undefined
          ? byTeam.lt(anchorKey)
          : byTeam.gt(anchorKey);
    // `count` keeps ElectroDB reading until limit+1 matches survive the
    // direction filter, so the extra row is an exact has_more signal.
    const result = await query
      .where((attr, op) => op.eq(attr.direction, "outbound"))
      .go({ count: limit + 1, order: cursor.before !== undefined ? "asc" : "desc" });
    const rows = result.data as StoredEmail[];
    const page = rows.slice(0, limit);
    return {
      emails: cursor.before !== undefined ? page.reverse() : page,
      hasMore: rows.length > limit,
    };
  }

  /** The event timeline for one email, oldest-first (SPEC §13.3). */
  async listEvents(teamId: string, emailId: string): Promise<EmailTimelineEvent[]> {
    const email = await this.getEmail(teamId, emailId);
    if (!email || !this.deps.events) return [];
    const result = await this.deps.events.query.byEmail({ emailId }).go({ pages: "all" });
    return (result.data as Array<{ type: string; occurredAt: string; payload?: unknown }>)
      .map((event) => ({
        type: event.type,
        occurredAt: event.occurredAt,
        ...(event.payload === undefined ? {} : { payload: event.payload }),
      }))
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  /** GET /emails/receiving/:id — inbound emails only (SPEC §5.14). */
  async getInboundEmail(teamId: string, emailId: string): Promise<StoredEmail | undefined> {
    const email = await this.getEmail(teamId, emailId);
    return email && email.direction === "inbound" ? email : undefined;
  }

  /** Dashboard suppression list, newest-first (SPEC §13). */
  async listSuppressions(
    teamId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ suppressions: StoredSuppression[]; cursor: string | null }> {
    const result = await this.deps.suppressions.query
      .byTeam({ teamId })
      .go({ limit, order: "desc", ...(cursor ? { cursor } : {}) });
    return {
      suppressions: result.data as StoredSuppression[],
      cursor: result.cursor ?? null,
    };
  }

  async getSuppression(teamId: string, email: string): Promise<StoredSuppression | undefined> {
    const result = await this.deps.suppressions.get({ teamId, email: email.toLowerCase() }).go();
    return (result.data as StoredSuppression | null) ?? undefined;
  }

  /** Manual suppression (dashboard). Bounce/complaint entries come from the
   * event processor; this is the operator adding an address by hand. */
  async addSuppression(teamId: string, email: string): Promise<StoredSuppression> {
    const normalized = email.toLowerCase();
    const existing = await this.getSuppression(teamId, normalized);
    if (existing) {
      throw new SuppressionExistsError(`${normalized} is already on the suppression list`);
    }
    const suppression: StoredSuppression = {
      teamId,
      email: normalized,
      reason: "manual",
      createdAt: this.deps.clock().toISOString(),
    };
    await this.deps.suppressions.create(suppression).go();
    await this.deps.emitter.emit(teamId, {
      type: "suppression.added",
      data: { email: normalized, reason: "manual", created_at: suppression.createdAt },
    });
    return suppression;
  }

  async removeSuppression(teamId: string, email: string): Promise<boolean> {
    const existing = await this.getSuppression(teamId, email);
    if (!existing) return false;
    await this.deps.suppressions.delete({ teamId, email: existing.email }).go();
    await this.deps.emitter.emit(teamId, {
      type: "suppression.removed",
      data: {
        email: existing.email,
        reason: existing.reason,
        created_at: this.deps.clock().toISOString(),
      },
    });
    return true;
  }

  /**
   * Dashboard metrics (SPEC §13): outbound volume and outcomes over a trailing
   * window, bucketed by UTC day and grouped by sending domain. Aggregates the
   * emails' final status (`delivered`/`complained` imply the inbox was
   * reached), scanning the byTeam range once with a thin projection — fine at
   * single-instance volume; revisit with pre-aggregated counters if teams
   * reach millions of sends per window.
   */
  async metricsSummary(teamId: string, days: number, domain?: string): Promise<MetricsSummary> {
    const end = this.deps.clock();
    const start = new Date(end.getTime() - days * 86_400_000);
    start.setUTCHours(0, 0, 0, 0);

    const result = await this.deps.emails.query
      .byTeam({ teamId })
      .between({ createdAt: start.toISOString() }, { createdAt: "￿" })
      .go({ pages: "all", attributes: ["status", "createdAt", "from", "to", "direction"] });

    const daily = new Map<string, MetricsDay>();
    for (let ts = start.getTime(); ts <= end.getTime(); ts += 86_400_000) {
      const date = new Date(ts).toISOString().slice(0, 10);
      daily.set(date, {
        date,
        sent: 0,
        delivered: 0,
        bounced: 0,
        complained: 0,
        failed: 0,
        received: 0,
      });
    }
    const domains = new Map<string, MetricsDomain>();
    const domainRow = (name: string): MetricsDomain => {
      const existing = domains.get(name);
      if (existing) return existing;
      const created = {
        domain: name,
        sent: 0,
        delivered: 0,
        bounced: 0,
        complained: 0,
        received: 0,
      };
      domains.set(name, created);
      return created;
    };
    const totals = {
      sent: 0,
      attempted: 0,
      delivered: 0,
      bounced: 0,
      complained: 0,
      failed: 0,
      received: 0,
    };

    for (const row of result.data as Pick<
      StoredEmail,
      "status" | "createdAt" | "from" | "to" | "direction"
    >[]) {
      const day = daily.get(row.createdAt.slice(0, 10));

      if (row.direction === "inbound") {
        // Inbound attributes to the recipient domain — the team's own domain.
        const recipientDomain = senderDomain(row.to[0] ?? "");
        if (domain && recipientDomain !== domain) continue;
        totals.received += 1;
        domainRow(recipientDomain).received += 1;
        if (day) day.received += 1;
        continue;
      }

      const fromDomain = senderDomain(row.from);
      if (domain && fromDomain !== domain) continue;
      const perDomain = domainRow(fromDomain);

      totals.sent += 1;
      perDomain.sent += 1;
      if (day) day.sent += 1;

      // queued/scheduled/canceled never reached the provider; everything else
      // was attempted and lands in the rate denominators.
      if (!["queued", "scheduled", "canceled"].includes(row.status)) totals.attempted += 1;
      if (row.status === "delivered" || row.status === "complained") {
        totals.delivered += 1;
        perDomain.delivered += 1;
        if (day) day.delivered += 1;
      }
      if (row.status === "complained") {
        totals.complained += 1;
        perDomain.complained += 1;
        if (day) day.complained += 1;
      }
      if (row.status === "bounced") {
        totals.bounced += 1;
        perDomain.bounced += 1;
        if (day) day.bounced += 1;
      }
      if (row.status === "failed") {
        totals.failed += 1;
        if (day) day.failed += 1;
      }
    }

    return {
      start: start.toISOString(),
      end: end.toISOString(),
      totals,
      daily: [...daily.values()],
      domains: [...domains.values()].sort((a, b) => b.sent + b.received - (a.sent + a.received)),
    };
  }

  async updateScheduledAt(email: StoredEmail, scheduledAt: string): Promise<void> {
    if (email.status !== "scheduled") {
      throw new SendRejectedError(
        422,
        "validation_error",
        "Only scheduled emails can be rescheduled.",
      );
    }
    await this.deps.scheduler.updateSchedule(
      scheduleNameFor(email.emailId),
      new Date(scheduledAt),
      {
        emailId: email.emailId,
      },
    );
    await this.deps.emails.patch({ emailId: email.emailId }).set({ scheduledAt }).go();
  }

  async cancel(email: StoredEmail): Promise<void> {
    const next = (() => {
      try {
        return transition(email.status, "canceled");
      } catch {
        throw new SendRejectedError(
          422,
          "validation_error",
          "Emails can only be canceled while scheduled.",
        );
      }
    })();
    await this.deps.scheduler.deleteSchedule(scheduleNameFor(email.emailId));
    await this.deps.emails.patch({ emailId: email.emailId }).set({ status: next }).go();
  }

  /**
   * scheduled-sender entry (SPEC §10): re-runs the pipeline checks at fire
   * time, sends, and transitions scheduled → sent. Idempotent — a re-fired
   * schedule finds the email no longer `scheduled` and does nothing.
   */
  async sendScheduled(emailId: string): Promise<"sent" | "skipped"> {
    const record = await this.deps.emails.get({ emailId }).go();
    const email = (record.data as StoredEmail | null) ?? undefined;
    if (email?.status !== "scheduled") return "skipped";

    const request: SendRequest = {
      from: email.from,
      to: email.to,
      cc: email.cc ?? [],
      bcc: email.bcc ?? [],
      replyTo: email.replyTo ?? [],
      subject: email.subject,
      ...(email.html === undefined ? {} : { html: email.html }),
      ...(email.text === undefined ? {} : { text: email.text }),
      headers: {},
      tags: email.tags ?? [],
      attachments: [],
    };

    try {
      const domain = await this.verifiedDomainFor(email.teamId, email.from);
      await this.checkSuppressions(email.teamId, request);
      const team = await this.deps.teams.getTeam(email.teamId);
      if (!team) throw new Error(`team ${email.teamId} has no Team record`);

      const attachments: ResolvedAttachment[] = [];
      for (const meta of email.attachments ?? []) {
        const content = await this.deps.blobs.get(meta.blobKey);
        if (content) {
          attachments.push({
            filename: meta.filename,
            content,
            contentType: meta.contentType,
            contentId: meta.contentId,
          });
        }
      }
      const content =
        attachments.length > 0
          ? await buildRawMime(request, attachments)
          : buildSimpleContent(request);

      const { providerMessageId } = await this.deps.emailProvider.sendEmail({
        from: email.from,
        to: email.to,
        cc: request.cc,
        bcc: request.bcc,
        replyTo: request.replyTo,
        subject: email.subject,
        content,
        tenantName: team.sesTenantName,
        configurationSetName: domain.configurationSetName,
        tags: sesTagsFor(emailId, email.teamId, request.tags),
      });

      await this.deps.emails
        .patch({ emailId })
        .set({
          status: transition("scheduled", "sent"),
          sesMessageId: providerMessageId,
          messageId: `<${providerMessageId}@email.amazonses.com>`,
        })
        .go();
      await this.deps.emitter.emit(email.teamId, {
        type: "email.sent",
        emailId,
        data: outboundEmailEventData({
          ...email,
          messageId: `<${providerMessageId}@email.amazonses.com>`,
        }),
      });
      // Count the reputation/metric send now, at real send time (§12) — the
      // send() path deferred it for scheduled emails.
      await this.deps.reputation?.recordSends(
        email.teamId,
        request.to.length + request.cc.length + request.bcc.length,
      );
      return "sent";
    } catch (error) {
      await this.deps.emails
        .patch({ emailId })
        .set({ status: transition("scheduled", "failed") })
        .go();
      await this.deps.emitter.emit(email.teamId, {
        type: "email.failed",
        emailId,
        data: {
          ...outboundEmailEventData(email),
          failed: { reason: error instanceof Error ? error.message : "send_failed" },
        },
      });
      return "skipped";
    }
  }

  async attachmentDownloadUrl(
    attachment: StoredAttachmentMeta,
    expiresInSeconds: number,
  ): Promise<string> {
    return this.deps.blobs.presignGet(attachment.blobKey, expiresInSeconds, attachment.filename);
  }
}
