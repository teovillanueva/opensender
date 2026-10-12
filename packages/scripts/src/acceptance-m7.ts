import assert from "node:assert/strict";
import { Resend } from "resend";

/**
 * M7 verify gate: marketing surface through the official SDK.
 * Exercises the audiences alias and the segments surface (same entities), the
 * audience-scoped contacts CRUD, and a broadcast create+send. The deep fan-out
 * checks (merge tags, RFC 8058 headers, one-click unsubscribe, delivery-event
 * stat roll-up) are covered by the live acceptance run recorded in the ledger.
 * Usage: tsx src/acceptance-m7.ts <apiBaseUrl> <apiKey> <fromAddress>
 */

const [apiBaseUrl, apiKey, fromAddress] = process.argv.slice(2);
if (!apiBaseUrl || !apiKey || !fromAddress) {
  console.error("usage: acceptance-m7 <apiBaseUrl> <apiKey> <fromAddress>");
  process.exit(1);
}

process.env.RESEND_BASE_URL = apiBaseUrl;
const resend = new Resend(apiKey);
const stamp = fromAddress.length.toString(36);

// 1. Audiences alias CRUD (old surface).
const audience = await resend.audiences.create({ name: `m7-acceptance-${stamp}` });
assert.equal(audience.error, null, JSON.stringify(audience.error));
const audienceId = audience.data?.id as string;
assert.ok(audienceId, "audience create returned an id");
const audienceGet = await resend.audiences.get(audienceId);
assert.equal(audienceGet.data?.id, audienceId);
const audienceList = await resend.audiences.list();
assert.ok(
  audienceList.data?.data?.some((a) => a.id === audienceId),
  "audience appears in the list",
);
console.warn(`✓ audiences CRUD via SDK -> ${audienceId}`);

// 2. Segments surface (new generation) backs the same entities.
const segment = await resend.segments.create({ name: `m7-seg-${stamp}` });
assert.equal(segment.error, null, JSON.stringify(segment.error));
const segmentId = segment.data?.id as string;
assert.ok(segmentId, "segment create returned an id");
assert.equal((await resend.segments.get(segmentId)).data?.id, segmentId);
const segmentRemoved = await resend.segments.remove(segmentId);
assert.equal(segmentRemoved.error, null, JSON.stringify(segmentRemoved.error));
console.warn(`✓ segments CRUD via SDK -> ${segmentId}`);

// 3. Contacts CRUD under the audience; lookup by id and by email.
const contact = await resend.contacts.create({
  audienceId,
  email: `m7-contact-${stamp}@example.com`,
  firstName: "Acceptance",
  lastName: "Contact",
  unsubscribed: false,
});
assert.equal(contact.error, null, JSON.stringify(contact.error));
const contactId = contact.data?.id as string;
assert.ok(contactId, "contact create returned an id");
const byId = await resend.contacts.get({ audienceId, id: contactId });
assert.equal(byId.data?.id, contactId);
const byEmail = await resend.contacts.get({
  audienceId,
  email: `m7-contact-${stamp}@example.com`,
});
assert.equal(byEmail.data?.id, contactId, "contact resolves by email");
const updated = await resend.contacts.update({
  audienceId,
  id: contactId,
  firstName: "Updated",
});
assert.equal(updated.data?.id, contactId);
const contactRemoved = await resend.contacts.remove({ audienceId, id: contactId });
assert.equal(contactRemoved.error, null, JSON.stringify(contactRemoved.error));
console.warn(`✓ contacts CRUD via SDK (id + email lookup) -> ${contactId}`);

// 4. Broadcast create + send accepted by the fan-out surface.
await resend.contacts.create({
  audienceId,
  email: "success@simulator.amazonses.com",
  firstName: "Sim",
});
const broadcast = await resend.broadcasts.create({
  audienceId,
  from: fromAddress,
  subject: "opensender M7 acceptance",
  html: "<p>Hi {{{contact.first_name|there}}} — {{{RESEND_UNSUBSCRIBE_URL}}}</p>",
});
assert.equal(broadcast.error, null, JSON.stringify(broadcast.error));
const broadcastId = broadcast.data?.id as string;
assert.ok(broadcastId, "broadcast create returned an id");
const sent = await resend.broadcasts.send(broadcastId);
assert.equal(sent.error, null, JSON.stringify(sent.error));
console.warn(`✓ broadcast create + send via SDK -> ${broadcastId}`);

console.warn("M7 acceptance passed.");
