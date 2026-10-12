# Setup

Steps to stand up an opensender instance (see the README for the full flow).

## Secrets (set before `sst deploy`)

SST secrets are never committed — set each one with `sst secret set`:

```sh
sst secret set BetterAuthSecret <value> --stage production
sst secret set SentryDsn <dsn> --stage production
# HMAC key backing signed one-click unsubscribe tokens (SPEC §11.2).
# Use a long random value, e.g. `openssl rand -hex 32`.
sst secret set UnsubscribeSecret <random> --stage production
```

A missing `UnsubscribeSecret` fails the deploy: the Api and BroadcastFanout
functions both link it.

```sh
# Frontend (public) Sentry DSN, injected into the SPA build (SPEC §15).
sst secret set SentryDsnWeb <public-dsn> --stage production
```

## `.env` (local, never committed)

Build/ops tooling reads these from `.env` (git-ignored). Not SST secrets:

- `BETTERSTACK_API_TOKEN` — Better Stack Uptime API token, for the monitor +
  status-page setup script.
- `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` — enable build-time
  Sentry **sourcemap upload** (`@sentry/esbuild-plugin`). The auth token is a
  Sentry project token with `project:releases`/`project:write` scope — NOT the
  DSN. Absent ⇒ sourcemap upload is a no-op.

## One-time operator steps (after the first deploy)

These need the AWS/console or an external account and cannot be done in IaC:

1. **Confirm the OpsAlerts email subscription.** AWS sends a confirmation email
   to `alertEmail`; click it or no alert emails deliver.
2. **Cost-allocation tags.** Billing → Cost allocation tags → activate `app`
   and `stage` (user-defined). Data appears ~24h later; until then the budget's
   tag filter and the weekly cost report track nothing. A `sst deploy` after
   activation re-applies the budget's tag filter (AWS silently drops it while
   the tag is inactive).
3. **Billing alerts + Cost Explorer.** Billing preferences → enable "Receive
   billing alerts" (drives the dashboard estimated-charges widget) and enable
   Cost Explorer once (the weekly cost cron needs it; data ~24h later).
4. **Cost Anomaly Detection.** Account-global (one SERVICE monitor per account).
   Confirm the account monitor is on with a daily email subscription.
5. **Better Stack.** `pnpm --filter @opensender/scripts exec tsx
   src/setup-betterstack.ts` (idempotent) creates the `/health` monitor + a
   public status page from `BETTERSTACK_API_TOKEN`.
6. **Sentry sourcemaps (optional).** Add the `SENTRY_*` vars above, then
   `sst deploy`; verify a forced test exception resolves to original source.

## Post-run credential hygiene (R09 §6)

Once the instance is up and the admin user is bootstrapped, **rotate or
deactivate the broad bootstrap IAM key** used for the first deploy and switch to
a least-privilege deploy identity. See the README runbook.
