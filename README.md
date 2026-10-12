# opensender

A redeployable, self-hosted email platform that is a 100% API-compatible clone
of [Resend](https://resend.com): any application using the official Resend SDK
works against it changing nothing but the `baseURL`. Runs entirely on AWS
(SES v2 tenants, Lambda, DynamoDB, CloudFront) via [SST](https://sst.dev).

Each instance serves the dashboard on its domain (e.g. `mailing.example.com`)
and the API at `api.<domain>`.

## Deploying an instance

1. Fork the repo and edit `instance.config.ts` (domain, region, plans, alert
   email). Keep the fork's changes to that file so upstream merges stay clean;
   its schema lives in `instance.config.types.ts`.
2. DNS (`dnsMode: "route53"`): the instance domain needs a Route 53 hosted
   zone in the target account. If the parent domain lives elsewhere (Vercel,
   Cloudflare, …), create a zone for the instance subdomain only
   (e.g. `mailing.example.com`) and add its four `NS` records at the parent's
   DNS provider.
3. Point AWS credentials at the target account (a dedicated `AWS_PROFILE` per
   instance avoids deploying to the wrong one).
4. Set the secrets listed in `SETUP.md` (`sst secret set <Name> <value>
   --stage production`).
5. `pnpm install && pnpm exec sst deploy --stage production`.

There is exactly one stage, `production`. Local development is
`sst dev --stage production`, which shares the deployed resources; while it
runs, SST Live mode redirects the stage's Lambda invocations to your machine —
fine pre-launch. Create a separate `dev` stage only when real customer traffic
exists.

## Request limits

The API sits behind a Lambda Function URL (sync invoke), which caps requests
at **6 MB** — inline base64 attachments top out at ~4.5 MB of raw bytes per
request. Larger attachments must use `attachments[].path` (server-side
download; SES's overall message cap is 40 MB post-base64).

## Repo layout

pnpm workspaces, one package per concern (SPEC §2):

- `packages/contract` — the normative API surface: vendored `resend.yaml`
  (pinned) + `extensions.yaml` → bundled `openapi.json`, generated TS types,
  Ajv validators, golden fixtures.
- `packages/core` — domain logic, ports and adapters. Never imports AWS SDKs
  outside `core/adapters/`.
- `packages/api` — the Hono app, typed against the contract.
- `packages/functions` — Lambda entry points (one composition root each).
- `packages/web` — the dashboard (Vite + React).
- `packages/scripts` — seeds, acceptance suite, fixture capture.

`pnpm check` runs everything CI runs: typecheck, Biome, dependency-cruiser,
knip, offline tests, and the contract codegen gate.

Architecture decisions live in `docs/adr/`.

## Runbook (operations)

Everything runs on native CloudWatch + free tiers; there is no paid SaaS. The
operator alert channel is the `OpsAlerts` SNS topic → the instance alert email
(all CloudWatch alarms, tenant freeze/restore, reputation auto-freeze, the
weekly cost report fallback). One-time setup is in `SETUP.md`.

### Observability

- **Dashboard:** CloudWatch dashboard `opensender-<stage>` — SES volume &
  reputation, DLQ depth, API health, the custom EMF metrics (`sends`,
  `deliveries`, `bounces`, `complaints`, `webhook_deliveries`,
  `webhook_failures`, `inbound_received`, `domains_verified`), and account-wide
  estimated charges.
- **Logs:** Powertools structured JSON, 30-day retention on every Lambda log
  group. INFO is sampled ~10%; WARN/ERROR always emit. Correlate by
  `requestId`/`emailId`/`teamId`.
- **Errors:** Sentry (all Lambdas + the frontend). Sourcemaps upload at build
  time once `SENTRY_AUTH_TOKEN`/`SENTRY_ORG`/`SENTRY_PROJECT` are set (SETUP).
- **Uptime:** Better Stack monitor on `GET /health` (a light DynamoDB read,
  never SES) + a public status page. Provision with
  `pnpm --filter @opensender/scripts exec tsx src/setup-betterstack.ts`
  (idempotent; reads `BETTERSTACK_API_TOKEN` from `.env`).

### Account limits and raises

SES starts in sandbox with a low quota and rate. Request production access and
higher send quota/rate in the SES console (Account dashboard → Request
production access / increase). Reflect the account send rate in
`instance.config.ts` `sesMaxSendRatePerSecond` so the broadcast fan-out paces
under it. The API Function URL caps a request at 6 MB (see Request limits).

### Secret rotation

Secrets are SST secrets (never in git). Rotate with `sst secret set <Name>
<value> --stage production` then `sst deploy` (Lambdas pick up the new value on
the next deploy). Rotate `BetterAuthSecret`, `SentryDsn`/`SentryDsnWeb`,
`UnsubscribeSecret` the same way. The one-time admin bootstrap token
(`/opensender/<stage>/bootstrap-token` in SSM) is re-emitted on deploy and stops
working as soon as any user exists.

### DLQ redrive

Three queues have DLQs (`EmailEvents`, `WebhookDeliveries`, `BroadcastFanout`).
A DLQ-depth alarm fires when any has messages. Inspect the DLQ in the SQS
console, fix the cause, then **Start DLQ redrive** (SQS console → the DLQ →
Start DLQ redrive → to source queue). Messages re-enter the source queue and the
consumer reprocesses them (handlers are idempotent, so redelivery is safe).

### SES paused tenant (guardrails)

If SES pauses a tenant, the `TenantStatus` Lambda freezes the owning team
(`Team.status = frozen`), sends return `403 restricted`, and the operator is
alerted. The reputation auto-freeze does the same when a team's rolling bounce
rate exceeds 5% or complaint rate exceeds 0.1% past the minimum sample. To
restore: resolve the underlying issue, re-enable the tenant in SES (a
`REINSTATED`/`ENABLED` event auto-restores the team), or set the team back to
`active` manually. Manual re-enable is respected — the auto-freeze only acts on
currently-active teams.

### Weekly cost summary

The `CostReport` cron (weekly) queries Cost Explorer filtered to
`app=opensender` and mails the per-service breakdown through the platform
itself, falling back to `OpsAlerts` if no verified domain exists. Run it now
with `aws lambda invoke --function-name <CostReport fn> /dev/stdout`. Requires
Cost Explorer enabled and the `app` cost-allocation tag activated (SETUP).

### Post-run credential hygiene (R09 §6)

The bootstrap deploy uses a broad IAM key. After the instance is up and the
admin user is bootstrapped, **rotate or deactivate that bootstrap IAM key** in
IAM and switch day-to-day operations to a least-privilege deploy identity. Do
not leave the bootstrap key active.

### Acceptance suite

`sst shell --stage production -- tsx packages/scripts/acceptance/index.ts`
runs the full flow against production via the official Resend SDK (recipients
restricted to the SES simulator). Set `ACCEPTANCE_CAPTURE_URL` to run the
webhook receive + svix-verify step against a stable capture endpoint. Contract
fuzzing (Schemathesis) is on-demand — see
`packages/scripts/acceptance/schemathesis.md`.
