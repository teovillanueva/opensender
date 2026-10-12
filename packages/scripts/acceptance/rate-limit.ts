import assert from "node:assert/strict";

/**
 * Rate-limit acceptance (SPEC §17 #4 / fixture 30): a burst past the per-team
 * limit in one second returns 429 with the exact fixture-30 headers and body.
 *
 * The limit is read from a warm-up response so this works whatever plan the
 * test team is on; the fixture itself is the limit=10 (default plan) case.
 *
 * Usage: tsx acceptance/rate-limit.ts <apiBaseUrl> <apiKey>
 */

const [apiBaseUrl, apiKey] = process.argv.slice(2);
if (!apiBaseUrl || !apiKey) {
  console.error("usage: rate-limit <apiBaseUrl> <apiKey>");
  process.exit(1);
}

const get = () =>
  fetch(`${apiBaseUrl}/domains`, { headers: { authorization: `Bearer ${apiKey}` } });

// Warm-up read to learn the team's limit and let the bucket be full.
const warm = await get();
const limit = Number(warm.headers.get("ratelimit-limit") ?? "10");
assert.ok(limit > 0, "no ratelimit-limit header on an authed 200");
await new Promise((r) => setTimeout(r, 1100)); // refill the 1s bucket

// Burst past the limit in a single second.
const burst = await Promise.all(Array.from({ length: limit + 5 }, () => get()));
const statuses = burst.map((r) => r.status);
const limited = burst.find((r) => r.status === 429);
assert.ok(limited, `expected a 429 in a ${limit + 5}-burst, got: ${statuses.join(",")}`);

// Fixture-30 headers.
assert.equal(limited.headers.get("ratelimit-limit"), String(limit));
assert.equal(limited.headers.get("ratelimit-policy"), `${limit};w=1`);
assert.equal(limited.headers.get("ratelimit-remaining"), "0");
assert.ok(Number(limited.headers.get("ratelimit-reset")) >= 0, "ratelimit-reset present");
assert.ok(limited.headers.get("retry-after"), "retry-after present");

// Fixture-30 body.
const body = (await limited.json()) as { statusCode: number; name: string; message: string };
assert.equal(body.statusCode, 429);
assert.equal(body.name, "rate_limit_exceeded");
assert.match(body.message, /Too many requests\. You can only make \d+ requests per second\./);

console.warn(
  `✓ rate limit fired (${statuses.filter((s) => s === 429).length} of ${statuses.length} => 429), fixture-30 shape`,
);
