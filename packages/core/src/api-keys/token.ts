import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * API-key token handling (SPEC §16): `re_` + 32 crypto-random base62 chars,
 * stored only as a SHA-256 hash, compared in constant time. The plaintext
 * token exists exactly once — in the create response.
 */

const TOKEN_PREFIX = "re_";
const TOKEN_RANDOM_LENGTH = 32;
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function generateToken(): string {
  // Rejection sampling keeps the distribution uniform over the alphabet.
  let out = "";
  while (out.length < TOKEN_RANDOM_LENGTH) {
    for (const byte of randomBytes(TOKEN_RANDOM_LENGTH)) {
      if (byte < 248 && out.length < TOKEN_RANDOM_LENGTH) {
        out += BASE62[byte % 62] as string;
      }
    }
  }
  return TOKEN_PREFIX + out;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time equality of two hex digests. */
export function hashesEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "hex");
  const bufferB = Buffer.from(b, "hex");
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

export function looksLikeToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX);
}
