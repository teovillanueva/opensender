import type { EmailStatus } from "../emails/state-machine.js";

/**
 * Anti-corruption layer (SPEC §8.1): the ONLY code that knows SES event
 * shapes. Pure — takes the EventBridge `detail` (the SES event record) and
 * returns our domain terms.
 */

export interface SesMail {
  messageId: string;
  timestamp?: string;
  tags?: Record<string, string[]>;
}

export interface SesEventDetail {
  eventType: string;
  mail: SesMail;
  [key: string]: unknown;
}

export interface MappedSesEvent {
  /** Resend event type, e.g. email.delivered. SEND maps to null (ignored). */
  resendType: string | null;
  /** Status the email transitions to, when the event carries one. */
  newStatus?: EmailStatus;
  /** Extra payload block merged into the webhook data (bounce, click, ...). */
  extras: Record<string, unknown>;
  /** Hard bounce or complaint ⇒ recipients to suppress (SPEC §8.1). */
  suppress?: { reason: "hard_bounce" | "complaint"; recipients: string[] };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function mapSesEvent(detail: SesEventDetail): MappedSesEvent {
  switch (detail.eventType) {
    // We emit email.sent ourselves at send time (SPEC §6.6).
    case "Send":
      return { resendType: null, extras: {} };

    case "Delivery":
      return { resendType: "email.delivered", newStatus: "delivered", extras: {} };

    case "DeliveryDelay": {
      const delay = asRecord(detail.deliveryDelay);
      return {
        resendType: "email.delivery_delayed",
        newStatus: "delivery_delayed",
        extras: { delay_type: delay.delayType ?? null },
      };
    }

    case "Bounce": {
      const bounce = asRecord(detail.bounce);
      const recipients = (
        Array.isArray(bounce.bouncedRecipients) ? bounce.bouncedRecipients : []
      ).map((entry) => asRecord(entry));
      const diagnosticCodes = recipients
        .map((recipient) => recipient.diagnosticCode)
        .filter((code): code is string => typeof code === "string");
      const isHard = bounce.bounceType === "Permanent";
      return {
        resendType: "email.bounced",
        newStatus: "bounced",
        extras: {
          bounce: {
            type: bounce.bounceType ?? "Undetermined",
            subType: bounce.bounceSubType ?? "Undetermined",
            message:
              diagnosticCodes[0] ??
              `The email bounced (${bounce.bounceType ?? "Undetermined"}/${bounce.bounceSubType ?? "Undetermined"}).`,
            diagnosticCode: diagnosticCodes,
          },
        },
        // Only hard bounces suppress; SES already limits published soft
        // bounces to retries-exhausted ones (R03 §3.4).
        ...(isHard
          ? {
              suppress: {
                reason: "hard_bounce" as const,
                recipients: recipients
                  .map((recipient) => recipient.emailAddress)
                  .filter((address): address is string => typeof address === "string"),
              },
            }
          : {}),
      };
    }

    case "Complaint": {
      const complaint = asRecord(detail.complaint);
      const recipients = (
        Array.isArray(complaint.complainedRecipients) ? complaint.complainedRecipients : []
      ).map((entry) => asRecord(entry));
      return {
        resendType: "email.complained",
        newStatus: "complained",
        extras: {},
        suppress: {
          reason: "complaint",
          recipients: recipients
            .map((recipient) => recipient.emailAddress)
            .filter((address): address is string => typeof address === "string"),
        },
      };
    }

    case "Reject":
      return {
        resendType: "email.failed",
        newStatus: "failed",
        extras: { failed: { reason: asRecord(detail.reject).reason ?? "rejected" } },
      };

    // The event object key is `failure`, not `renderingFailure` (R03 §3.4).
    case "Rendering Failure":
    case "RenderingFailure": {
      const failure = asRecord(detail.failure);
      return {
        resendType: "email.failed",
        newStatus: "failed",
        extras: { failed: { reason: failure.errorMessage ?? "rendering_failure" } },
      };
    }

    case "Open": {
      const open = asRecord(detail.open);
      return {
        resendType: open.isBotEvent === true ? null : "email.opened",
        extras: {},
      };
    }

    case "Click": {
      const click = asRecord(detail.click);
      if (click.isBotEvent === true) return { resendType: null, extras: {} };
      return {
        resendType: "email.clicked",
        extras: {
          click: {
            ipAddress: click.ipAddress ?? "",
            link: click.link ?? "",
            timestamp: click.timestamp ?? "",
            userAgent: click.userAgent ?? "",
          },
        },
      };
    }

    case "Subscription":
      // Broadcast unsubscribe handling lands at M7 with broadcasts.
      return { resendType: null, extras: {} };

    default:
      return { resendType: null, extras: {} };
  }
}

/** `mail.tags` is map<string, string[]> (R03 §3.3). */
export function emailIdFromTags(mail: SesMail): string | undefined {
  return mail.tags?.email_id?.[0];
}
