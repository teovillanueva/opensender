import { createHash } from "node:crypto";
import type { EmailEntity, SuppressionEntity } from "../adapters/dynamo-entities.js";
import type { BroadcastStatKey, BroadcastsService } from "../broadcasts/broadcasts.js";
import { outboundEmailEventData, type StoredEmail } from "../emails/emails.js";
import { canTransition } from "../emails/state-machine.js";
import type { Clock } from "../ports.js";
import type { EventsService } from "./emitter.js";
import { emailIdFromTags, mapSesEvent, type SesEventDetail } from "./ses-mapping.js";

/** Delivery-side event types that roll up into a broadcast's stats (SPEC §11). */
const BROADCAST_STAT_BY_EVENT: Record<string, BroadcastStatKey> = {
  "email.delivered": "delivered",
  "email.delivery_delayed": "delivery_delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.opened": "opened",
  "email.clicked": "clicked",
};

/**
 * event-processor (SPEC §8.1): consumes SES events, resolves the Email by
 * SES message id (GSI) with the email_id tag as fallback, applies the state
 * machine (out-of-order events keep the timeline but never regress status),
 * adds suppressions on hard bounce/complaint, and emits our events.
 * Idempotent: the timeline row id derives from the event content, so an SQS
 * redelivery cannot double-fan-out.
 */

/** Delivery outcomes that feed the reputation window (SPEC §12). */
const REPUTATION_OUTCOME_BY_EVENT: Record<string, "bounce" | "complaint"> = {
  "email.bounced": "bounce",
  "email.complained": "complaint",
};

export interface EventProcessorDeps {
  emails: EmailEntity;
  suppressions: SuppressionEntity;
  emitter: Pick<EventsService, "emit">;
  /** Optional: roll delivery events up into broadcast stats when present (§11). */
  broadcasts?: Pick<BroadcastsService, "incrementStat"> | undefined;
  /** Optional: feed bounces/complaints into the reputation auto-freeze (§12). */
  reputation?:
    | { recordOutcome(teamId: string, outcome: "bounce" | "complaint"): Promise<boolean> }
    | undefined;
  clock: Clock;
}

export class EventProcessorService {
  constructor(private readonly deps: EventProcessorDeps) {}

  async processSesEvent(detail: SesEventDetail): Promise<"processed" | "skipped"> {
    const mapped = mapSesEvent(detail);
    if (!mapped.resendType) return "skipped";

    const email = await this.resolveEmail(detail);
    if (!email) {
      console.warn(`event-processor: no email for SES message ${detail.mail.messageId}`);
      return "skipped";
    }

    // Deterministic id: one timeline row + one fan-out per distinct event.
    const eventId = createHash("sha256")
      .update(`${email.emailId}|${detail.eventType}|${detail.mail.timestamp ?? ""}`)
      .digest("hex")
      .slice(0, 32);

    if (mapped.newStatus && canTransition(email.status, mapped.newStatus)) {
      await this.deps.emails
        .patch({ emailId: email.emailId })
        .set({ status: mapped.newStatus, lastEventAt: this.deps.clock().toISOString() })
        .go();
      email.status = mapped.newStatus;
    }

    if (mapped.suppress) {
      await this.addSuppressions(email, mapped.suppress);
    }

    const emitted = await this.deps.emitter.emit(email.teamId, {
      type: mapped.resendType,
      emailId: email.emailId,
      eventId,
      data: { ...outboundEmailEventData(email), ...mapped.extras },
    });

    // Roll up into broadcast stats exactly once — gated on `emitted` so an SQS
    // redelivery (deduped by the deterministic eventId) never double-counts.
    if (emitted && email.broadcastId) {
      const statKey = BROADCAST_STAT_BY_EVENT[mapped.resendType];
      if (statKey && this.deps.broadcasts) {
        await this.deps.broadcasts.incrementStat(email.broadcastId, statKey);
      }
    }

    // Feed reputation guardrails, also gated on `emitted` so a redelivery never
    // double-counts a bounce/complaint toward the auto-freeze thresholds (§12).
    if (emitted && this.deps.reputation) {
      const outcome = REPUTATION_OUTCOME_BY_EVENT[mapped.resendType];
      if (outcome) await this.deps.reputation.recordOutcome(email.teamId, outcome);
    }

    return emitted ? "processed" : "skipped";
  }

  private async resolveEmail(detail: SesEventDetail): Promise<StoredEmail | undefined> {
    const byMessageId = await this.deps.emails.query
      .bySesMessageId({ sesMessageId: detail.mail.messageId })
      .go();
    if (byMessageId.data[0]) return byMessageId.data[0] as StoredEmail;

    const taggedId = emailIdFromTags(detail.mail);
    if (!taggedId) return undefined;
    const byId = await this.deps.emails.get({ emailId: taggedId }).go();
    return (byId.data as StoredEmail | null) ?? undefined;
  }

  private async addSuppressions(
    email: StoredEmail,
    suppress: NonNullable<ReturnType<typeof mapSesEvent>["suppress"]>,
  ): Promise<void> {
    for (const recipient of suppress.recipients) {
      const address = recipient.toLowerCase();
      try {
        await this.deps.suppressions
          .create({
            teamId: email.teamId,
            email: address,
            reason: suppress.reason,
            sourceEmailId: email.emailId,
            createdAt: this.deps.clock().toISOString(),
          })
          .go();
      } catch {
        continue; // already suppressed — no duplicate event
      }
      await this.deps.emitter.emit(email.teamId, {
        type: "suppression.added",
        data: {
          email: address,
          reason: suppress.reason,
          source_email_id: email.emailId,
          created_at: this.deps.clock().toISOString(),
        },
      });
    }
  }
}
