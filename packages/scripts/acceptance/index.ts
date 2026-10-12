import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  ApiKeysService,
  createApiKeyEntity,
  createDomainEntity,
  createSuppressionEntity,
} from "@opensender/core";
import { Resource } from "sst";

/**
 * Consolidated acceptance suite (SPEC §17.2). Self-provisions a throwaway
 * full_access key on the instance's verified-domain team, then runs the full
 * flow against production via the untouched official `resend` SDK (each step is
 * an existing per-milestone script) plus the rate-limit and MCP smoke tests,
 * and deletes the key at the end.
 *
 * Run under `sst shell` (needs Resource to provision the key):
 *   sst shell --stage production -- tsx acceptance/index.ts [apiBaseUrl]
 *
 * Recipients are always the SES mailbox simulator (never real inboxes). The
 * webhook-receive step (m4) needs an external capture endpoint. It uses
 * ACCEPTANCE_CAPTURE_URL if set, otherwise auto-provisions an ephemeral
 * webhook.site token; if that provider is unreachable the step is skipped.
 * Contract fuzzing (Schemathesis, §17 #3) is a separate on-demand step — see
 * acceptance/schemathesis.md.
 */

const apiBase = (process.argv[2] ?? "https://api.mailing.example.com").replace(/\/$/, "");
const pkgRoot = path.resolve(fileURLToPath(import.meta.url), "../..");

/** m4 needs a capture endpoint whose requests are readable back (svix-verify);
 * webhook.site's token API is exactly that. An explicit override wins. */
async function provisionCaptureUrl(): Promise<string | undefined> {
  if (process.env.ACCEPTANCE_CAPTURE_URL) return process.env.ACCEPTANCE_CAPTURE_URL;
  try {
    const res = await fetch("https://webhook.site/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) return undefined;
    const { uuid } = (await res.json()) as { uuid: string };
    return `https://webhook.site/${uuid}`;
  } catch {
    return undefined;
  }
}

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const table = Resource.Table.name;
const domainEntity = createDomainEntity({ client: dynamo, table });
const apiKeys = new ApiKeysService({
  apiKeys: createApiKeyEntity({ client: dynamo, table }),
  clock: () => new Date(),
  idGenerator: () => crypto.randomUUID(),
});

/** Run a sub-script under tsx; returns its exit status. */
function run(rel: string, args: string[]): number {
  const result = spawnSync("node", ["--import", "tsx", path.join(pkgRoot, rel), ...args], {
    stdio: "inherit",
    cwd: pkgRoot,
    env: process.env,
  });
  return result.status ?? 1;
}

/** Run a required step; throws on failure. */
function runStrict(rel: string, args: string[]): void {
  assert.equal(run(rel, args), 0, `${rel} exited non-zero`);
}

const scan = await domainEntity.scan.go({ pages: "all" });
const verified = (scan.data as Array<{ teamId: string; name: string; status: string }>).find(
  (d) => d.status === "verified",
);
assert.ok(verified, "no verified domain found in production");
const teamId = verified.teamId;
const from = `noreply@${verified.name}`;
console.warn(`Acceptance against ${apiBase} — team ${teamId}, from ${from}\n`);

const key = await apiKeys.createKey({
  teamId,
  name: "acceptance-suite",
  permission: "full_access",
});
const skipped: string[] = [];

try {
  console.warn("── send / attachments / idempotency / batch (m3) ──");
  runStrict("src/acceptance-m3.ts", [apiBase, key.token, from]);

  console.warn("\n── scheduled send + patch + cancel (m5) ──");
  runStrict("src/acceptance-m5.ts", [apiBase, key.token, from]);

  console.warn("\n── segments / audiences / contacts / broadcast (m7) ──");
  runStrict("src/acceptance-m7.ts", [apiBase, key.token, from]);

  console.warn("\n── dashboard surface + webhook replay (m8) ──");
  runStrict("src/acceptance-m8.ts", [apiBase, key.token, from]);

  console.warn("\n── rate limit (fixture 30) ──");
  runStrict("acceptance/rate-limit.ts", [apiBase, key.token]);

  const capture = await provisionCaptureUrl();
  const captureIsOperator = Boolean(process.env.ACCEPTANCE_CAPTURE_URL);
  if (capture) {
    console.warn("\n── webhooks CRUD + svix-verify a real delivery (m4) ──");
    // A prior run's bounce suppressed bounce@simulator; clear it so the
    // re-send under test is accepted. m4 re-verifies the suppression is re-added.
    await createSuppressionEntity({ client: dynamo, table })
      .delete({ teamId, email: "bounce@simulator.amazonses.com" })
      .go();
    const status = run("src/acceptance-m4.ts", [apiBase, key.token, from, capture]);
    if (status !== 0) {
      // An operator-supplied capture URL must pass; the auto-provisioned
      // webhook.site token is best-effort (the free tier can silently drop
      // captures), so a failure there degrades to skipped rather than failing
      // the gate. The svix-verify path is covered when a stable URL is given.
      if (captureIsOperator) assert.fail("m4 failed with the supplied ACCEPTANCE_CAPTURE_URL");
      skipped.push("m4 webhook receive/svix-verify (auto webhook.site capture was unreliable)");
    }
  } else {
    skipped.push(
      "m4 webhook receive/svix-verify (no capture endpoint; set ACCEPTANCE_CAPTURE_URL)",
    );
  }

  console.warn("\n── MCP smoke: tools, send_email/get_email, key scoping (m9) ──");
  runStrict("src/verify-m9.ts", [apiBase]);

  console.warn("\n✅ acceptance suite passed.");
  if (skipped.length > 0) console.warn(`Skipped (needs external setup): ${skipped.join("; ")}`);
} finally {
  await apiKeys.deleteKey(teamId, key.key.keyId);
  console.warn("cleaned up acceptance key");
}
