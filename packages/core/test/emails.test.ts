import { describe, expect, it } from "vitest";
import { buildRawMime, needsRawMime, resolveContentType } from "../src/emails/build-message.js";
import { parseScheduledAt } from "../src/emails/scheduled-at.js";
import { canTransition, transition } from "../src/emails/state-machine.js";
import { validateSendRequest } from "../src/emails/validate.js";
import { deriveTextFromHtml, toWireEmail } from "../src/emails/wire.js";

describe("send request validation (fixtures 05-09 messages)", () => {
  const expectError = (body: unknown, name: string, message: string) => {
    try {
      validateSendRequest(body);
      expect.unreachable("expected a validation error");
    } catch (error) {
      expect(error).toMatchObject({ errorName: name, message });
    }
  };

  it("replicates the fixture-exact check order and messages", () => {
    expectError({}, "missing_required_field", "Missing `to` field.");
    expectError(
      { to: ["a@b.co"], subject: "s", html: "<p>x</p>" },
      "validation_error",
      "Missing `from` field.",
    );
    expectError(
      { from: "not-an-email", to: ["a@b.co"], subject: "s", html: "<p>x</p>" },
      "validation_error",
      "Invalid `from` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.",
    );
    expectError(
      { from: "a@d.co", to: ["a@b.co"], subject: "s" },
      "validation_error",
      "Missing `html` or `text` field.",
    );
    expectError(
      { from: "a@d.co", to: 123, subject: "s", html: "<p>x</p>" },
      "validation_error",
      "The `to` field must be a `string`.",
    );
  });

  it("normalizes string recipients and accepts Name <addr> senders", () => {
    const request = validateSendRequest({
      from: "Sender Name <a@d.co>",
      to: "solo@x.co",
      subject: "s",
      text: "hello",
    });
    expect(request.to).toEqual(["solo@x.co"]);
    expect(request.cc).toEqual([]);
  });

  it("caps recipients at 50 and requires attachment content or path", () => {
    expect(() =>
      validateSendRequest({
        from: "a@d.co",
        to: Array.from({ length: 51 }, (_, i) => `r${i}@x.co`),
        subject: "s",
        text: "t",
      }),
    ).toThrow(/maximum of 50/);
    expect(() =>
      validateSendRequest({
        from: "a@d.co",
        to: ["a@b.co"],
        subject: "s",
        text: "t",
        attachments: [{ filename: "x.txt" }],
      }),
    ).toThrow(/content.*or.*path/);
  });
});

describe("wire email serialization (fixture 34)", () => {
  it("serializes last_event, nulls, derived text, and message_id", () => {
    expect(
      toWireEmail({
        emailId: "f58cbaa7-e6a3-405f-a00a-90788eceb224",
        from: "onboarding@resend.dev",
        to: ["owner@example.net"],
        subject: "opensender fixture capture",
        html: "<p>Golden fixture capture. Please ignore.</p>",
        status: "sent",
        messageId:
          "<0100019fe28688e6-87caea31-bf32-4c73-8032-91ac39760ba1-000000@email.amazonses.com>",
        createdAt: "2026-08-08T17:58:15.369Z",
      }),
    ).toEqual({
      object: "email",
      id: "f58cbaa7-e6a3-405f-a00a-90788eceb224",
      to: ["owner@example.net"],
      from: "onboarding@resend.dev",
      created_at: "2026-08-08 17:58:15.369000+00",
      subject: "opensender fixture capture",
      bcc: null,
      cc: null,
      reply_to: null,
      last_event: "sent",
      scheduled_at: null,
      message_id:
        "<0100019fe28688e6-87caea31-bf32-4c73-8032-91ac39760ba1-000000@email.amazonses.com>",
      html: "<p>Golden fixture capture. Please ignore.</p>",
      text: "Golden fixture capture. Please ignore.",
    });
  });

  it("derives readable text from html", () => {
    expect(deriveTextFromHtml("<h1>Hi</h1><p>One &amp; two</p>")).toBe("Hi\nOne & two");
  });
});

