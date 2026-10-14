import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/**
 * Imports a domain whose SES identity ALREADY exists in the account (created
 * outside opensender, e.g. by Terraform for other SMTP senders) into a team.
 * `createDomain` cannot do this: CreateEmailIdentity fails with
 * AlreadyExists, and deleting the identity would rotate its DKIM keys and
 * break the other senders.
 *
 * The identity itself is left untouched (DKIM, MAIL FROM, default config
 * set). Opensender passes its configuration set and tenant on every send, so
 * it only needs: its own configuration set, both resources associated with
 * the team's SES tenant, and the Domain row.
 *
 * Usage:
 *   pnpm exec tsx src/import-domain.ts --stage production --domain example.com --org <slug-or-id> [--apply]
 * Without --apply it prints what it would do and writes nothing.
 */

const { values } = parseArgs({
  options: {
    stage: { type: "string" },
    domain: { type: "string" },
    org: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});

const { stage, domain, org, apply } = values;
if (!domain || !org) {
  console.error(
    "usage: import-domain --stage <stage> --domain <domain> --org <slug-or-id> [--apply]",
  );
  process.exit(1);
}

if (!process.env.SST_RESOURCE_App) {
  const self = fileURLToPath(import.meta.url);
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "sst",
      "shell",
      ...(stage ? ["--stage", stage] : []),
      "--",
      "tsx",
      self,
      ...process.argv.slice(2),
    ],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

const { randomUUID } = await import("node:crypto");
const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const { GetEmailIdentityCommand, SESv2Client } = await import("@aws-sdk/client-sesv2");
const { Resource } = await import("sst");
const { createDomainEntity, createTeamEntity, domainStatus, SesEmailProvider, TeamsService } =
  await import("@opensender/core");
const { instanceConfig } = await import("../../../instance.config.js");

const name = domain.toLowerCase();
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const table = Resource.Table.name;
const ses = new SESv2Client({});
const emailProvider = new SesEmailProvider(ses, {
  region: instanceConfig.region,
  accountId: process.env.AWS_ACCOUNT_ID ?? "",
});
const teams = new TeamsService({
  teams: createTeamEntity({ client, table }),
  emailProvider,
  config: { plans: instanceConfig.plans, defaultPlan: instanceConfig.defaultPlan },
  clock: () => new Date(),
});
const domains = createDomainEntity({ client, table });

const existing = await domains.query.byName({ name }).go();
if (existing.data.length > 0) {
  console.error(`domain ${name} already exists in opensender (team ${existing.data[0]?.teamId})`);
  process.exit(1);
}

// Resolve the organization by slug or id; the team id IS the organization id.
const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
const orgItems: Record<string, unknown>[] = [];
let startKey: Record<string, unknown> | undefined;
do {
  const page = await client.send(
    new ScanCommand({
      TableName: table,
      FilterExpression: "begins_with(pk, :p)",
      ExpressionAttributeValues: { ":p": "ba#organization" },
      ExclusiveStartKey: startKey,
    }),
  );
  orgItems.push(...(page.Items ?? []));
  startKey = page.LastEvaluatedKey;
} while (startKey);
const organization = orgItems.find((o) => o.id === org || o.slug === org) as
  | { id: string; name: string }
  | undefined;
if (!organization) {
  console.error(`no organization with slug or id ${org}`);
  process.exit(1);
}
const team = await teams.getTeam(organization.id);
if (!team) {
  console.error(`organization ${organization.id} has no Team record`);
  process.exit(1);
}

const identity = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: name }));
const dkimStatus = identity.DkimAttributes?.Status ?? "NOT_STARTED";
const mailFromStatus = identity.MailFromAttributes?.MailFromDomainStatus ?? "NOT_STARTED";
const domainId = randomUUID();
const configurationSetName = `domain-${domainId}`;
const tracking = { clickTracking: false, openTracking: false };
const row = {
  domainId,
  teamId: team.teamId,
  name,
  region: instanceConfig.region,
  status: domainStatus(dkimStatus as never, mailFromStatus as never),
  ...tracking,
  tls: "opportunistic" as const,
  inboundEnabled: false,
  dkimTokens: identity.DkimAttributes?.Tokens ?? [],
  signingHostedZone: identity.DkimAttributes?.SigningHostedZone ?? "dkim.amazonses.com",
  configurationSetName,
  dkimStatus,
  mailFromStatus,
  inboundMxStatus: "PENDING",
  createdAt: new Date().toISOString(),
};

console.warn(
  `identity ${name}: verification ${identity.VerificationStatus}, DKIM ${dkimStatus}, MAIL FROM ${identity.MailFromAttributes?.MailFromDomain} ${mailFromStatus}`,
);
console.warn(`team ${organization.name} (${team.teamId}), SES tenant ${team.sesTenantName}`);
console.warn("plan:");
console.warn(
  `  1. create configuration set ${configurationSetName} (EventBridge destination, no tracking)`,
);
console.warn(
  `  2. associate identity ${emailProvider.identityArn(name)} with tenant ${team.sesTenantName}`,
);
console.warn(`  3. associate configuration set with tenant ${team.sesTenantName}`);
console.warn(`  4. write Domain row: ${JSON.stringify(row)}`);

if (!apply) {
  console.warn("dry run: nothing written (pass --apply)");
  process.exit(0);
}

const rollback: Array<() => Promise<void>> = [];
try {
  await emailProvider.createConfigurationSet(configurationSetName, tracking);
  rollback.push(() => emailProvider.deleteConfigurationSet(configurationSetName));
  await emailProvider.associateTenantResource(team.sesTenantName, emailProvider.identityArn(name));
  rollback.push(() =>
    emailProvider.disassociateTenantResource(team.sesTenantName, emailProvider.identityArn(name)),
  );
  await emailProvider.associateTenantResource(
    team.sesTenantName,
    emailProvider.configurationSetArn(configurationSetName),
  );
  rollback.push(() =>
    emailProvider.disassociateTenantResource(
      team.sesTenantName,
      emailProvider.configurationSetArn(configurationSetName),
    ),
  );
  await domains.create(row).go();
  console.warn(`imported ${name} as domain ${domainId} (status ${row.status})`);
} catch (error) {
  for (const undo of rollback.reverse()) {
    await undo().catch((e) => console.error("rollback step failed", e));
  }
  throw error;
}
