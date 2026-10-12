import { createHash } from "node:crypto";
import {
  type Broadcast,
  type Contact,
  createSuppressionEntity,
  type MergeContext,
  renderMergeTags,
  type SendRequest,
  signUnsubscribeToken,
} from "@opensender/core";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import {
  apiBaseUrl,
  createBroadcastFanoutPublisher,
  createBroadcastsService,
  createContactsService,
  createEmailsService,
  dynamo,
  getUnsubscribeSecret,
  table,
} from "./context.js";
import { logger, withObservability } from "./observability.js";
import { withSentry } from "./sentry.js";

const broadcasts = createBroadcastsService();
const contacts = createContactsService();
const emails = createEmailsService();
const publisher = createBroadcastFanoutPublisher();
const suppressions = createSuppressionEntity({ client: dynamo, table });

/** Recipients per page message; keeps each page invocation well under the timeout. */
const PAGE_SIZE = 50;

/**
 * SES account send-rate cap (SPEC §20 `sesMaxSendRatePerSecond`, injected by
 * sst.config). Must match the broadcastFanout `maximumConcurrency` in
 * sst.config.ts so `rate / concurrency` is this Lambda's fair share: pacing each
 * container to that share keeps the fleet's aggregate under the account cap and
 * stops SES `TooManyRequestsException` from failing a page.
 */
const SES_MAX_SEND_RATE = Number(process.env.SES_MAX_SEND_RATE ?? "14");
const FANOUT_MAX_CONCURRENCY = 10;
const MIN_SEND_INTERVAL_MS = Math.ceil((FANOUT_MAX_CONCURRENCY / SES_MAX_SEND_RATE) * 1000);
const MAX_SEND_ATTEMPTS = 5;

/** Container-scoped pacer: space this Lambda's SES sends by the fair-share
 * interval. Serialized per invocation (recipients send sequentially). */
let nextSendAt = 0;
async function paceSend(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextSendAt - now);
  nextSendAt = Math.max(now, nextSendAt) + MIN_SEND_INTERVAL_MS;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

function isThrottle(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? "";
  return /throttl|toomanyrequests|limitexceeded/i.test(name);
}

/** Deterministic per-recipient id so a redelivered page is idempotent: the
 * shared send pipeline finds the already-persisted row and skips the re-send
 * (mirrors the event-processor's deterministic eventId). */
function deterministicEmailId(broadcastId: string, contactId: string): string {
  return createHash("sha256").update(`${broadcastId}|${contactId}`).digest("hex").slice(0, 32);
}

interface StartMessage {
  kind: "start";
  broadcastId: string;
  teamId: string;
}
interface PageMessage {
  kind: "page";
  broadcastId: string;
  teamId: string;
  contactIds: string[];
}
type FanoutMessage = StartMessage | PageMessage;

/**
 * Broadcast fan-out consumer (SPEC §11). Two message kinds share the queue:
 * `start` expands a segment into `page` messages; `page` renders and sends one
 * batch of recipients through the ordinary EmailsService pipeline. At-least-once
 * delivery — a redelivered page can re-send its recipients (see docs/sending-email.md).
 */
