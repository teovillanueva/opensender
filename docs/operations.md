# Operations

Everything runs on native CloudWatch plus free tiers; there's no paid SaaS in
the loop. Operator alerts all go to one place: the `OpsAlerts` SNS topic, which
emails the instance's `alertEmail`. That covers every CloudWatch alarm, tenant
freezes and restores, reputation auto-freezes and the weekly cost report
fallback.

## Observability

| What | Where |
| --- | --- |
| **Dashboard** | CloudWatch dashboard `opensender-production`: SES volume and reputation, DLQ depth, API health, custom metrics (`sends`, `deliveries`, `bounces`, `complaints`, `webhook_deliveries`, `webhook_failures`, `inbound_received`, `domains_verified`) and estimated charges |
| **Logs** | Structured JSON (Powertools), 30-day retention on every Lambda. INFO is sampled ~10%; WARN and ERROR always emit. Correlate by `requestId`, `emailId` or `teamId` |
| **Errors** | Sentry for every Lambda and the dashboard. Sourcemaps upload at build time when the `SENTRY_*` variables are set ([setup](deploying.md#5-one-time-setup-after-the-first-deploy)) |
| **Uptime** | Better Stack monitor on `GET /health` (a light DynamoDB read, never SES) and a public status page |

## SES limits

SES starts in sandbox with a low quota and rate. Request production access and
higher quota/rate in the SES console (*Account dashboard → Request production
access*). Then set `sesMaxSendRatePerSecond` in `instance.config.ts` to the
granted rate, so broadcast fan-out paces under it.

## Rotating secrets

Secrets are SST secrets and never live in git. Rotate any of them
(`BetterAuthSecret`, `UnsubscribeSecret`, `SentryDsn`, `SentryDsnWeb`) with:

```bash
pnpm exec sst secret set <Name> <value> --stage production
pnpm exec sst deploy --stage production   # Lambdas pick up the new value
```

The admin bootstrap token (`/opensender/production/bootstrap-token` in SSM) is
re-emitted on every deploy and is useless once any user exists.

## Dead-letter queues

`EmailEvents`, `WebhookDeliveries` and `BroadcastFanout` each have a DLQ, and a
depth alarm fires when any of them holds messages. To recover:

1. Inspect the messages in the SQS console and fix the cause.
2. On the DLQ, **Start DLQ redrive** back to the source queue.

Handlers are idempotent, so redelivery is safe.

## Paused or frozen teams

A team gets frozen (`status = frozen`, sends return `403 restricted`, operator
alerted) when:

- **SES pauses its tenant.** The `TenantStatus` function reacts to the SES
  event.
- **Its reputation crosses the guardrails.** Daily hard-bounce rate above 5% or
  complaint rate above 0.1% (configurable in `guardrails`), once the window has
  enough recipients to judge. Rates are per recipient, like SES computes them,
  and soft (`Transient`) bounces never count.

To restore it, fix the underlying issue, then either re-enable the tenant in SES
(the `REINSTATED`/`ENABLED` event restores the team automatically) or set the
team back to `active` by hand. A manual re-enable is respected: the auto-freeze
only acts on teams that are currently active.

## Costs

- **Budget:** AWS Budgets alerts at 50/80/100% of `monthlyBudgetUsd`.
- **Weekly report:** the `CostReport` cron queries Cost Explorer for
  `app=opensender` and emails the per-service breakdown through the platform
  itself, falling back to `OpsAlerts` if there's no verified domain yet. Run it
  now with `aws lambda invoke --function-name <CostReport function> /dev/stdout`.
- Both need Cost Explorer enabled and the `app` cost-allocation tag activated
  ([setup](deploying.md#5-one-time-setup-after-the-first-deploy)).

## Credentials

The first deploy uses a broad IAM key. Once the instance is up and the admin
exists, rotate or deactivate it and deploy with a least-privilege identity, or
let [Autodeploy](updating-instances.md#deploy-on-push-with-sst-console-autodeploy)
deploy from inside the account.
