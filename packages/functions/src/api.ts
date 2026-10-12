import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { createApp } from "@opensender/api";
import {
  BootstrapService,
  createAuth,
  createOAuthGrants,
  createOAuthTokenVerifier,
} from "@opensender/core";
import * as Sentry from "@sentry/aws-serverless";
import { handle } from "hono/aws-lambda";
import { Resource } from "sst";
import { instanceConfig } from "../../../instance.config.js";
import {
  createApiKeysService,
  createBroadcastSender,
  createBroadcastsService,
  createContactsService,
  createDomainsService,
  createEmailProvider,
  createEmailsService,
  createIdempotencyStore,
  createQuotaCounters,
  createRateLimiter,
  createSegmentsService,
  createTeamsService,
  createUnsubscribeContacts,
  createWebhookReplayPublisher,
  createWebhooksService,
  dynamo,
  getUnsubscribeSecret,
  table,
} from "./context.js";
import { logger, withObservability } from "./observability.js";
import { withSentry } from "./sentry.js";

/** Composition root for the API Lambda (SPEC §2.1). */

const provider = createEmailProvider();
const teams = createTeamsService(provider);

// Last successful /health DynamoDB read (epoch ms); throttles the probe.
let lastHealthyAt = 0;

const apiBaseURL = `https://api.${instanceConfig.domain}`;

const auth = createAuth({
  client: dynamo,
  table,
  secret: Resource.BetterAuthSecret.value,
  baseURL: apiBaseURL,
  trustedOrigins: [`https://${instanceConfig.domain}`],
  dashboardOrigin: `https://${instanceConfig.domain}`,
  signupOpen: instanceConfig.signupOpen,
  teams,
});

const ssm = new SSMClient({});
let cachedBootstrapToken: string | undefined;
async function expectedToken(): Promise<string> {
  if (!cachedBootstrapToken) {
    const result = await ssm.send(
      new GetParameterCommand({
        Name: process.env.BOOTSTRAP_TOKEN_PARAM,
        WithDecryption: true,
      }),
    );
    cachedBootstrapToken = result.Parameter?.Value ?? "";
  }
  return cachedBootstrapToken;
}

const domains = createDomainsService(provider, teams);
const quotas = createQuotaCounters();
const oauthGrants = createOAuthGrants(auth);

const app = createApp({
  apiKeys: createApiKeysService(),
  teams,
  domains,
  emails: createEmailsService(provider, teams, domains),
  webhooks: createWebhooksService(),
  segments: createSegmentsService(),
  contacts: createContactsService(),
  broadcasts: createBroadcastsService(),
  broadcastSender: createBroadcastSender(),
  unsubscribeContacts: createUnsubscribeContacts(),
  unsubscribeSecret: getUnsubscribeSecret(),
  webhookReplay: createWebhookReplayPublisher(),
  idempotency: createIdempotencyStore(),
  quotaUsage: (teamId) => quotas.current(teamId),
  now: () => new Date(),
  rateLimiter: createRateLimiter(),
  auth,
  oauthTokens: createOAuthTokenVerifier({ auth, baseURL: apiBaseURL, grants: oauthGrants }),
  oauthGrants,
  bootstrap: new BootstrapService({ auth, expectedToken }),
  dashboardOrigin: `https://${instanceConfig.domain}`,
  apiOrigin: apiBaseURL,
  // Liveness probe: a single GetItem on a sentinel key exercises DynamoDB
  // connectivity + IAM without touching SES (SPEC §15). The item need not
  // exist — the read itself is the check. `/health` is unauthenticated and
  // unthrottled (it sits outside the rate-limited `authed` group), so cache a
  // recent success for 30s: this bounds the backend read to ~once per 30s per
  // warm container, well under Better Stack's 3-min poll, so the endpoint can't
  // be flooded into DynamoDB/Lambda cost amplification.
  health: async () => {
    if (Date.now() - lastHealthyAt < 30_000) return;
    await dynamo.send(
      new GetCommand({ TableName: table, Key: { pk: "health#check", sk: "health#check" } }),
    );
    lastHealthyAt = Date.now();
  },
  // Unhandled route errors are caught by Hono's onError (so they never reach
  // Sentry's handler wrapper); log them structured and forward to Sentry here.
  logger: {
    error(message, extra) {
      if (extra) logger.error(message, extra);
      else logger.error(message);
      const cause = extra?.error;
      if (cause !== undefined) Sentry.captureException(cause);
    },
  },
});

export const handler = withSentry(withObservability(handle(app)));
