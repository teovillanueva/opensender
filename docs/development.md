# Development

## Repo layout

A pnpm workspace with one package per concern:

| Package | What it is |
| --- | --- |
| `packages/contract` | The API contract: Resend's OpenAPI spec (vendored, pinned) plus `extensions.yaml`, bundled into `openapi.json`, with generated TypeScript types, Ajv validators and golden fixtures captured from the real Resend API |
| `packages/core` | Domain logic, ports and adapters. AWS SDKs are only imported under `core/adapters/` |
| `packages/api` | The Hono app, typed against the contract |
| `packages/functions` | Lambda entry points, one composition root each |
| `packages/web` | The dashboard (Vite + React) |
| `packages/scripts` | Seeds, operator scripts, the acceptance suite |

Infrastructure lives in `sst.config.ts` and `infra/`. Per-instance values live
in `instance.config.ts`, with their schema in `instance.config.types.ts`.

## Checks

```bash
pnpm install
pnpm check      # typecheck, Biome, dependency-cruiser, knip, offline tests
pnpm codegen    # regenerate the contract bundle and types
```

CI runs `pnpm check` plus a codegen gate: regenerating the contract must
produce no diff, so commit generated files together with their sources.

## Running against AWS

There is a single stage, `production`. For local development:

```bash
pnpm exec sst dev --stage production
```

This shares the deployed resources: while it runs, SST Live mode routes the
stage's Lambda invocations to your machine. That's fine before launch; once real
traffic exists, create a separate `dev` stage instead.

## Acceptance suite

Runs the whole flow against a deployed instance through the official Resend
SDK, with recipients restricted to the SES mailbox simulator:

```bash
pnpm exec sst shell --stage production -- tsx packages/scripts/acceptance/index.ts
```

Set `ACCEPTANCE_CAPTURE_URL` to also exercise webhook delivery and Svix
signature verification against a capture endpoint. Contract fuzzing with
Schemathesis is on demand only; see `packages/scripts/acceptance/schemathesis.md`.

## Design docs

- [Specification](../SPEC.md): the full product and engineering spec.
- [Architecture decisions](adr): ADRs.
- [Glossary](glossary.md): the domain language used across code and docs.