describe("email state machine", () => {
  it("allows the documented transitions and rejects the rest", () => {
    expect(transition("scheduled", "canceled")).toBe("canceled");
    expect(transition("sent", "delivered")).toBe("delivered");
    expect(canTransition("delivered", "queued")).toBe(false);
    expect(() => transition("delivered", "queued")).toThrow(/invalid email status transition/);
    expect(() => transition("canceled", "scheduled")).toThrow();
  });
});

describe("scheduled_at parsing", () => {
  const now = new Date("2026-08-09T12:00:00.000Z");

  it("accepts ISO 8601 and natural language against UTC", () => {
    expect(parseScheduledAt("2026-08-10T10:00:00.000Z", now)).toBe("2026-08-10T10:00:00.000Z");
    expect(parseScheduledAt("in 1 min", now)).toBe("2026-08-09T12:01:00.000Z");
  });

  it("parses every documented natural-language example (R01 §6, UTC policy)", () => {
    // now = Sunday 2026-08-09 12:00 UTC
    expect(parseScheduledAt("tomorrow at 9am", now)).toBe("2026-08-10T09:00:00.000Z");
    // "Friday at 3pm ET" — ET = UTC-4 in August ⇒ 19:00 UTC, next Friday.
    expect(parseScheduledAt("Friday at 3pm ET", now)).toBe("2026-08-14T19:00:00.000Z");
    expect(parseScheduledAt("in 1 min", now)).toBe("2026-08-09T12:01:00.000Z");
  });

  it("rejects garbage and >30 days out", () => {
    expect(() => parseScheduledAt("gibberish@@", now)).toThrow(/Invalid `scheduled_at`/);
    expect(() => parseScheduledAt("in 45 days", now)).toThrow(/30 days/);
  });
});

describe("message construction strategy", () => {
  it("picks raw MIME only for attachments or custom headers", () => {
    const base = validateSendRequest({
      from: "a@d.co",
      to: ["b@x.co"],
      subject: "s",
      html: "<p>x</p>",
    });
    expect(needsRawMime(base)).toBe(false);
    expect(
      needsRawMime(
        validateSendRequest({
          from: "a@d.co",
          to: ["b@x.co"],
          subject: "s",
          html: "<p>x</p>",
          headers: { "X-Custom": "1" },
        }),
      ),
    ).toBe(true);
  });

  it("builds a multipart MIME with the attachment bytes", async () => {
    const request = validateSendRequest({
      from: "a@d.co",
      to: ["b@x.co"],
      subject: "with attachment",
      html: "<p>x</p>",
      attachments: [{ filename: "hi.txt", content: Buffer.from("hello!").toString("base64") }],
    });
    const content = await buildRawMime(request, [
      {
        filename: "hi.txt",
        content: new TextEncoder().encode("hello!"),
        contentType: "text/plain",
      },
    ]);
    if (content.kind !== "raw") expect.unreachable("expected raw content");
    const mime = Buffer.from(content.mime).toString();
    expect(mime).toContain("Subject: with attachment");
    expect(mime).toContain("filename=hi.txt");
    expect(mime).toContain(Buffer.from("hello!").toString("base64"));
  });

  it("keeps the attachment's content_id from the request", () => {
    const request = validateSendRequest({
      from: "a@d.co",
      to: ["b@x.co"],
      subject: "s",
      html: '<img src="cid:ic_cub">',
      attachments: [{ filename: "cub.png", content: "eA==", content_id: "<ic_cub>" }],
    });
    expect(request.attachments[0]?.contentId).toBe("ic_cub");
  });

  it("derives a missing content type from the filename, never the generic source type", () => {
    expect(resolveContentType("rank-4.png")).toBe("image/png");
    expect(resolveContentType("rank-4.png", "image/x-custom")).toBe("image/x-custom");
    expect(resolveContentType("rank-4.png", undefined, "application/octet-stream")).toBe(
      "image/png",
    );
    expect(resolveContentType("report", undefined, "application/pdf")).toBe("application/pdf");
    expect(resolveContentType("no-extension")).toBe("application/octet-stream");
  });
});
