import { toWireTimestamp } from "../wire.js";

/**
 * Wire serialization for the email object, fixture-34-exact: `last_event`
 * (never `status`), absent recipients are null (not []), `text` auto-derived
 * from html when only html was sent, Postgres-style created_at.
 */

export interface StoredEmailView {
  emailId: string;
  from: string;
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  replyTo?: string[] | undefined;
  subject: string;
  html?: string | undefined;
  text?: string | undefined;
  status: string;
  scheduledAt?: string | undefined;
  messageId?: string | undefined;
  createdAt: string;
}

/**
 * Close enough to upstream's derivation for the observed fixtures: strip
 * tags, decode the common entities, collapse whitespace.
 */
export function deriveTextFromHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function toWireEmail(email: StoredEmailView): Record<string, unknown> {
  return {
    object: "email",
    id: email.emailId,
    to: email.to,
    from: email.from,
    created_at: toWireTimestamp(new Date(email.createdAt)),
    subject: email.subject,
    bcc: email.bcc && email.bcc.length > 0 ? email.bcc : null,
    cc: email.cc && email.cc.length > 0 ? email.cc : null,
    reply_to: email.replyTo && email.replyTo.length > 0 ? email.replyTo : null,
    last_event: email.status,
    scheduled_at: email.scheduledAt ? toWireTimestamp(new Date(email.scheduledAt)) : null,
    message_id: email.messageId ?? null,
    html: email.html ?? null,
    text: email.text ?? (email.html ? deriveTextFromHtml(email.html) : null),
  };
}
