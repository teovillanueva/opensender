import assert from "node:assert/strict";
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { ApiKeysService, createApiKeyEntity, createDomainEntity } from "@opensender/core";
import { Resource } from "sst";

/**
 * M10 observability verify (SPEC §15), run under `sst shell --stage production`.
 * Sends one real email through the API (simulator recipient) and then scrapes
 * the Api Lambda's log group to prove the Powertools wiring is live:
 *
 *   - structured JSON logs  (a line with "service":"opensender")
 *   - EMF custom metrics    (an EMF blob carrying the "sends" metric)
 *
 * The EMF blob is written to stdout by `metrics.publishStoredMetrics()`, so it
 * appears in CloudWatch Logs immediately — no wait for metric aggregation.
 */

const apiBase = (process.argv[2] ?? "https://api.mailing.example.com").replace(/\/$/, "");
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const table = Resource.Table.name;
const logs = new CloudWatchLogsClient({});

/** Resolve the Api Lambda's log group by its SST physical-name prefix. */
async function resolveApiLogGroup(): Promise<string> {
  const prefix = `/aws/lambda/${Resource.App.name}-${Resource.App.stage}-ApiFunction`;
  const res = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix }));
  const name = res.logGroups?.[0]?.logGroupName;
  assert.ok(name, `no Api log group found with prefix ${prefix}`);
  return name;
}
const logGroupName = await resolveApiLogGroup();

const domainEntity = createDomainEntity({ client: dynamo, table });
const apiKeys = new ApiKeysService({
  apiKeys: createApiKeyEntity({ client: dynamo, table }),
  clock: () => new Date(),
  idGenerator: () => crypto.randomUUID(),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll recent log events (substring match in JS — CloudWatch filter-pattern
 * quoting is too brittle for JSON needles). Returns as soon as any needle is
 * still unmatched runs out of retries.
 */
async function scanLogs(startTime: number, needles: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < 20 && found.size < needles.length; i += 1) {
    let nextToken: string | undefined;
    do {
      const res = await logs.send(
        new FilterLogEventsCommand({ logGroupName, startTime, nextToken }),
      );
      for (const event of res.events ?? []) {
        const message = event.message ?? "";
        for (const needle of needles) if (message.includes(needle)) found.add(needle);
      }
      nextToken = res.nextToken;
    } while (nextToken && found.size < needles.length);
    if (found.size < needles.length) await sleep(3000);
  }
  return found;
}

const scan = await domainEntity.scan.go({ pages: "all" });
const verified = (scan.data as Array<{ teamId: string; name: string; status: string }>).find(
  (d) => d.status === "verified",
);
assert.ok(verified, "no verified domain found in production");
const teamId = verified.teamId;
const fromAddress = `noreply@${verified.name}`;

const key = await apiKeys.createKey({
  teamId,
  name: "m10-observability",
  permission: "full_access",
});
const startTime = Date.now() - 10_000;

try {
  const res = await fetch(`${apiBase}/emails`, {
    method: "POST",
    headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: fromAddress,
      to: "success@simulator.amazonses.com",
      subject: "opensender M10 observability verify",
      html: "<p>Observability verify. Please ignore.</p>",
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 200, `send failed (${res.status}): ${JSON.stringify(body)}`);
  console.warn(`✓ sent email id=${body.id}`);

  console.warn(`Scanning ${logGroupName} for structured logs + EMF metrics...`);
  const structuredNeedle = '"service":"opensender"';
  const emfNeedle = '"sends"';
  const found = await scanLogs(startTime, [structuredNeedle, emfNeedle]);

  assert.ok(found.has(structuredNeedle), "no structured Powertools log line found in Api logs");
  console.warn('✓ structured JSON logs present ("service":"opensender")');
  assert.ok(found.has(emfNeedle), 'no EMF blob carrying the "sends" metric found in Api logs');
  console.warn('✓ EMF "sends" metric emitted');

  console.warn("\nM10 observability acceptance passed.");
} finally {
  await apiKeys.deleteKey(teamId, key.key.keyId);
  console.warn("cleaned up verify key");
}
