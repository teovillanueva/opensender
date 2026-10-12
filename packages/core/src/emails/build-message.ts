import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { detectMimeType } from "nodemailer/lib/mime-funcs/mime-types.js";
import type { OutgoingMessage } from "../ports.js";
import type { SendRequest } from "./validate.js";

/**
 * Message-construction strategy (SPEC §6.2): no attachments and no custom
 * headers ⇒ SES Content.Simple; otherwise raw MIME via mail-composer. The
 * pipeline never knows which ran.
 */

export interface ResolvedAttachment {
  filename: string;
  content: Uint8Array;
  contentType?: string | undefined;
  /** Set ⇒ an inline part (`Content-Disposition: inline` + `Content-ID`). */
  contentId?: string | undefined;
}

const GENERIC_CONTENT_TYPE = "application/octet-stream";

/**
 * The attachment's content type: the explicit one, else the source's (a
 * `path` download) unless it is the generic octet-stream, else derived from the
 * filename extension — as upstream documents for `content_type`.
 */
export function resolveContentType(
  filename: string,
  explicit?: string,
  fromSource?: string,
): string {
  if (explicit) return explicit;
  if (fromSource && fromSource !== GENERIC_CONTENT_TYPE) return fromSource;
  return detectMimeType(filename) || GENERIC_CONTENT_TYPE;
}

export function needsRawMime(request: SendRequest): boolean {
  return request.attachments.length > 0 || Object.keys(request.headers).length > 0;
}

export function buildSimpleContent(request: SendRequest): OutgoingMessage["content"] {
  return {
    kind: "simple",
    ...(request.html === undefined ? {} : { html: request.html }),
    ...(request.text === undefined ? {} : { text: request.text }),
  };
}

export async function buildRawMime(
  request: SendRequest,
  attachments: ResolvedAttachment[],
): Promise<OutgoingMessage["content"]> {
  const composer = new MailComposer({
    from: request.from,
    to: request.to,
    ...(request.cc.length ? { cc: request.cc } : {}),
    ...(request.bcc.length ? { bcc: request.bcc } : {}),
    ...(request.replyTo.length ? { replyTo: request.replyTo } : {}),
    subject: request.subject,
    ...(request.html === undefined ? {} : { html: request.html }),
    ...(request.text === undefined ? {} : { text: request.text }),
    headers: request.headers,
    attachments: attachments.map((attachment) => ({
      filename: attachment.filename,
      content: Buffer.from(attachment.content),
      ...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
      // A cid moves the part into multipart/related with an inline disposition.
      ...(attachment.contentId === undefined ? {} : { cid: attachment.contentId }),
    })),
  });
  const mime = await composer.compile().build();
  return { kind: "raw", mime };
}
