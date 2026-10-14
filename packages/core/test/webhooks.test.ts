import { Webhook } from "svix";
import { describe, expect, it } from "vitest";
import { mapSesEvent } from "../src/events/ses-mapping.js";
import { generateSigningSecret, signWebhookPayload } from "../src/webhooks/signing.js";

describe("svix-compatible signing (SPEC §8.3 mandatory test)", () => {
  it("verifies with the official svix library", () => {
    const secret = generateSigningSecret();
    const body = JSON.stringify({
      type: "email.sent",
      created_at: "2026-08-09T12:00:00.000Z",
      data: { email_id: "x" },
    });
    const svixId = "msg_test_1";
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signWebhookPayload(secret, svixId, timestamp, body);

    const verifier = new Webhook(secret);
    expect(() =>
      verifier.verify(body, {
        "svix-id": svixId,
        "svix-timestamp": String(timestamp),
        "svix-signature": signature,
      }),
    ).not.toThrow();

    // Tampered body must fail.
    expect(() =>
      verifier.verify(`${body} `, {
        "svix-id": svixId,
        "svix-timestamp": String(timestamp),
        "svix-signature": signature,
      }),
    ).toThrow();
  });

  it("generates whsec_-prefixed base64 secrets", () => {
    const secret = generateSigningSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/=]+$/);
    expect(Buffer.from(secret.slice(6), "base64")).toHaveLength(24);
  });
});

describe("SES event mapping (ACL, SPEC §8.1)", () => {
  const mail = { messageId: "ses-1", timestamp: "2026-08-09T12:00:00.000Z" };

  it("maps delivery, ignores Send, and respects isBotEvent", () => {
    expect(mapSesEvent({ eventType: "Delivery", mail })).toMatchObject({
      resendType: "email.delivered",
      newStatus: "delivered",
    });
    expect(mapSesEvent({ eventType: "Send", mail }).resendType).toBeNull();
    expect(
      mapSesEvent({ eventType: "Open", mail, open: { isBotEvent: true } }).resendType,
    ).toBeNull();
    expect(mapSesEvent({ eventType: "Open", mail, open: { isBotEvent: false } }).resendType).toBe(
      "email.opened",
    );
  });

  it("suppresses only hard bounces, with diagnostics", () => {
    const hard = mapSesEvent({
      eventType: "Bounce",
      mail,
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [
          { emailAddress: "gone@example.com", diagnosticCode: "smtp; 550 5.1.1 user unknown" },
        ],
      },
    });
    expect(hard.newStatus).toBe("bounced");
    expect(hard.suppress).toEqual({ reason: "hard_bounce", recipients: ["gone@example.com"] });
    expect(hard.extras.bounce).toMatchObject({
      type: "Permanent",
      diagnosticCode: ["smtp; 550 5.1.1 user unknown"],
    });
    expect(hard.reputation).toEqual({ outcome: "bounce", recipients: 1 });

    const soft = mapSesEvent({
      eventType: "Bounce",
      mail,
      bounce: {
        bounceType: "Transient",
        bounceSubType: "MailboxFull",
        bouncedRecipients: [{ emailAddress: "full@example.com" }],
      },
    });
    expect(soft.suppress).toBeUndefined();
    // Soft bounces never count toward the auto-freeze (SES ignores them too).
    expect(soft.reputation).toBeUndefined();
    expect(soft.bouncedRecipients).toEqual(["full@example.com"]);
  });

  it("maps complaints to suppression and rendering failure via the `failure` key", () => {
    const complaint = mapSesEvent({
      eventType: "Complaint",
      mail,
      complaint: { complainedRecipients: [{ emailAddress: "angry@example.com" }] },
    });
    expect(complaint.suppress).toEqual({ reason: "complaint", recipients: ["angry@example.com"] });
    expect(complaint.reputation).toEqual({ outcome: "complaint", recipients: 1 });

    const rendering = mapSesEvent({
      eventType: "Rendering Failure",
      mail,
      failure: { errorMessage: "template exploded" },
    });
    expect(rendering.extras).toEqual({ failed: { reason: "template exploded" } });
  });

  it("maps clicks with camelCase fields", () => {
    const clicked = mapSesEvent({
      eventType: "Click",
      mail,
      click: { ipAddress: "1.2.3.4", link: "https://x.co", timestamp: "t", userAgent: "UA" },
    });
    expect(clicked.extras.click).toEqual({
      ipAddress: "1.2.3.4",
      link: "https://x.co",
      timestamp: "t",
      userAgent: "UA",
    });
  });
});
