import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed one-click unsubscribe token (SPEC §11.2). Long-lived (no expiry) and
 * self-contained so the public endpoint can verify without a DB lookup:
 * `base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload))`.
 */
export interface UnsubscribeTokenPayload {
  contactId: string;
  segmentId: string;
  broadcastId: string;
}

function base64url(input: Buffer): string {
  return input.toString("base64url");
}

function sign(body: string, secret: string): string {
  return base64url(createHmac("sha256", secret).update(body).digest());
}

export function signUnsubscribeToken(payload: UnsubscribeTokenPayload, secret: string): string {
  const body = base64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${sign(body, secret)}`;
}

export function verifyUnsubscribeToken(
  token: string,
  secret: string,
): UnsubscribeTokenPayload | null {
  const dot = token.indexOf(".");
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = sign(body, secret);
  const provided = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (provided.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(provided, expectedBuffer)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as UnsubscribeTokenPayload).contactId === "string" &&
      typeof (parsed as UnsubscribeTokenPayload).segmentId === "string" &&
      typeof (parsed as UnsubscribeTokenPayload).broadcastId === "string"
    ) {
      const { contactId, segmentId, broadcastId } = parsed as UnsubscribeTokenPayload;
      return { contactId, segmentId, broadcastId };
    }
    return null;
  } catch {
    return null;
  }
}
