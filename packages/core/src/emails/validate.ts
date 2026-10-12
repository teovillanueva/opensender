/**
 * POST /emails body validation, fixture-exact (05-10): check order and every
 * message replicate the captured wire behavior. Returns a normalized send
 * request or a typed error carrying the fixture's status/name/message.
 */

export class SendValidationError extends Error {
  constructor(
    readonly statusCode: number,
    readonly errorName: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SendRequest {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  html?: string;
  text?: string;
  headers: Record<string, string>;
  tags: Array<{ name: string; value: string }>;
  attachments: AttachmentInput[];
  scheduledAt?: string;
}

interface AttachmentInput {
  filename: string;
  content?: string;
  path?: string;
  contentType?: string;
  /** `cid:` reference for inline embedding (angle brackets stripped). */
  contentId?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** `email@example.com` or `Name <email@example.com>` (fixture 07 message). */
function isValidFromAddress(value: string): boolean {
  const bracketed = value.match(/^.*<([^<>]+)>$/);
  const address = bracketed?.[1] ?? value;
  return EMAIL_PATTERN.test(address.trim());
}

function invalid(message: string): SendValidationError {
  return new SendValidationError(422, "validation_error", message);
}

function recipientList(value: unknown, field: string, required: boolean): string[] {
  if (value === undefined || value === null) {
    if (required) {
      throw new SendValidationError(422, "missing_required_field", `Missing \`${field}\` field.`);
    }
    return [];
  }
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    if (!value.every((entry) => typeof entry === "string")) {
      throw invalid(`The \`${field}\` field must be a \`string\`.`);
    }
    return value;
  }
  throw invalid(`The \`${field}\` field must be a \`string\`.`);
}

export function validateSendRequest(body: unknown): SendRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new SendValidationError(422, "missing_required_field", "Missing `to` field.");
  }
  const input = body as Record<string, unknown>;

  // Fixture order: `to` first (05, 09), then `from` (06/07), then content (08).
  const to = recipientList(input.to, "to", true);
  if (to.length === 0) {
    throw new SendValidationError(422, "missing_required_field", "Missing `to` field.");
  }
  if (to.length > 50) throw invalid("The `to` field can have a maximum of 50 recipients.");

  if (typeof input.from !== "string" || input.from.length === 0) {
    throw invalid("Missing `from` field.");
  }
  if (!isValidFromAddress(input.from)) {
    throw invalid(
      "Invalid `from` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.",
    );
  }

  const subject = typeof input.subject === "string" ? input.subject : "";

  const html = typeof input.html === "string" && input.html.length > 0 ? input.html : undefined;
  const text = typeof input.text === "string" && input.text.length > 0 ? input.text : undefined;
  if (!html && !text) throw invalid("Missing `html` or `text` field.");

  const attachments: AttachmentInput[] = [];
  if (input.attachments !== undefined) {
    if (!Array.isArray(input.attachments)) {
      throw invalid("The `attachments` field must be an array.");
    }
    for (const entry of input.attachments) {
      const attachment = entry as Record<string, unknown>;
      const filename = typeof attachment.filename === "string" ? attachment.filename : "";
      const content = typeof attachment.content === "string" ? attachment.content : undefined;
      const path = typeof attachment.path === "string" ? attachment.path : undefined;
      if (!content && !path) {
        throw new SendValidationError(
          422,
          "invalid_attachment",
          "Attachments must have either `content` or `path`.",
        );
      }
      attachments.push({
        filename: filename || "attachment",
        ...(content === undefined ? {} : { content }),
        ...(path === undefined ? {} : { path }),
        ...(typeof attachment.content_type === "string"
          ? { contentType: attachment.content_type }
          : {}),
        ...(typeof attachment.content_id === "string" &&
        attachment.content_id.replace(/[<>]/g, "").length > 0
          ? { contentId: attachment.content_id.replace(/[<>]/g, "") }
          : {}),
      });
    }
  }

  const tags: Array<{ name: string; value: string }> = [];
  if (Array.isArray(input.tags)) {
    for (const entry of input.tags) {
      const tag = entry as Record<string, unknown>;
      if (typeof tag.name === "string" && typeof tag.value === "string") {
        tags.push({ name: tag.name, value: tag.value });
      }
    }
  }

  return {
    from: input.from,
    to,
    cc: recipientList(input.cc, "cc", false),
    bcc: recipientList(input.bcc, "bcc", false),
    replyTo: recipientList(input.reply_to, "reply_to", false),
    subject,
    ...(html === undefined ? {} : { html }),
    ...(text === undefined ? {} : { text }),
    headers:
      input.headers && typeof input.headers === "object" && !Array.isArray(input.headers)
        ? Object.fromEntries(
            Object.entries(input.headers as Record<string, unknown>).map(([k, v]) => [
              k,
              String(v),
            ]),
          )
        : {},
    tags,
    attachments,
    ...(typeof input.scheduled_at === "string" ? { scheduledAt: input.scheduled_at } : {}),
  };
}
