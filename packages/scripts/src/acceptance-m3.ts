import assert from "node:assert/strict";
import { Resend } from "resend";

/**
 * M3 verify gate: the official `resend` SDK against production, recipients
 * restricted to the SES mailbox simulator (SPEC §17).
 *
 * Usage: tsx src/acceptance-m3.ts <apiBaseUrl> <apiKey> <fromAddress>
 */

const [apiBaseUrl, apiKey, fromAddress] = process.argv.slice(2);
if (!apiBaseUrl || !apiKey || !fromAddress) {
  console.error("usage: acceptance-m3 <apiBaseUrl> <apiKey> <fromAddress>");
  process.exit(1);
}

process.env.RESEND_BASE_URL = apiBaseUrl;
const resend = new Resend(apiKey);
const SIMULATOR = "success@simulator.amazonses.com";
const results: string[] = [];

function pass(name: string) {
  results.push(name);
  console.warn(`✓ ${name}`);
}

// 1. Simple send through the SDK.
const sent = await resend.emails.send({
  from: fromAddress,
  to: [SIMULATOR],
  subject: "opensender M3 acceptance — simple",
  html: "<p>Simple send. Please ignore.</p>",
});
assert.equal(sent.error, null, JSON.stringify(sent.error));
assert.ok(sent.data?.id, "send returned an id");
pass(`SDK send -> id ${sent.data?.id}`);

// 2. GET /emails/:id matches fixture-34 shape.
const fetched = await resend.emails.get(sent.data?.id as string);
assert.equal(fetched.error, null, JSON.stringify(fetched.error));
const email = fetched.data as unknown as Record<string, unknown>;
for (const key of [
  "object",
  "id",
  "to",
  "from",
  "created_at",
  "subject",
  "bcc",
  "cc",
  "reply_to",
  "last_event",
  "scheduled_at",
  "message_id",
  "html",
  "text",
]) {
  assert.ok(key in email, `email has ${key}`);
}
assert.equal(email.object, "email");
assert.equal(email.last_event, "sent");
assert.equal(email.bcc, null);
assert.match(String(email.created_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}\+00$/);
assert.match(String(email.message_id), /^<.*@email\.amazonses\.com>$/);
assert.ok(String(email.text).length > 0, "text auto-derived");
pass("GET /emails/:id fixture-34 shape");

// 3. Base64 attachment send.
const withAttachment = await resend.emails.send({
  from: fromAddress,
  to: [SIMULATOR],
  subject: "opensender M3 acceptance — attachment",
  html: "<p>With attachment.</p>",
  attachments: [
    { filename: "hello.txt", content: Buffer.from("hello from opensender").toString("base64") },
  ],
});
assert.equal(withAttachment.error, null, JSON.stringify(withAttachment.error));
pass(`base64 attachment send -> ${withAttachment.data?.id}`);

// 3b. Attachment endpoints expose a presigned download_url.
const attachmentsResponse = await fetch(
  `${apiBaseUrl}/emails/${withAttachment.data?.id}/attachments`,
  { headers: { authorization: `Bearer ${apiKey}` } },
);
const attachmentList = (await attachmentsResponse.json()) as {
  data: Array<{ download_url: string; expires_at: string; size: number }>;
};
assert.equal(attachmentsResponse.status, 200);
assert.equal(attachmentList.data.length, 1);
assert.ok(attachmentList.data[0]?.download_url.includes("X-Amz-Signature"));
const downloaded = await fetch(attachmentList.data[0]?.download_url as string);
assert.equal(await downloaded.text(), "hello from opensender");
pass("attachment metadata + presigned download round-trip");

// 4. Path attachment (downloads our own public spec).
const withPath = await resend.emails.send({
  from: fromAddress,
  to: [SIMULATOR],
  subject: "opensender M3 acceptance — path attachment",
  html: "<p>With path attachment.</p>",
  attachments: [{ filename: "openapi.json", path: `${apiBaseUrl}/openapi.json` }],
});
assert.equal(withPath.error, null, JSON.stringify(withPath.error));
pass(`path attachment send -> ${withPath.data?.id}`);

// 5. Idempotency: replay identical, then mutate.
const idemKey = `acceptance-${Date.now()}`;
const idemBody = JSON.stringify({
  from: fromAddress,
  to: [SIMULATOR],
  subject: "opensender M3 acceptance — idempotent",
  html: "<p>Idempotent send.</p>",
});
const post = (body: string) =>
  fetch(`${apiBaseUrl}/emails`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "idempotency-key": idemKey,
    },
    body,
  });
const first = await post(idemBody);
assert.equal(first.status, 200);
assert.equal(first.headers.get("idempotent-replayed"), "false");
const firstBody = await first.text();
assert.ok(first.headers.get("x-resend-daily-quota"), "daily quota header present");

const replay = await post(idemBody);
assert.equal(replay.status, 200);
assert.equal(replay.headers.get("idempotent-replayed"), "true");
assert.equal(await replay.text(), firstBody);

const mutated = await post(idemBody.replace("Idempotent send", "MUTATED"));
assert.equal(mutated.status, 409);
const conflict = (await mutated.json()) as { name: string };
assert.equal(conflict.name, "invalid_idempotent_request");
pass("idempotency: replay identical + mutation 409 (fixture 36)");

// 6. Batch strict + permissive.
const validItem = {
  from: fromAddress,
  to: [SIMULATOR],
  subject: "opensender M3 acceptance — batch",
  html: "<p>Batch item.</p>",
};
const invalidItem = { to: [SIMULATOR], subject: "no from", html: "<p>x</p>" };

const strict = await fetch(`${apiBaseUrl}/emails/batch`, {
  method: "POST",
  headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
  body: JSON.stringify([validItem, invalidItem]),
});
assert.equal(strict.status, 422);
assert.deepEqual(await strict.json(), {
  statusCode: 422,
  name: "validation_error",
  message: "Missing `from` field.",
});

const permissive = await fetch(`${apiBaseUrl}/emails/batch`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "x-batch-validation": "permissive",
  },
  body: JSON.stringify([validItem, invalidItem]),
});
assert.equal(permissive.status, 202);
const permissiveBody = (await permissive.json()) as {
  data: Array<{ id: string }>;
  errors: Array<{ index: number; message: string }>;
};
assert.equal(permissiveBody.data.length, 1);
assert.deepEqual(permissiveBody.errors, [{ index: 1, message: "Missing `from` field." }]);
pass("batch strict 422 (fixture 28) + permissive 202 (fixture 29)");

// 7. SDK batch happy path.
const sdkBatch = await resend.batch.send([validItem, validItem]);
assert.equal(sdkBatch.error, null, JSON.stringify(sdkBatch.error));
assert.equal(sdkBatch.data?.data.length, 2);
pass("SDK batch send");

console.warn(`\n${results.length} acceptance checks passed`);
