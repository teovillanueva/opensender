/**
 * Email status state machine (SPEC §2.1): every status update goes through
 * transition(); the map IS the specification of what can follow what.
 */

export type EmailStatus =
  | "queued"
  | "scheduled"
  | "sent"
  | "delivered"
  | "delivery_delayed"
  | "bounced"
  | "complained"
  | "failed"
  | "canceled"
  | "received";

const VALID_TRANSITIONS: Record<EmailStatus, EmailStatus[]> = {
  queued: ["sent", "failed"],
  scheduled: ["queued", "sent", "canceled", "failed"],
  sent: ["delivered", "delivery_delayed", "bounced", "complained", "failed"],
  delivery_delayed: ["delivered", "bounced", "failed"],
  delivered: ["bounced", "complained"],
  bounced: [],
  complained: [],
  failed: [],
  canceled: [],
  received: [],
};

class InvalidTransitionError extends Error {
  constructor(
    readonly from: EmailStatus,
    readonly to: EmailStatus,
  ) {
    super(`invalid email status transition ${from} -> ${to}`);
  }
}

export function canTransition(from: EmailStatus, to: EmailStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function transition(from: EmailStatus, to: EmailStatus): EmailStatus {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
  return to;
}
