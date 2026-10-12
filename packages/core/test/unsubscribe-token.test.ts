import { describe, expect, it } from "vitest";
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../src/broadcasts/unsubscribe-token.js";

const secret = "unsub-secret-unsub-secret-unsub-secret";
const payload = {
  contactId: "e46e5d30-2fba-402f-881e-0b49a7d5f9cb",
  segmentId: "d1ef2c68-e254-431c-a96d-40eabcf623d1",
  broadcastId: "b1000000-0000-4000-8000-000000000001",
};

describe("unsubscribe token (SPEC §11.2)", () => {
  it("round-trips a signed payload", () => {
    const token = signUnsubscribeToken(payload, secret);
    expect(token).toContain(".");
    expect(verifyUnsubscribeToken(token, secret)).toEqual(payload);
  });

  it("rejects a tampered body", () => {
    const token = signUnsubscribeToken(payload, secret);
    const [body, sig] = token.split(".");
    const tampered = `${body}x.${sig}`;
    expect(verifyUnsubscribeToken(tampered, secret)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = signUnsubscribeToken(payload, secret);
    const [body, sig] = token.split(".");
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    expect(verifyUnsubscribeToken(`${body}.${flipped}`, secret)).toBeNull();
  });

  it("rejects the wrong secret", () => {
    const token = signUnsubscribeToken(payload, secret);
    expect(verifyUnsubscribeToken(token, "a-different-secret-of-the-same-ish-len")).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyUnsubscribeToken("no-dot-here", secret)).toBeNull();
    expect(verifyUnsubscribeToken("", secret)).toBeNull();
  });
});
