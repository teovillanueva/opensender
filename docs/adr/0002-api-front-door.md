# ADR 0002 — API front door: Function URL behind CloudFront (SST Router)

Date: 2026-08-08 · Status: accepted

## Context

The public API needs a custom domain (`api.mailing.example.com`), request bodies
up to ~6 MB (inline attachments), and origin waits beyond 30 s (server-side
`attachments[].path` downloads at M3). Candidates: API Gateway HTTP API, ALB,
or a Lambda Function URL behind CloudFront.

## Decision

**SST `Router` (CloudFront) + Hono on a Lambda Function URL**
(`url: { router }`), per R04:

- API Gateway HTTP API is disqualified: 30 s hard integration timeout,
  512 KB-increment pricing on large bodies, no response streaming.
- Function URL auth stays `NONE` and the origin has **no OAC** — OAC forces
  clients to send `x-amz-content-sha256` on POST, which the Resend SDK does
  not do. Auth is app-level bearer only.
- Route `readTimeout` is 120 s. SST's docs claim a 60 s ceiling, but the
  value flows unvalidated into the CloudFront function's
  `cf.updateRequestOrigin()`, and this account's "Response timeout per
  origin" quota (L-AECE9FA7) is already 120 — verified at deploy.

## Consequences

- The raw `*.lambda-url.*` endpoint stays reachable; it serves the same
  app-level auth so this is harmless. Revisit only if it becomes an abuse
  vector.
- Lambda sync invoke caps requests at 6 MB (~4.5 MB of raw attachment bytes);
  larger attachments must use `attachments[].path` (documented in docs/sending-email.md).
- A future SST upgrade that starts validating the 60 s JSDoc cap would fail
  the deploy loudly — the fallback is a `transform` on the distribution, not
  a silent downgrade.
