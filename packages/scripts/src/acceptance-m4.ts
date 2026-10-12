import assert from "node:assert/strict";
import { Resend } from "resend";
import { Webhook } from "svix";

/**
 * M4 verify gate: webhooks CRUD via the official SDK, bounce-simulator
 * end-to-end with a capture endpoint, svix-library signature verification.
 *
 * Usage: tsx src/acceptance-m4.ts <apiBaseUrl> <apiKey> <fromAddress> <captureUrl>
 */

const [apiBaseUrl, apiKey, fromAddress, captureUrl] = process.argv.slice(2);
if (!apiBaseUrl || !apiKey || !fromAddress || !captureUrl) {
  console.error("usage: acceptance-m4 <apiBaseUrl> <apiKey> <fromAddress> <captureUrl>");
  process.exit(1);
}

process.env.RESEND_BASE_URL = apiBaseUrl;
const resend = new Resend(apiKey);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 1. Webhooks CRUD via the official SDK.
const created = await resend.webhooks.create({
  endpoint: captureUrl,
  events: ["email.bounced", "email.delivered", "suppression.added"],
});
assert.equal(created.error, null, JSON.stringify(created.error));
const webhookId = created.data?.id as string;
const signingSecret = (created.data as unknown as { signing_secret: string }).signing_secret;
assert.match(signingSecret, /^whsec_/);
console.warn(`✓ SDK webhooks.create -> ${webhookId}`);

const got = await resend.webhooks.get(webhookId);
assert.equal(got.error, null, JSON.stringify(got.error));
assert.equal(
  (got.data as unknown as { signing_secret: string }).signing_secret,
  signingSecret,
  "signing_secret is retrievable on GET",
);
console.warn("✓ SDK webhooks.get returns retrievable signing_secret");

const listed = await resend.webhooks.list();
assert.equal(listed.error, null);
const listItem = (listed.data as unknown as { data: Array<Record<string, unknown>> }).data.find(
  (item) => item.id === webhookId,
);
assert.ok(listItem, "webhook in list");
assert.ok(!("signing_secret" in (listItem as object)), "no signing_secret in list items");
console.warn("✓ SDK webhooks.list hides the secret");

// 2. Bounce end to end.
const bounced = await resend.emails.send({
  from: fromAddress,
  to: ["bounce@simulator.amazonses.com"],
  subject: "opensender M4 acceptance — bounce",
  html: "<p>Bounce me.</p>",
});
assert.equal(bounced.error, null, JSON.stringify(bounced.error));
const emailId = bounced.data?.id as string;
console.warn(`✓ sent to bounce simulator -> ${emailId}`);

// Poll until the email shows bounced (SES bounce lands within ~seconds).
let lastEvent = "";
for (let i = 0; i < 24; i++) {
  await sleep(5000);
  const email = await resend.emails.get(emailId);
  lastEvent = String((email.data as unknown as { last_event: string })?.last_event);
  if (lastEvent === "bounced") break;
}
assert.equal(lastEvent, "bounced", "email reached bounced");
console.warn("✓ GET /emails/:id shows last_event bounced");

// 3. Captured deliveries: email.bounced + suppression.added, svix-verified.
const token = new URL(captureUrl).pathname.slice(1);
let captured: Array<{ content: string; headers: Record<string, string[] | string> }> = [];
for (let i = 0; i < 12 && captured.length < 2; i++) {
  await sleep(5000);
  const requests = (await (
    await fetch(`https://webhook.site/token/${token}/requests?sorting=newest`)
  ).json()) as { data: Array<{ content: string; headers: Record<string, string[]> }> };
  captured = requests.data ?? [];
}
const types = captured.map((request) => JSON.parse(request.content).type);
assert.ok(types.includes("email.bounced"), `email.bounced delivered (got ${types})`);
assert.ok(types.includes("suppression.added"), `suppression.added delivered (got ${types})`);
console.warn(`✓ capture endpoint received: ${types.join(", ")}`);

const verifier = new Webhook(signingSecret);
for (const request of captured) {
  const header = (name: string) => {
    const value = request.headers[name];
    return Array.isArray(value) ? (value[0] as string) : String(value);
  };
  verifier.verify(request.content, {
    "svix-id": header("svix-id"),
    "svix-timestamp": header("svix-timestamp"),
    "svix-signature": header("svix-signature"),
  });
}
console.warn("✓ every captured delivery verifies with the official svix library");

// 4. The bounce payload carries the bounce block.
const bouncePayload = captured.find(
  (request) => JSON.parse(request.content).type === "email.bounced",
);
const bounceData = JSON.parse(bouncePayload?.content ?? "{}").data;
assert.equal(bounceData.email_id, emailId);
assert.ok(bounceData.bounce?.type, "bounce block present");
console.warn(
  `✓ bounce payload: type=${bounceData.bounce.type} subType=${bounceData.bounce.subType}`,
);

console.warn("\nM4 acceptance passed");
