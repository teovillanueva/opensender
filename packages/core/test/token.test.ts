import { describe, expect, it } from "vitest";
import { generateToken, hashesEqual, hashToken, looksLikeToken } from "../src/api-keys/token.js";

describe("api-key tokens", () => {
  it("generates re_ + 32 base62 chars", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateToken()).toMatch(/^re_[A-Za-z0-9]{32}$/);
    }
  });

  it("never repeats (crypto randomness sanity)", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateToken));
    expect(tokens.size).toBe(200);
  });

  it("hashes to sha256 hex", () => {
    expect(hashToken("re_x")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("re_x")).toBe(hashToken("re_x"));
    expect(hashToken("re_x")).not.toBe(hashToken("re_y"));
  });

  it("compares digests without throwing on length mismatch", () => {
    const digest = hashToken("re_x");
    expect(hashesEqual(digest, digest)).toBe(true);
    expect(hashesEqual(digest, hashToken("re_y"))).toBe(false);
    expect(hashesEqual(digest, "abcd")).toBe(false);
  });

  it("recognizes the re_ prefix", () => {
    expect(looksLikeToken("re_abc")).toBe(true);
    expect(looksLikeToken("sk_abc")).toBe(false);
  });
});
