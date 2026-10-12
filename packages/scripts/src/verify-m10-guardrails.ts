import assert from "node:assert/strict";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  ApiKeysService,
  createApiKeyEntity,
  createDomainEntity,
  createTeamEntity,
  TeamsService,
} from "@opensender/core";
import { Resource } from "sst";
import { instanceConfig } from "../../../instance.config.js";

/**
 * M10 guardrail verify (SPEC §12), run under `sst shell --stage production`.
 * Exercises the DEPLOYED tenant-status handler end to end by invoking it with a
 * synthetic SES sending-status event for the real verified-domain team's
 * tenant (AWS itself only emits the event when a tenant is actually paused,
 * which would disrupt production sending — invoking the live Lambda with the
 * exact event shape proves our handling without that side effect):
 *
 *   DISABLED  ⇒ team frozen ⇒ POST /emails rejected 403 "restricted"
 *   ENABLED   ⇒ team active ⇒ POST /emails accepted
 *
 * The team's original status is captured and restored in `finally`.
 */

const apiBase = (process.argv[2] ?? "https://api.mailing.example.com").replace(/\/$/, "");
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const table = Resource.Table.name;
const lambda = new LambdaClient({});
const sts = new STSClient({});

const domainEntity = createDomainEntity({ client: dynamo, table });
const teams = new TeamsService({
  teams: createTeamEntity({ client: dynamo, table }),
  // The verify never creates a tenant; a throwing provider guards that.
  emailProvider: new Proxy({} as never, {
    get() {
      throw new Error("email provider must not be used by the guardrail verify");
    },
  }),
  config: { plans: instanceConfig.plans, defaultPlan: instanceConfig.defaultPlan },
  clock: () => new Date(),
});
const apiKeys = new ApiKeysService({
  apiKeys: createApiKeyEntity({ client: dynamo, table }),
  clock: () => new Date(),
  idGenerator: () => crypto.randomUUID(),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tenantStatusEvent(sesTenantName: string, accountId: string, sesStatus: string) {
  return {
    version: "0",
    "detail-type": sesStatus === "DISABLED" ? "Sending Status Disabled" : "Sending Status Enabled",
    source: "aws.ses",
    account: accountId,
    region: instanceConfig.region,
    resources: [
      `arn:aws:ses:${instanceConfig.region}:${accountId}:tenant/${sesTenantName}/tn-verify-synthetic`,
    ],
    detail: {
      version: "1.0.0",
      data: {
        origin: "CUSTOMER_MANAGED",
        record: { status: sesStatus, cause: "M10 guardrail verify (synthetic)" },
      },
    },
  };
}

async function invokeTenantStatus(payload: unknown): Promise<void> {
  const res = await lambda.send(
    new InvokeCommand({
      FunctionName: Resource.TenantStatus.name,
      Payload: Buffer.from(JSON.stringify(payload)),
    }),
  );
  assert.equal(res.FunctionError, undefined, `TenantStatus errored: ${res.FunctionError}`);
}

async function sendViaApi(token: string, from: string) {
  const res = await fetch(`${apiBase}/emails`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      from,
      to: "success@simulator.amazonses.com",
      subject: "opensender M10 guardrail verify",
      html: "<p>Guardrail verify. Please ignore.</p>",
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function waitForStatus(teamId: string, want: "active" | "frozen"): Promise<string> {
  for (let i = 0; i < 15; i += 1) {
    const team = await teams.getTeam(teamId);
    if (team?.status === want) return want;
    await sleep(1000);
  }
  return (await teams.getTeam(teamId))?.status ?? "unknown";
}

const { Account: accountId } = await sts.send(new GetCallerIdentityCommand({}));
assert.ok(accountId, "could not resolve AWS account id");

const scan = await domainEntity.scan.go({ pages: "all" });
const verified = (scan.data as Array<{ teamId: string; name: string; status: string }>).find(
  (d) => d.status === "verified",
);
assert.ok(verified, "no verified domain found in production");
const teamId = verified.teamId;
const fromAddress = `noreply@${verified.name}`;
const original = await teams.getTeam(teamId);
assert.ok(original, `no Team record for ${teamId}`);
const sesTenantName = original.sesTenantName;
console.warn(`Using team ${teamId} (tenant ${sesTenantName}), from ${fromAddress}`);

const key = await apiKeys.createKey({ teamId, name: "m10-guardrail", permission: "full_access" });

try {
  // 1. DISABLED event ⇒ team frozen.
  await invokeTenantStatus(tenantStatusEvent(sesTenantName, accountId, "DISABLED"));
  assert.equal(await waitForStatus(teamId, "frozen"), "frozen", "team was not frozen by DISABLED");
  console.warn("✓ DISABLED event froze the team");

  // 2. Frozen ⇒ POST /emails rejected 403 "restricted".
  const rejected = await sendViaApi(key.token, fromAddress);
  assert.equal(rejected.status, 403, `expected 403 while frozen, got ${rejected.status}`);
  assert.equal((rejected.body.name ?? rejected.body.error) as string, "restricted");
  console.warn(
    `✓ send rejected while frozen (403 "${rejected.body.name}"): ${rejected.body.message}`,
  );

  // 3. ENABLED event ⇒ team active again.
  await invokeTenantStatus(tenantStatusEvent(sesTenantName, accountId, "ENABLED"));
  assert.equal(await waitForStatus(teamId, "active"), "active", "team was not restored by ENABLED");
  console.warn("✓ ENABLED event restored the team");

  // 4. Active ⇒ POST /emails accepted.
  const accepted = await sendViaApi(key.token, fromAddress);
  assert.equal(accepted.status, 200, `expected 200 after restore, got ${accepted.status}`);
  assert.ok(accepted.body.id, "no email id after restore");
  console.warn(`✓ send accepted after restore (id=${accepted.body.id})`);

  console.warn("\nM10 guardrail acceptance passed.");
} finally {
  await apiKeys.deleteKey(teamId, key.key.keyId);
  if (original.status !== (await teams.getTeam(teamId))?.status) {
    await teams.setStatus(teamId, original.status);
  }
  console.warn(`cleaned up key; team status restored to ${original.status}`);
}
