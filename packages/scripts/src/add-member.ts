import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/**
 * Adds an existing dashboard user to an organization (team) with a role,
 * through the same server-side better-auth API the dashboard uses. Needed
 * because `create-user` creates the user without any team membership.
 *
 * Usage:
 *   pnpm exec tsx src/add-member.ts --stage production --email a@b.c --org <slug-or-id> [--role owner|admin|member]
 */

const { values } = parseArgs({
  options: {
    stage: { type: "string" },
    email: { type: "string" },
    org: { type: "string" },
    role: { type: "string", default: "member" },
  },
});

const { stage, email, org, role } = values;
if (!email || !org || (role !== "owner" && role !== "admin" && role !== "member")) {
  console.error(
    "usage: add-member --stage <stage> --email <email> --org <slug-or-id> [--role owner|admin|member]",
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

const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const { SESv2Client } = await import("@aws-sdk/client-sesv2");
const { Resource } = await import("sst");
const { createAuth, createTeamEntity, SesEmailProvider, TeamsService } = await import(
  "@opensender/core"
);
const { instanceConfig } = await import("../../../instance.config.js");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const table = Resource.Table.name;

const teams = new TeamsService({
  teams: createTeamEntity({ client, table }),
  emailProvider: new SesEmailProvider(new SESv2Client({}), {
    region: instanceConfig.region,
    accountId: process.env.AWS_ACCOUNT_ID ?? "",
  }),
  config: { plans: instanceConfig.plans, defaultPlan: instanceConfig.defaultPlan },
  clock: () => new Date(),
});

const auth = createAuth({
  client,
  table,
  secret: Resource.BetterAuthSecret.value,
  baseURL: `https://api.${instanceConfig.domain}`,
  trustedOrigins: [`https://${instanceConfig.domain}`],
  dashboardOrigin: `https://${instanceConfig.domain}`,
  signupOpen: instanceConfig.signupOpen,
  teams,
});

const ctx = await auth.$context;
const user = await ctx.internalAdapter.findUserByEmail(email);
if (!user) {
  console.error(`no user with email ${email}`);
  process.exit(1);
}

const organizations = await ctx.adapter.findMany<{ id: string; slug: string; name: string }>({
  model: "organization",
});
const organization = organizations.find((o) => o.id === org || o.slug === org);
if (!organization) {
  console.error(`no organization with slug or id ${org}`);
  process.exit(1);
}

const members = await ctx.adapter.findMany<{ userId: string }>({
  model: "member",
  where: [{ field: "organizationId", value: organization.id }],
});
if (members.some((m) => m.userId === user.user.id)) {
  console.warn(`${email} is already a member of ${organization.name}`);
  process.exit(0);
}

await auth.api.addMember({
  body: { userId: user.user.id, organizationId: organization.id, role },
});
console.warn(`added ${email} to ${organization.name} (${organization.id}) as ${role}`);
