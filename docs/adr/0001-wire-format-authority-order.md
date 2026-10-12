# ADR 0001 — Wire-format authority order: fixtures > docs > spec

Date: 2026-08-08 · Status: accepted

## Context

opensender must be a byte-level Resend clone: the official `resend` SDK is the
acceptance judge. We hold three descriptions of the wire format that
contradict each other in places:

1. **Golden fixtures** — 37 request/response pairs captured from the live
   Resend API on 2026-08-08 (`packages/contract/fixtures/resend/`).
2. **Official Resend docs.**
3. **Vendored OpenAPI spec** — `resend.yaml` pinned to upstream commit
   `b3697d45d9d0336bc851ff8f46b1d85e417e5e25` (v1.5.0).

Observed contradictions are not edge cases: the spec defines zero 4xx/5xx
responses; the docs' `invalid_api_key`/403 never appears on the wire (reality:
400 `validation_error`); list envelopes include `has_more` where the spec says
otherwise; timestamps serialize Postgres-style, not ISO.

## Decision

Wire-format conflicts resolve strictly in this order:

**golden fixtures > official Resend docs > vendored OpenAPI spec.**

Fixtures are observed reality; docs fill what was never captured; the spec is
scaffolding (types, route inventory). The fixtures are vendored into
`packages/contract` and conformance tests replay them against our handlers.

## Consequences

- A fixture is never "corrected" to match docs or spec; upstream quirks
  (e.g. contact delete's id field named `contact`) are replicated verbatim.
- Uncaptured shapes (domain create/delete success bodies — plan-limited on the
  capture account) follow docs, then spec, and are flagged in tests as
  non-fixture-backed.
- Re-pinning the spec is deliberate: `pnpm --filter @opensender/contract sync`
  shows the upstream drift; the pin moves only with a reviewed diff and a
  passing conformance suite.
