import assert from "node:assert/strict";
import { Resend } from "resend";

/**
 * M5 verify gate: scheduled sends end-to-end via the official SDK.
 * Usage: tsx src/acceptance-m5.ts <apiBaseUrl> <apiKey> <fromAddress>
 */

const [apiBaseUrl, apiKey, fromAddress] = process.argv.slice(2);
if (!apiBaseUrl || !apiKey || !fromAddress) {
  console.error("usage: acceptance-m5 <apiBaseUrl> <apiKey> <fromAddress>");
  process.exit(1);
}

process.env.RESEND_BASE_URL = apiBaseUrl;
const resend = new Resend(apiKey);
const SIMULATOR = "success@simulator.amazonses.com";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const lastEvent = async (id: string) => {
  const email = await resend.emails.get(id);
  return String((email.data as unknown as { last_event: string })?.last_event);
};

// 1. Schedule with natural language, watch it deliver.
const scheduled = await resend.emails.send({
  from: fromAddress,
  to: [SIMULATOR],
  subject: "opensender M5 acceptance — scheduled",
  html: "<p>Scheduled send.</p>",
  scheduledAt: "in 1 min",
});
assert.equal(scheduled.error, null, JSON.stringify(scheduled.error));
const scheduledId = scheduled.data?.id as string;
assert.equal(await lastEvent(scheduledId), "scheduled");
console.warn(`✓ scheduled via SDK ("in 1 min") -> ${scheduledId}`);

let state = "scheduled";
for (let i = 0; i < 30 && state === "scheduled"; i++) {
  await sleep(10_000);
  state = await lastEvent(scheduledId);
}
assert.ok(["sent", "delivered"].includes(state), `fired (last_event=${state})`);
console.warn(`✓ schedule fired ~1 min later (last_event=${state})`);

// 2. PATCH moves a schedule; cancel; post-cancel semantics.
const toCancel = await resend.emails.send({
  from: fromAddress,
  to: [SIMULATOR],
  subject: "opensender M5 acceptance — cancel",
  html: "<p>Cancel me.</p>",
  scheduledAt: "in 20 min",
});
assert.equal(toCancel.error, null, JSON.stringify(toCancel.error));
const cancelId = toCancel.data?.id as string;

const patched = await resend.emails.update({ id: cancelId, scheduledAt: "in 25 min" });
assert.equal(patched.error, null, JSON.stringify(patched.error));
console.warn("✓ PATCH rescheduled the pending email");

const canceled = await resend.emails.cancel(cancelId);
assert.equal(canceled.error, null, JSON.stringify(canceled.error));
assert.equal(await lastEvent(cancelId), "canceled");
console.warn("✓ cancel -> canceled");

const patchAfterCancel = await resend.emails.update({ id: cancelId, scheduledAt: "in 10 min" });
assert.ok(patchAfterCancel.error, "PATCH after cancel is rejected");
console.warn(`✓ PATCH after cancel rejected: "${patchAfterCancel.error?.message}"`);

const cancelAfterFire = await resend.emails.cancel(scheduledId);
assert.ok(cancelAfterFire.error, "cancel after delivery is rejected");
console.warn(`✓ cancel after delivery rejected: "${cancelAfterFire.error?.message}"`);

// 3. Batch with mixed immediate + scheduled items.
const batch = await resend.batch.send([
  { from: fromAddress, to: [SIMULATOR], subject: "batch immediate", html: "<p>now</p>" },
  {
    from: fromAddress,
    to: [SIMULATOR],
    subject: "batch scheduled",
    html: "<p>later</p>",
    scheduledAt: "in 15 min",
  },
]);
assert.equal(batch.error, null, JSON.stringify(batch.error));
const [immediateItem, scheduledItem] = batch.data?.data ?? [];
assert.equal(await lastEvent(immediateItem?.id as string), "sent");
assert.equal(await lastEvent(scheduledItem?.id as string), "scheduled");
console.warn("✓ batch mixed: immediate sent, scheduled pending");
await resend.emails.cancel(scheduledItem?.id as string);
console.warn("✓ cleanup: batch scheduled item canceled");

console.warn("\nM5 acceptance passed");
