import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/**
 * Creates a dashboard user (better-auth) directly against the stage's table,
 * bypassing `signupOpen: false` the same way BootstrapService does: a
 * server-side `auth.api.createUser` call with no request headers.
 *
 * Usage (from packages/scripts, or via `pnpm --filter @opensender/scripts`):
 *   pnpm create-user --stage production --email a@b.c --name "Ada" [--password ...] [--role admin]
 *
 * When invoked outside `sst shell`, it re-execs itself under
 * `sst shell --stage <stage>` so `Resource.*` resolves for that stage.
 */

const { values } = parseArgs({
  options: {
    stage: { type: "string" },
    email: { type: "string" },
    name: { type: "string" },
    password: { type: "string" },
    role: { type: "string", default: "user" },
  },
});

const { stage, email, name, password, role } = values;
if (!email || !name || (role !== "user" && role !== "admin")) {
  console.error(
    "usage: create-user --stage <stage> --email <email> --name <name> [--password <password>] [--role user|admin]",
  );
  process.exit(1);
}

// Outside `sst shell` the SST_RESOURCE_* env vars are absent — re-exec under
// it so `Resource.Table` / `Resource.BetterAuthSecret` resolve for the stage.
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

// Same wiring as the API Lambda's composition root; the teams service only
// matters for the org-creation hook, which createUser never fires.
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

const generatedPassword = password ?? randomBytes(12).toString("base64url");
const result = await auth.api.createUser({
  body: { email, name, password: generatedPassword, role },
});

console.warn(`created user ${result.user.id} (${email}, role: ${role})`);
if (!password) {
  console.warn(`generated password: ${generatedPassword}`);
}
