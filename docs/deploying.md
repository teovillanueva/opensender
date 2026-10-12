# Deploying an instance

An **instance** is one independent deployment of opensender: its own AWS
account, domain, configuration and data. Instances know nothing about each
other. This guide takes you from an empty AWS account to a running dashboard
and API.

## Prerequisites

- An AWS account dedicated to the instance, with credentials that can deploy
  (the first deploy needs broad permissions; see
  [credential hygiene](#5-tighten-credentials)).
- A domain you control, e.g. `mailing.example.com`. The dashboard is served
  there and the API at `api.mailing.example.com`.
- Node.js 22+ and pnpm.
- A region where SES supports inbound receiving: `us-east-1`, `us-west-2` or
  `eu-west-1`.

## 1. Create your instance repo

Keep each instance in its own **private** repo, with this repo as `upstream`,
so you can pull improvements later:

```bash
git clone https://github.com/teovillanueva/opensender my-mailing
cd my-mailing
git remote rename origin upstream
git remote add origin git@github.com:<you>/my-mailing.git
git push -u origin main
```

Don't use GitHub's fork button: a fork of a public repo is always public, and
your instance config would be too. [Keeping an instance up to
date](updating-instances.md) covers the sync.

## 2. Configure the instance

Edit `instance.config.ts`. It holds values only; the schema and docs for every
field live in `instance.config.types.ts`, and upstream changes to the schema
merge cleanly because you never touch that file.

| Field | What it does |
| --- | --- |
| `instanceName` | Dashboard title and branding |
| `domain` | Dashboard domain; the API is `api.<domain>` |
| `region` | AWS region (inbound-capable: `us-east-1`, `us-west-2`, `eu-west-1`) |
| `dnsMode` | `route53` creates DNS records automatically (see below) |
| `alertEmail` | Where operator alerts go |
| `monthlyBudgetUsd` | AWS Budgets alerts at 50/80/100% of this |
| `signupOpen` | Whether anyone can sign up, or only invited users |
| `sesMaxSendRatePerSecond` | Your SES account send rate; broadcasts pace under it |
| `plans`, `defaultPlan` | Named quota profiles (daily limit, API rate) assigned to teams |
| `guardrails` | Bounce/complaint thresholds that auto-freeze a team |

Secrets never go in this file. They're SST secrets (step 4).

## 3. Set up DNS

With `dnsMode: "route53"`, the instance domain needs a Route 53 hosted zone in
the instance's AWS account. If the parent domain lives elsewhere (Cloudflare,
Vercel, another account…), create a zone for the instance subdomain only
(e.g. `mailing.example.com`) and add its four `NS` records at the parent's DNS
provider.

## 4. Deploy

Point your shell at the instance's AWS account. A dedicated `AWS_PROFILE` per
instance avoids deploying to the wrong one. Then set the secrets and deploy:

```bash
pnpm install

pnpm exec sst secret set BetterAuthSecret "$(openssl rand -hex 32)" --stage production
# HMAC key for signed one-click unsubscribe links. Required: the deploy fails without it.
pnpm exec sst secret set UnsubscribeSecret "$(openssl rand -hex 32)" --stage production
# Sentry DSNs: backend, and the public one injected into the dashboard build.
pnpm exec sst secret set SentryDsn <dsn> --stage production
pnpm exec sst secret set SentryDsnWeb <public-dsn> --stage production

pnpm exec sst deploy --stage production
```

There is exactly one stage, `production`. The deploy prints the dashboard URL,
the API URL and a `bootstrapToken`.

> [!NOTE]
> If you sign in with `aws login`, SST can't read that session directly.
> Export it first: `eval "$(aws configure export-credentials --format env)"`.

### Create the first admin

Open the dashboard at `https://<domain>/bootstrap` and enter the
`bootstrapToken`. It creates the first admin user and stops working as soon as
any user exists. The token is also stored in SSM at
`/opensender/production/bootstrap-token` and re-emitted on every deploy.

## 5. One-time setup after the first deploy

These need the AWS console or an external account, so they can't live in IaC:

1. **Confirm the alerts subscription.** AWS emails `alertEmail` a confirmation
   link for the `OpsAlerts` topic. Until you click it, no alert is delivered.
2. **Request SES production access.** New accounts start in the SES sandbox.
   Request production access and a higher quota/rate in the SES console, then
   set `sesMaxSendRatePerSecond` to the granted rate.
3. **Activate cost-allocation tags.** Billing → Cost allocation tags → activate
   `app` and `stage`. Data appears ~24h later; deploy again afterwards so the
   budget's tag filter is applied (AWS drops it while the tag is inactive).
4. **Billing alerts and Cost Explorer.** Billing preferences → enable *Receive
   billing alerts* (the dashboard's estimated-charges widget) and enable Cost
   Explorer once (the weekly cost report needs it).
5. **Cost Anomaly Detection.** It's account-wide: confirm the account's monitor
   is on with a daily email subscription.
6. **Uptime monitoring (optional).** With `BETTERSTACK_API_TOKEN` in `.env`,
   run `pnpm --filter @opensender/scripts exec tsx src/setup-betterstack.ts` to
   create a `/health` monitor and a public status page. It's idempotent.
7. **Sentry sourcemaps (optional).** Add `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and
   `SENTRY_PROJECT` to `.env` (a project token with `project:releases` /
   `project:write`, not the DSN) and deploy again.
8. <a id="5-tighten-credentials"></a>**Tighten credentials.** Once the admin
   exists, rotate or deactivate the broad IAM key used for the first deploy and
   switch to a least-privilege deploy identity, or let
   [Autodeploy](updating-instances.md#deploy-on-push-with-sst-console-autodeploy)
   deploy from CodeBuild in your account.

`.env` is git-ignored and only read by build and ops tooling; it never holds
SST secrets.

## Next

- [Send your first email](sending-email.md)
- [Keep the instance up to date and deploy on push](updating-instances.md)
- [Operate it](operations.md)
