import assert from "node:assert/strict";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ApiKeysService, createApiKeyEntity, createDomainEntity } from "@opensender/core";
import { Resource } from "sst";

/**
 * M9 verify gate (SPEC §14) against the deployed MCP endpoint. Runs under
 * `sst shell` so it can provision two throwaway API keys (one full_access, one
 * sending_access) for an existing verified-domain team, exercise `POST /mcp`
 * over HTTP as an agent would, then delete the keys.
 *
 * Usage: sst shell --stage production -- tsx src/verify-m9.ts [apiBaseUrl]
 */

const apiBase = (process.argv[2] ?? "https://api.mailing.example.com").replace(/\/$/, "");
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RpcResult {
  status: number;
  body: {
    result?: {
      tools?: Array<{ name: string }>;
      resources?: Array<{ name: string }>;
      content?: Array<{ text: string }>;
      isError?: boolean;
    };
    error?: { code: number; message: string };
  } | null;
}

async function mcp(method: string, params: unknown, token: string, id = 1): Promise<RpcResult> {
  const res = await fetch(`${apiBase}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  const parsed = text.length > 0 ? JSON.parse(text) : null;
  return { status: res.status, body: Array.isArray(parsed) ? parsed[0] : parsed };
}

const callTool = (name: string, args: unknown, token: string) =>
  mcp("tools/call", { name, arguments: args }, token);

// --- Find an existing verified domain and provision throwaway keys ---
const scan = await domainEntity.scan.go({ pages: "all" });
const verified = (scan.data as Array<{ teamId: string; name: string; status: string }>).find(
  (d) => d.status === "verified",
);
assert.ok(verified, "no verified domain found in production to run the send_email flow");
const teamId = verified.teamId;
const fromAddress = `noreply@${verified.name}`;
console.warn(`Using team ${teamId}, from ${fromAddress}`);

const full = await apiKeys.createKey({ teamId, name: "m9-verify-full", permission: "full_access" });
const restricted = await apiKeys.createKey({
  teamId,
  name: "m9-verify-send",
  permission: "sending_access",
});

try {
  // 1. Full-access key lists every tool.
  const fullList = await mcp("tools/list", {}, full.token);
  assert.equal(fullList.status, 200, `tools/list -> ${fullList.status}`);
  const fullNames = (fullList.body?.result?.tools ?? []).map((t) => t.name).sort();
  assert.deepEqual(
    fullNames,
    [
      "add_contact",
      "create_broadcast",
      "create_domain",
      "get_email",
      "get_usage_stats",
      "list_domains",
      "list_emails",
      "list_segments",
      "send_broadcast",
      "send_email",
      "unsubscribe_contact",
      "verify_domain",
    ].sort(),
    `unexpected tool set: ${fullNames.join(",")}`,
  );
  console.warn(`✓ full_access lists all ${fullNames.length} tools`);

  // 2. openapi.json exposed as a resource (both key types).
  const fullRes = await mcp("resources/list", {}, full.token);
  assert.ok(
    (fullRes.body?.result?.resources ?? []).some((r) => r.name === "openapi"),
    "openapi resource missing for full_access",
  );
  const restRes = await mcp("resources/list", {}, restricted.token);
  assert.ok(
    (restRes.body?.result?.resources ?? []).some((r) => r.name === "openapi"),
    "openapi resource missing for sending_access",
  );
  console.warn("✓ openapi.json exposed as an MCP resource to both key types");

  // 3. sending_access key sees only send_email; admin tools invisible.
  const restList = await mcp("tools/list", {}, restricted.token);
  const restNames = (restList.body?.result?.tools ?? []).map((t) => t.name);
  assert.deepEqual(restNames, ["send_email"], `sending key tools: ${restNames.join(",")}`);
  console.warn("✓ sending_access lists only send_email");

  // 4. Admin tool called directly by a sending_access key is rejected.
  const denied = await callTool("list_domains", {}, restricted.token);
  assert.ok(
    denied.body?.error || denied.body?.result?.isError,
    "admin tool must be rejected for a sending_access key",
  );
  console.warn("✓ admin tool rejected for sending_access (unknown tool)");

  // 5. send_email (simulator) then get_email showing the timeline.
  const sent = await callTool(
    "send_email",
    {
      from: fromAddress,
      to: "success@simulator.amazonses.com",
      subject: "opensender M9 MCP verify",
      html: "<p>MCP send_email verify. Please ignore.</p>",
    },
    full.token,
  );
  assert.ok(
    !sent.body?.result?.isError,
    `send_email failed: ${sent.body?.result?.content?.[0]?.text}`,
  );
  const sentText = sent.body?.result?.content?.[0]?.text ?? "";
  const emailId = sentText.match(/id=([0-9a-f-]+)/)?.[1];
  assert.ok(emailId, `no email id in: ${sentText}`);
  console.warn(`✓ send_email accepted (id=${emailId})`);

  let timeline: Array<{ type: string }> = [];
  let status = "";
  for (let attempt = 0; attempt < 30 && timeline.length === 0; attempt += 1) {
    await sleep(2000);
    const got = await callTool("get_email", { id: emailId }, full.token);
    const summary = JSON.parse(got.body?.result?.content?.[0]?.text ?? "{}");
    status = summary.status ?? "";
    timeline = summary.timeline ?? [];
  }
  assert.ok(status.length > 0, "get_email returned no status");
  assert.ok(timeline.length > 0, "get_email showed no timeline events within 60s");
  console.warn(
    `✓ get_email shows status=${status}, timeline=[${timeline.map((e) => e.type).join(", ")}]`,
  );

  // 6. GET /mcp returns 405.
  const getRes = await fetch(`${apiBase}/mcp`, { method: "GET" });
  assert.equal(getRes.status, 405, `GET /mcp -> ${getRes.status}`);
  console.warn("✓ GET /mcp returns 405");

  // 7. Rate limiting fires on MCP calls (10 req/s per team).
  await sleep(1200); // let the bucket refill from the prior calls
  const burst = await Promise.all(
    Array.from({ length: 20 }, (_, i) => mcp("tools/list", {}, full.token, i + 100)),
  );
  const limited = burst.filter((r) => r.status === 429).length;
  assert.ok(limited > 0, `expected a 429 in a 20-call burst, got none (statuses seen)`);
  console.warn(`✓ rate limiting fired on MCP calls (${limited}/20 returned 429)`);

  console.warn("\nM9 acceptance passed.");
} finally {
  await apiKeys.deleteKey(teamId, full.key.keyId);
  await apiKeys.deleteKey(teamId, restricted.key.keyId);
  console.warn("cleaned up throwaway keys");
}
