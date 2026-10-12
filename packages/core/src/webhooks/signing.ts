import { createHmac, randomBytes } from "node:crypto";

/**
 * Svix-identical signing (SPEC §8.3, R02 §4): secret `whsec_<base64>` whose
 * decoded bytes are the raw HMAC key; signed content `${id}.${ts}.${body}`;
 * header value `v1,<base64(hmacSha256)>`. Verified against the official
 * `svix` npm library in tests.
 */

export function generateSigningSecret(): string {
  return `whsec_${randomBytes(24).toString("base64")}`;
}

export function signWebhookPayload(
  signingSecret: string,
  svixId: string,
  timestampSeconds: number,
  body: string,
): string {
  const encoded = signingSecret.slice("whsec_".length);
  const key = Buffer.from(encoded, "base64");
  const signedContent = `${svixId}.${timestampSeconds}.${body}`;
  const signature = createHmac("sha256", key).update(signedContent).digest("base64");
  return `v1,${signature}`;
}
