import type { EmailsPort, StoredEmail } from "@opensender/core";
import { toWireTimestamp } from "@opensender/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { errors, sendJson } from "../errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTACHMENT_URL_TTL_SECONDS = 3600;

export interface ReceivingRouteDeps {
  emails: EmailsPort;
  now: () => Date;
}

/** Inbound receiving surface (SPEC §5.14). */
export function receivingRoutes(deps: ReceivingRouteDeps): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20) || 20, 1), 100);
    const { emails, cursor } = await deps.emails.listEmails(
      c.get("principal").teamId,
      limit,
      "inbound",
    );
    return sendJson(c, 200, {
      object: "list",
      has_more: cursor !== null,
      data: emails.map((email) => ({
        id: email.emailId,
        from: email.from,
        to: email.to,
        subject: email.subject,
        created_at: toWireTimestamp(new Date(email.createdAt)),
      })),
    });
  });

  app.get("/:id", async (c) => {
    const email = await requireInbound(c);
    // html/text/headers nullable; verdicts stay internal (SPEC §9.3).
    return sendJson(c, 200, {
      object: "email",
      id: email.emailId,
      from: email.from,
      to: email.to,
      cc: email.cc && email.cc.length > 0 ? email.cc : null,
      bcc: null,
      reply_to: null,
      subject: email.subject,
      message_id: email.messageId ?? null,
      html: email.html ?? null,
      text: email.text ?? null,
      headers: email.headers ?? null,
      created_at: toWireTimestamp(new Date(email.createdAt)),
      attachments: (email.attachments ?? []).map((attachment) => ({
        id: attachment.attachmentId,
        filename: attachment.filename,
        content_type: attachment.contentType ?? "application/octet-stream",
        size: attachment.sizeBytes,
      })),
    });
  });

  app.get("/:id/attachments", async (c) => {
    const email = await requireInbound(c);
    const data = await Promise.all(
      (email.attachments ?? []).map((attachment) => wireAttachment(attachment)),
    );
    return sendJson(c, 200, { object: "list", has_more: false, data });
  });

  app.get("/:id/attachments/:attachmentId", async (c) => {
    const email = await requireInbound(c);
    const attachment = (email.attachments ?? []).find(
      (entry) => entry.attachmentId === (c.req.param("attachmentId") ?? ""),
    );
    if (!attachment) throw errors.notFound("Attachment not found");
    return sendJson(c, 200, await wireAttachment(attachment));
  });

  async function requireInbound(c: Context): Promise<StoredEmail> {
    const id = c.req.param("id") ?? "";
    if (!UUID_PATTERN.test(id)) {
      throw errors.invalidParameter("The `id` must be a valid UUID.");
    }
    const email = await deps.emails.getInboundEmail(c.get("principal").teamId, id);
    if (!email) throw errors.notFound("Received email not found");
    return email;
  }

  async function wireAttachment(attachment: NonNullable<StoredEmail["attachments"]>[number]) {
    const expiresAt = new Date(deps.now().getTime() + ATTACHMENT_URL_TTL_SECONDS * 1000);
    return {
      object: "attachment",
      id: attachment.attachmentId,
      filename: attachment.filename,
      content_type: attachment.contentType ?? "application/octet-stream",
      size: attachment.sizeBytes,
      download_url: await deps.emails.attachmentDownloadUrl(attachment, ATTACHMENT_URL_TTL_SECONDS),
      expires_at: toWireTimestamp(expiresAt),
    };
  }

  return app;
}
