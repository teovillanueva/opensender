import assert from "node:assert/strict";

/**
 * M8 verify gate (auto-checkable slice): the dashboard's server-side guarantees.
 * The visual walkthrough of every screen is the operator's browser QA; this
 * script proves the parts an agent can check headless against production:
 *   1. Sign-up is rejected server-side while `signupOpen: false` (SPEC §13.1).
 *   2. The CSV-import mechanism (nested contacts) ingests >=1000 rows without
 *      hanging and lists them back (SPEC §13.7 verify).
 *   3. Webhook replay re-enqueues a stored delivery and a fresh attempt lands
 *      (SPEC §13.6).
 * A bearer API key authenticates the same authed surface the dashboard session
 * uses, so the x-internal endpoints are reachable here too.
 *
 * Usage: tsx src/acceptance-m8.ts <apiBaseUrl> <apiKey> <fromAddress>
 */

const [apiBaseUrl, apiKey, fromAddress] = process.argv.slice(2);
if (!apiBaseUrl || !apiKey || !fromAddress) {
  console.error("usage: acceptance-m8 <apiBaseUrl> <apiKey> <fromAddress>");
  process.exit(1);
}

const base = apiBaseUrl.replace(/\/$/, "");
const authHeaders = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
const stamp = Date.now().toString(36);

async function json(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : null };
}

function id(body: unknown): string {
  assert.ok(
    body && typeof body === "object" && "id" in body,
    `expected an id in ${JSON.stringify(body)}`,
  );
  return String((body as { id: unknown }).id);
}

// 1. Sign-up disabled server-side (not just hidden in the UI).
const signup = await fetch(`${base}/auth/sign-up/email`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    email: `m8-signup-${stamp}@example.com`,
    password: "hunter2hunter2",
    name: "Should Fail",
  }),
});
assert.ok(
  signup.status >= 400,
  `sign-up must be rejected while signupOpen:false, got ${signup.status}`,
);
console.warn(`✓ sign-up rejected server-side (${signup.status})`);

// 2. Bulk contact ingest (the CSV import path) — 1000 rows, batched, then listed.
const audience = await json("/audiences", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: `m8-bulk-${stamp}` }),
});
const audienceId = id(audience.body);
const TOTAL = 1000;
const BATCH = 8;
const MAX_RETRIES = 8;

// POST one contact, retrying on 429 (per-team 10 req/s) — the same discipline
// the dashboard's CSV import uses, so a large import is not truncated.
async function postContact(n: number): Promise<boolean> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const res = await fetch(`${base}/audiences/${audienceId}/contacts`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ email: `m8-bulk-${stamp}-${n}@example.com`, first_name: `User${n}` }),
    });
    if (res.status === 201) return true;
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await new Promise((r) =>
        setTimeout(r, retryAfter > 0 ? retryAfter * 1000 : 400 * 2 ** attempt),
      );
      continue;
    }
    return false;
  }
  return false;
}

let created = 0;
for (let start = 0; start < TOTAL; start += BATCH) {
  const batch = Array.from({ length: Math.min(BATCH, TOTAL - start) }, (_, i) => start + i);
  const results = await Promise.all(batch.map((n) => postContact(n)));
  created += results.filter(Boolean).length;
}
assert.equal(created, TOTAL, `expected ${TOTAL} contacts created, got ${created}`);
const list = await json(`/audiences/${audienceId}/contacts`, { headers: authHeaders });
const listed = (list.body as { data?: unknown[] }).data?.length ?? 0;
assert.ok(listed >= TOTAL, `contact list must return >= ${TOTAL}, got ${listed}`);
console.warn(`✓ bulk contacts: created ${created}, listed ${listed} (no hang)`);

// 3. Webhook replay: create an endpoint, generate a delivery by sending an email
//    (email.sent fans out to the endpoint), then replay the stored delivery.
const endpoint = await json("/webhooks", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ endpoint: "https://example.com/opensender-m8", events: ["email.sent"] }),
});
const endpointId = id(endpoint.body);

const send = await json("/emails", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    from: fromAddress,
    to: ["success@simulator.amazonses.com"],
    subject: "opensender M8 webhook replay",
    html: "<p>hi</p>",
  }),
});
assert.ok(send.status === 200 || send.status === 202, `email send -> ${send.status}`);

async function firstDelivery(): Promise<{ id: string; attempts: number } | null> {
  const res = await json(`/internal/webhooks/${endpointId}/deliveries`, { headers: authHeaders });
  const data = (res.body as { data?: Array<{ id: string }> }).data ?? [];
  const first = data[0];
  return first ? { id: first.id, attempts: data.length } : null;
}

let delivery: { id: string; attempts: number } | null = null;
for (let attempt = 0; attempt < 30 && !delivery; attempt += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  delivery = await firstDelivery();
}
assert.ok(delivery, "a webhook delivery attempt should be logged within 60s");
const before =
  (
    (await json(`/internal/webhooks/${endpointId}/deliveries`, { headers: authHeaders })).body as {
      data?: unknown[];
    }
  ).data?.length ?? 0;

const replay = await json(`/internal/webhooks/${endpointId}/deliveries/${delivery.id}/replay`, {
  method: "POST",
  headers: authHeaders,
});
assert.equal(replay.status, 202, `replay -> ${replay.status}`);

let after = before;
for (let attempt = 0; attempt < 30 && after <= before; attempt += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  after =
    (
      (await json(`/internal/webhooks/${endpointId}/deliveries`, { headers: authHeaders }))
        .body as { data?: unknown[] }
    ).data?.length ?? 0;
}
assert.ok(after > before, `replay must add a delivery attempt (${before} -> ${after})`);
console.warn(`✓ webhook replay re-delivered (attempts ${before} -> ${after})`);

console.warn("M8 acceptance passed.");