async function handlerImpl(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records) {
    let message: FanoutMessage;
    try {
      message = JSON.parse(record.body) as FanoutMessage;
    } catch {
      logger.error("malformed message dropped");
      continue;
    }
    try {
      if (message.kind === "start") {
        await handleStart(message);
      } else if (message.kind === "page") {
        await handlePage(message);
      } else {
        logger.error("unknown message kind");
      }
    } catch (error) {
      logger.error("processing failed", { error });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}

export const handler = withSentry(withObservability(handlerImpl));

/**
 * Expand the segment: mark the broadcast `sending`, drop team-suppressed and
 * unsubscribed recipients, then enqueue one `page` message per PAGE_SIZE chunk.
 */
async function handleStart(message: StartMessage): Promise<void> {
  const broadcast = await broadcasts.get(message.teamId, message.broadcastId);
  if (!broadcast) {
    logger.warn("start for missing broadcast", { broadcastId: message.broadcastId });
    return;
  }
  // A redelivered `start` for an already-completed broadcast is a no-op. For
  // "sending" we still re-expand: per-recipient sends are idempotent (see
  // deterministicEmailId), so a re-fan-out re-sends to nobody, and re-enqueuing
  // is preferable to leaving a broadcast stuck if the first `start` crashed
  // after markStatus but before it finished enqueuing pages.
  if (broadcast.status === "sent") return;
  await broadcasts.markStatus(broadcast.broadcastId, "sending");

  const suppressed = await suppressedEmails(message.teamId);
  const sendable = (await contacts.listSendable(broadcast.segmentId)).filter(
    (contact) => !suppressed.has(contact.email.toLowerCase()),
  );

  const pages: string[][] = [];
  for (let offset = 0; offset < sendable.length; offset += PAGE_SIZE) {
    pages.push(sendable.slice(offset, offset + PAGE_SIZE).map((c) => c.contactId));
  }

  // No recipients ⇒ nothing to page; the broadcast is already done. Otherwise
  // record the page count BEFORE enqueuing so the first page to finish sees it.
  if (pages.length === 0) {
    await broadcasts.markStatus(broadcast.broadcastId, "sent");
    return;
  }
  await broadcasts.setPendingPages(broadcast.broadcastId, pages.length);
  for (const contactIds of pages) {
    await publisher.enqueue({
      kind: "page",
      broadcastId: broadcast.broadcastId,
      teamId: message.teamId,
      contactIds,
    });
  }
}

/** Render and send one batch of recipients through the shared send pipeline. */
async function handlePage(message: PageMessage): Promise<void> {
  const broadcast = await broadcasts.get(message.teamId, message.broadcastId);
  if (!broadcast) {
    logger.warn("page for missing broadcast", { broadcastId: message.broadcastId });
    return;
  }
  const fromDomain = domainOf(broadcast.from);
  for (const contactId of message.contactIds) {
    const contact = await contacts.getByIdOrEmail(message.teamId, broadcast.segmentId, contactId);
    // Re-check unsubscribe at send time: state may have changed since fan-out.
    if (!contact || contact.unsubscribed) continue;
    await sendToContact(broadcast, contact, fromDomain);
  }
  // The page that drains the outstanding-page counter finishes the broadcast.
  const remaining = await broadcasts.completePage(broadcast.broadcastId);
  if (remaining <= 0) {
    await broadcasts.markStatus(broadcast.broadcastId, "sent");
  }
}

async function sendToContact(
  broadcast: Broadcast,
  contact: Contact,
  fromDomain: string,
): Promise<void> {
  const token = signUnsubscribeToken(
    {
      contactId: contact.contactId,
      segmentId: broadcast.segmentId,
      broadcastId: broadcast.broadcastId,
    },
    getUnsubscribeSecret(),
  );
  const unsubscribeUrl = `${apiBaseUrl}/unsubscribe/${token}`;

  const mergeContext: MergeContext = {
    contact: {
      email: contact.email,
      ...(contact.firstName === undefined ? {} : { firstName: contact.firstName }),
      ...(contact.lastName === undefined ? {} : { lastName: contact.lastName }),
    },
    unsubscribeUrl,
  };
  const html =
    broadcast.html === undefined ? undefined : renderMergeTags(broadcast.html, mergeContext);
  const text =
    broadcast.text === undefined ? undefined : renderMergeTags(broadcast.text, mergeContext);

  // RFC 8058 one-click unsubscribe (SPEC §11.2). Custom headers force the raw
  // MIME path in the pipeline, so both headers reach SES.
  const headers: Record<string, string> = {
    "List-Unsubscribe": `<mailto:unsubscribe@${fromDomain}>, <${unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };

  const request: SendRequest = {
    from: broadcast.from,
    to: [contact.email],
    cc: [],
    bcc: [],
    replyTo: broadcast.replyTo === undefined ? [] : [broadcast.replyTo],
    subject: broadcast.subject,
    ...(html === undefined ? {} : { html }),
    ...(text === undefined ? {} : { text }),
    headers,
    tags: [],
    attachments: [],
  };

  // enforceSync:false — a suppressed/unverified recipient is recorded failed
  // instead of throwing, so one bad recipient never fails the whole page.
  // broadcastId tags the email so delivery events roll up to broadcast stats.
  // emailId is deterministic so an at-least-once redelivery is idempotent.
  const emailId = deterministicEmailId(broadcast.broadcastId, contact.contactId);

  // Retry only SES throttling (paced below the account cap, but bursts still
  // happen). Each retry re-enters the idempotent send, so it never duplicates.
  let result: Awaited<ReturnType<typeof emails.send>> | undefined;
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
    await paceSend();
    try {
      result = await emails.send(broadcast.teamId, request, {
        enforceSync: false,
        broadcastId: broadcast.broadcastId,
        emailId,
      });
      break;
    } catch (error) {
      if (attempt >= MAX_SEND_ATTEMPTS || !isThrottle(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** attempt * 200, 5000)));
    }
  }
  if (!result) return;

  // Count only a fresh send; a deduped redelivery must not double-count.
  if (!result.deduped && result.email.status === "sent") {
    await broadcasts.incrementStat(broadcast.broadcastId, "sent");
  }
}

/** All team-level suppressed addresses (hard bounces, complaints, manual). */
async function suppressedEmails(teamId: string): Promise<Set<string>> {
  const result = await suppressions.query.byTeam({ teamId }).go({ pages: "all" });
  return new Set(result.data.map((row) => row.email.toLowerCase()));
}

function domainOf(from: string): string {
  const address = from.match(/<([^<>]+)>$/)?.[1] ?? from;
  return address.split("@")[1]?.toLowerCase() ?? "";
}
