# SPEC — opensender: a Resend-compatible email platform on AWS

**Wire-format authority order** ([ADR 0001](docs/adr/0001-wire-format-authority-order.md)):
golden fixtures > official Resend docs > vendored OpenAPI spec. The fixtures in
`packages/contract/fixtures/resend/` are observed reality captured from the live API;
docs fill what was never captured; the spec is scaffolding. Bracketed citations such as
[R03 §2] refer to research notes that are not part of this repository.

---

## 0. Product and goal

**opensender** is a redeployable, self-hosted email platform that is a **100%
API-compatible clone of Resend**: any application using the official Resend SDK must
work against it changing nothing but the `baseURL`. It runs entirely on AWS, is
multi-tenant (customers verify their own domains via DNS records at their own
provider — no nameserver delegation), and supports outbound, inbound, and webhooks.

It is a **product, not a one-off deployment**: a new **Instance** = clone the repo,
edit `instance.config.ts`, point AWS credentials at the target account, `sst deploy`.
Instance #1 is **acme** (see §20 for its concrete config).

Work proceeds by milestones (§18),
deploying and verifying each before continuing. Never advance past a broken milestone.

## 1. Golden rules (non-negotiable)

1. **Compatibility above all.** The contract lives in `packages/contract`:
   `resend.yaml` vendored from `resend/resend-openapi` **pinned to commit
   `b3697d45d9d0336bc851ff8f46b1d85e417e5e25`** (2026-07-29, spec v1.5.0), plus
   `extensions.yaml` for what the spec misses (the entire error contract — the
   upstream spec defines zero 4xx/5xx responses [R01 §1] — and our dashboard-internal
   endpoints, tagged `x-internal`), bundled into one `openapi.json`. Wire-format
   conflicts resolve by the authority order above.
2. **The judge is the official SDK.** The final acceptance criterion (§17) is a suite
   using `resend` from npm pointed at our API. If the suite passes, the clone is
   correct.
3. **Never invent AWS values.** Every SES v2 API name, field, enum, and limit used in
   this spec was verified against AWS docs on 2026-08-08 (R03). Anything beyond what
   R03 covers must be verified against the AWS SDK v3 docs before use.
4. **Strict TypeScript everywhere**, `"strict": true`, no `any` without a commented
   justification.
5. **Secrets only via SST secrets / SSM.** Nothing hardcoded, nothing in the repo.
   `.env` (AWS + Resend keys) is local-only and gitignored.

## 2. Stack and monorepo structure

- **Runtime/infra:** SST v3 (Ion) on AWS. Region from `instance.config.ts`, default
  `us-east-1` (inbound receiving requires us-east-1 / us-west-2 / eu-west-1 [R03 §6.1]).
- **API:** Hono, spec-first, no contract frameworks. Types generated with
  **openapi-typescript** (compile-time, zero runtime); runtime validation with **Ajv
  compiled directly against the spec's JSON Schemas** (never zod for the boundary — a
  second representation drifts). Hono routes are explicit, typed via a ~30-line
  generic helper binding each handler to `paths['/emails']['post']` etc. Ajv errors
  flow through the single error mapper (§5.1). `GET /openapi.json` serves the static
  bundle verbatim (public spec filters `x-internal`). Codegen is a turbo task with
  committed output and a CI gate (`git diff --exit-code` after regen).
- **DB:** DynamoDB single-table + **ElectroDB**.
- **Storage:** S3 (inbound raw MIME, attachments).
- **Queues:** SQS + DLQs.
- **Scheduling:** EventBridge Scheduler (one-time schedules).
- **Email:** SES v2 with **Tenants** (GA 2025-08-01). Requires
  **`@aws-sdk/client-sesv2` ≥ 3.858.0** [R03 §1.6]. Inbound receipt rules are
  **v1-only**: use `@aws-sdk/client-ses` for receipt-rule management [R03 §6.2].
- **MIME:** `nodemailer/lib/mail-composer` (raw build → Buffer for `Content.Raw`);
  `postal-mime` for inbound parsing (mailparser is in maintenance mode) [R05].
- **Natural-language dates:** `chrono-node` server-side (§5.6).
- **Frontend:** Vite + React + TS + Tailwind + **shadcn/ui** (components generated
  in-repo via the shadcn CLI, not an npm dependency; CSS-variable theming) + TanStack
  Router + TanStack Query, consuming the public API with **openapi-fetch** typed from
  the contract, thin TanStack Query wrapper. Better-auth ships its own client.
- **Dashboard auth:** Better-auth (email+password; teams as organizations).
- **Lint/format:** **Biome** (decided; not ESLint). `no-explicit-any`,
  `no-floating-promises` equivalents on.
- **Package manager:** pnpm workspaces.
- **CI:** GitHub Actions — workspace-wide typecheck, Biome, dependency-cruiser, knip,
  offline tests (§17), contract-codegen gate. Deploy to `production` is manual or by
  tag, never on push.

```
/
├── sst.config.ts          # reads instance.config.ts
├── instance.config.ts     # typed per-instance config (§20)
├── packages/
│   ├── contract/      # resend.yaml (pinned) + extensions.yaml → openapi.json
│   │                  # + codegen: TS types, Ajv validators
│   │                  # + fixtures/resend/ (golden fixtures vendored at M0)
│   ├── core/          # domain: ElectroDB entities, ports+adapters, webhook signing,
│   │                  # MIME render, validations, event mapping
│   ├── api/           # Hono app: routes typed against the contract (public + x-internal)
│   ├── functions/     # Lambda handlers: api, event-processor, webhook-dispatcher,
│   │                  # inbound-processor, scheduled-sender, broadcast-sender
│   ├── web/           # Vite dashboard
│   └── scripts/       # seeds, acceptance suite, fixture capture, utilities
```

## 2.1. Code architecture and design patterns

The code must read as written by a senior team: crisp boundaries, pure functions where
possible, each pattern used exactly where it solves a real problem of THIS system.

**Overall style: light hexagonal + functional core / imperative shell.**

- `core` holds the domain and defines **ports** (TS interfaces) for all infrastructure:
  `EmailProvider` (send, createDomainIdentity, getVerificationStatus, createTenant…),
  `BlobStore`, `QueuePublisher`, `SchedulerPort`, `Clock`, `IdGenerator`. Adapters
  (SES, S3, SQS, EventBridge Scheduler) live in `core/adapters/`. `core` NEVER imports
  `@aws-sdk/*` outside adapters.
- `EmailProvider` exists for exactly two reasons: testability (fake in CI) and future
  providers. **No speculative ports: an interface is justified only by ≥2 real
  implementations or a test that needs it.**
- Domain logic as **pure functions** wherever possible: SES→Resend event mapping, Svix
  signing, merge tags, state transitions, DNS record construction. Effects pushed to
  the edges.

**DI without a framework.** One **composition root** per Lambda: `createContext()`
instantiating adapters and services with plain closures/constructors, memoized at
module level (reused across warm starts). NestJS, Inversify, DI decorators, and
service locators are forbidden — wiring is explicit, one file per handler.

**Concrete patterns and where they go (and nowhere else):**

- **Repository** over ElectroDB: intention-named methods (`emails.markDelivered(id)`,
  `emails.findBySesMessageId(...)`, `suppressions.isSuppressed(team, email)`).
  DynamoDB syntax never leaks out of the repo.
- **Explicit state machine** for `Email.status`: a valid-transition map
  (`scheduled→canceled` ✓, `delivered→queued` ✗) and a single `transition()` function;
  every status update goes through it.
- **Send pipeline (chain)**: validate → checkSuppression → checkQuota → buildMessage →
  send → persist → emitEvent — each step pure and testable alone.
- **Strategy** for message construction: `SimpleContentBuilder` vs `RawMimeBuilder`
  behind one interface; the pipeline doesn't know which ran.
- **Anti-corruption layer**: `event-processor` is the ONLY piece that knows SES event
  formats; it translates to our own domain events (see §8.1 for the exact SES shapes).
- **Circuit breaker** per webhook endpoint in the dispatcher (state in DynamoDB with
  TTL): N consecutive failures ⇒ open, spaced retries, half-open probe.
- **Idempotency** as a cross-cutting pattern: client keys on the API (§5.7), and SQS
  consumers idempotent by design (a queue retry can never duplicate a send or a
  webhook).

**Error handling:** typed domain-error hierarchy (`DomainNotVerifiedError`,
`QuotaExceededError`, `SuppressedRecipientError`…) and **one error mapper** at the
HTTP boundary translating to the Resend error table (§5.1). Infra errors (SES
throttling, DDB conditional check) are caught in adapters and translated or rethrown
typed. Swallowing catches are forbidden.

**Organization by domain, not by type:** `core/emails/`, `core/domains/`,
`core/webhooks/`, `core/segments/` — schemas, service, repo, and tests colocated.
Generic `utils/`/`helpers/`/`managers/`/`common/` folders are forbidden.

**Explicit prohibitions:** inheritance for code reuse (composition always); anemic
classes + god services; per-layer DTO duplication (boundary types come from the
contract — single source of truth; zod only for internal domain invariants where it
pays); speculative abstraction; cycle-generating barrel files; comments that narrate
code (comment only the _why_).

**Automated enforcement (not aspirational):**

- **dependency-cruiser** in CI: `core` doesn't import from `api`/`functions`/`web`;
  `@aws-sdk/*` importable only from `core/adapters/`; no cycles.
- **knip** in CI: zero dead code, zero unused exports.
- **Biome** strict.
- **ADRs** in `docs/adr/` (one page) for every structural decision: authority order
  (§1), single-table, no transactional outbox in v1 (idempotency + SQS retries cover
  dual-write at this scale — document the trade-off), light hexagonal, front door
  (§3.1).

Guiding principle: _deep modules, shallow interfaces_ (Ousterhout) and the rule of
three.

## 3. Infrastructure (SST)

### 3.1 API front door — Function URL + CloudFront (decided, R04)

**SST `Router` (CloudFront) + Hono `Function` with `url: { router }`.** API Gateway
HTTP API is disqualified: 30 s hard integration timeout (path-attachment downloads can
exceed it), 512 KB-increment pricing that penalizes large bodies, no response
streaming, 12-month-only free tier. Function URL + CloudFront rides always-free tiers
(~$0/mo at our volume).

- Custom domain `api.<instance domain>` on the Router (auto ACM in us-east-1).
- **Raise CloudFront origin response timeout to 120 s** (default 30 s).
- **Never enable OAC on the function URL origin** — it forces clients to send
  `x-amz-content-sha256` on POST, breaking the Resend SDK. `AuthType: NONE`; auth is
  app-level bearer. The raw `*.lambda-url.*` endpoint stays reachable — harmless.
- **Hard request cap: Lambda sync invoke = 6 MB.** Inline base64 attachments top out
  at ~4.5 MB of raw bytes per request. Larger attachments must use
  `attachments[].path` (server-side download, up to SES's 40 MB post-base64).
  Document this cap in the README and API docs.

### 3.2 Resources

- **Table**: DynamoDB single-table, on-demand, GSIs per §4, **PITR enabled**, TTL
  attribute enabled, `protect: true`.
- **Buckets**: `inbound-raw`, `attachments`. Versioning + lifecycle: expire
  bodies/MIME at 90 days (document the retention policy in the README).
  `protect: true`.
- **Queues**: `email-events`, `webhook-deliveries` (+ DLQ with redrive),
  `broadcast-fanout`. All SQS→Lambda event source mappings with `maxConcurrency` set
  from day one (backpressure).
- **EventBridge rules** (default bus — SES EventBridge destinations support only the
  default bus [R03 §3.1]):
  - Email events rule: **match on `detail-type` explicitly** (`Email Sent`, `Email
Delivered`, …) — matching only `source: aws.ses` also catches VDM advisor and
    tenant-status events [R03 §3.2]. Routes to `email-events` SQS.
  - Tenant-status rule: detail-types `Sending Status Enabled` / `Sending Status
Disabled` → alerts Lambda (§12).
- **StaticSite**: dashboard on the bare instance domain (e.g. `mailing.example.com`).
- **Secrets**: `BETTER_AUTH_SECRET`, `SentryDsn`, unsubscribe-token HMAC key — via
  `sst secret`.
- **SES resources**: tenants, identities, and configuration sets are created **at
  runtime via SDK** (per-customer, dynamic), NOT in IaC. IaC holds only the static
  pieces: the inbound receipt rule set, and least-privilege IAM for the Lambdas.
- **Stage: exactly one, `production`.** `sst deploy --stage production`; local dev is
  `sst dev --stage production` sharing the deployed resources. Default stage
  `production` in `sst.config.ts`. README note: while `sst dev` runs, SST Live mode
  redirects the stage's Lambda invocations to the local machine — fine pre-launch;
  create a separate `dev` stage only when real customer traffic exists.
- **DNS dual-mode** (from `instance.config.ts`): `route53` (zone in-account → SST
  creates records + ACM validation automatically) or `manual` (bootstrap **emits the
  required records** — CloudFront aliases, ACM validation — for the operator to load
  at any DNS provider; same records-first onboarding the platform gives its own
  customers).

## 4. Data model (DynamoDB + ElectroDB)

Minimum entities (each with `teamId` as logical tenant partition):

- **Team** (= tenant): id, name, sesTenantName, plan (config enum, §20), status
  (`active|frozen`), quotas (dailyLimit, rps — resolved from plan), createdAt.
- **User**: managed by Better-auth, linked to teams (membership with role).
- **ApiKey**: id, token format `re_` + 32+ random chars (crypto), shown **once** on
  create, stored as SHA-256 hash; name, permission (`full_access|sending_access`),
  domainId optional (scoping), lastUsedAt, createdAt.
- **Domain**: id, name, region, status
  (`not_started|pending|verified|failed|temporary_failure`), records[] (§7 —
  `record`, `name`, `type`, **`ttl` as string** ("Auto"/"60"), `status`, `value`,
  `priority?` [R07 flag 14]), capabilities `{sending, receiving}`, clickTracking,
  openTracking, tls (`opportunistic|enforced`), inboundEnabled (flag, §9),
  sesIdentityArn, configurationSetName, createdAt.
- **Email**: id, direction (`outbound|inbound`), from, to[], cc[], bcc[], replyTo[],
  subject, htmlS3Key/textS3Key (inline if <200 KB), headers, tags[], attachments[]
  (metadata + S3 keys), status
  (`queued|scheduled|sent|delivered|delivery_delayed|bounced|complained|failed|canceled|received`)
  — **serialized as `last_event` on the wire** [R07 flag 11] — scheduledAt,
  scheduleArn, sesMessageId (GSI), idempotencyKey (GSI, TTL 24 h), messageId (RFC
  Message-ID), createdAt, lastEventAt.
- **EmailEvent**: emailId, type, timestamp, raw payload (per-email timeline), TTL 90 d.
- **WebhookEndpoint**: id, **endpoint** (URL — upstream field name is `endpoint`, not
  `url` [R02 §7]), events[], **signing_secret** (`whsec_` + base64) — **retrievable
  on every GET** (upstream is not show-once at the API level [R02 §7]), status
  (`enabled|disabled`), createdAt.
- **WebhookDelivery**: endpointId, eventId, attempt, statusCode, durationMs,
  nextRetryAt, payload (for dashboard replay), TTL 90 d.
- **Segment** (the real model; "Audience" is its deprecated upstream alias — ticket
  11): id, name, createdAt.
- **Contact**: id, segmentId, email (GSI segmentId+email), firstName, lastName,
  unsubscribed, createdAt.
- **Broadcast**: id, segmentId, from, subject, replyTo, name, htmlS3Key, textS3Key,
  status (`draft|scheduled|sending|sent|canceled`), scheduledAt, stats, createdAt.
- **Suppression**: email, reason (`hard_bounce|complaint|manual`), scope (team-global),
  sourceEmailId (nullable), createdAt.
- **RateLimitBucket**: per **team** (not per key — §5.2), per-second window (atomic
  counter with TTL).

## 5. API surface — complete Resend clone

Normative artifact: `packages/contract`. Auth: `Authorization: Bearer re_...`.
Content-Type JSON. **Timestamps serialize Postgres-style —
`"2026-08-08 17:58:15.369000+00"`, space separator, no `T`/`Z` — as observed on every
`created_at` on the wire** [R07 flag 10].

Scope note: the upstream spec now also carries Templates, Topics, Contact-properties,
Automations, Logs, Events, OAuth, and a top-level `/contacts` collection. **Out of
scope** (§19) except where listed below; the acceptance suite (official SDK against
our surface) never touches them.

### 5.1 Errors — single mapper, fixtures verbatim

Flat body `{ statusCode, name, message }`. The upstream OpenAPI spec has **no** error
contract — ours lives entirely in `extensions.yaml`. Authority: fixtures first, docs
for uncaptured cases [R01 §1, R07]. Key rows (fixture-verified marked ✦):

| Case                                          | Status  | `name`                                                                                                                      |
| --------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| Missing API key ✦                             | 401     | `missing_api_key`                                                                                                           |
| **Invalid API key ✦**                         | **400** | **`validation_error`** ("API key is invalid") — the documented `invalid_api_key`/403 never appears on the wire [R07 flag 2] |
| Restricted key on non-send route ✦            | 401     | `restricted_api_key`                                                                                                        |
| Not found ✦                                   | 404     | `not_found`                                                                                                                 |
| Method not allowed ✦                          | 405     | `method_not_allowed` ("Method PUT is not allowed for the requested path.")                                                  |
| Empty body on POST /emails ✦                  | 422     | `missing_required_field` ("Missing \`to\` field.")                                                                          |
| Missing `from` / `html`/`text` / wrong type ✦ | 422     | `validation_error` (exact messages in fixtures 06–09)                                                                       |
| Malformed JSON ✦                              | 400     | `validation_error` ("Request body must be valid JSON.")                                                                     |
| Domain not verified / plan limits ✦           | 403     | `validation_error`                                                                                                          |
| Idempotency payload mismatch ✦                | 409     | `invalid_idempotent_request`                                                                                                |
| Concurrent idempotent request                 | 409     | `concurrent_idempotent_requests`                                                                                            |
| Bad idempotency key length                    | 400     | `invalid_idempotency_key`                                                                                                   |
| Rate limited ✦                                | 429     | `rate_limit_exceeded` (verbatim body in fixture 30)                                                                         |
| Daily / monthly quota                         | 429     | `daily_quota_exceeded` / `monthly_quota_exceeded`                                                                           |
| Attachment lacks content and path             | 422     | `invalid_attachment`                                                                                                        |
| Bad `from` format ✦                           | 422     | `validation_error` / `invalid_from_address` per fixture/docs                                                                |
| Bad permission value                          | 422     | `invalid_access`                                                                                                            |
| Non-UUID id param                             | 422     | `invalid_parameter`                                                                                                         |
| Bad region                                    | 422     | `invalid_region`                                                                                                            |
| Security block                                | 451     | `security_error`                                                                                                            |
| Unexpected                                    | 500     | `internal_server_error` / `application_error`                                                                               |

`validation_error` legitimately spans 400/403/422 depending on the case — replicate
per fixture, don't normalize. **No request-id header** exists upstream; don't invent
one [R07 flag 13]. **Do not replicate the User-Agent-required 403** — it's a
Cloudflare artifact upstream, not API semantics; the SDK always sends one, so parity
is unaffected (decision; R01 note 9).

### 5.2 Rate limiting

**10 req/s per team** (not 2/s, not per key), shared across all the team's keys
[R01 §4, R07 flag 3]. Headers on **every** response: `ratelimit-limit`,
`ratelimit-remaining`, `ratelimit-reset`, plus **`ratelimit-policy: 10;w=1`**
(undocumented but observed). On 429 add `retry-after` and the verbatim fixture-30
body. Quota usage headers on **POST /emails responses only**:
`x-resend-daily-quota` / `x-resend-monthly-quota` — **ascending usage counters**, and
the daily counter increments even on an idempotent replay [R07 flag 9].

### 5.3 List envelope and pagination

`{ "object": "list", "has_more": <bool>, "data": [...] }` — **`has_more` included
everywhere**, even on deprecated `GET /audiences` and audience-scoped contacts (wire
contradicts the spec; fixtures 13, 20). Cursor pagination via `limit` (default 20,
1–100), `after`/`before` (object-id cursors, mutually exclusive). For older endpoints
(domains, api-keys, broadcasts, segments, contacts) omitting `limit` returns
everything; newer ones (emails, receiving) always paginate [R01 §2]. Dashboard
`x-internal` endpoints ALWAYS paginate (cursor-based).

### 5.4 Emails

- `POST /emails` — fields: `from` (accepts `"Name <mail@dom>"`), `to` (string or
  array, max 50), `cc`, `bcc`, `reply_to`, `subject`, `html`, `text`, `headers`,
  `attachments[]` (`content` base64 or `path` URL, `filename`, `content_type`),
  `tags[]` (`{name, value}`), `scheduled_at` (§5.6). Response `{ id }`. The SDK's
  `react` field renders client-side; the server only ever sees `html`.
- `GET /emails/:id` — shape per fixture 34: `object: "email"`, `last_event` (NOT
  `status`), `message_id` (RFC Message-ID), `bcc`/`cc`/`reply_to` **null when absent**
  (not `[]`), `text` **auto-derived from html** when only html was sent.
- `PATCH /emails/:id` — update `scheduled_at` of a scheduled email.
- `POST /emails/:id/cancel` — cancel a scheduled email.
- `GET /emails` — paginated list.
- `GET /emails/:id/attachments[/:attachment_id]` — attachment metadata with signed
  `download_url` + `expires_at` [R02 §6].

### 5.5 Batch (`POST /emails/batch`)

- Request: bare JSON array, max 100 items; each `to` max 50.
- **`attachments` NOT supported; `scheduled_at` IS supported per item** [R01 §3].
- `template` interactions: out of scope (Templates are §19).
- **Default mode is strict (all-or-nothing)**: one invalid item ⇒ plain 422 with the
  first error, no index info (fixture 28).
- **`x-batch-validation: permissive`** (the SDK sends this header explicitly, default
  `strict`) ⇒ **HTTP 202** with `{ data: [{id}...], errors: [{index, message}] }`
  (fixture 29).
- **Sync/async asymmetry**: single sends enforce recipient restrictions synchronously
  (403); batch accepts and fails asynchronously (`last_event: "failed"`) — replicate
  (fixture 32, R07 flag 7).
- Response `{ data: [{ id }, ...] }`, index-aligned with the request. Supports
  `Idempotency-Key` (one key for the whole batch).

### 5.6 `scheduled_at`

Accepts ISO 8601 **and natural language** ("in 1 min", "tomorrow at 9am", "Friday at
3pm ET") — parsing is 100% server-side (the SDK passes the string verbatim). Use
**chrono-node** (`parseDate`, `forwardDate: true`) — verified to parse every
documented example [R01 §6]. **Policy: timezone-less phrases resolve against UTC**
(documented in the README). Constraints: max 30 days out; canceled emails cannot be
rescheduled.

### 5.7 Idempotency (`Idempotency-Key` header)

`POST /emails` and `POST /emails/batch` only. Key 1–256 chars, kept **24 h**. Replay
returns the byte-identical response with header **`idempotent-replayed: true`**
(`false` on first send — send the header on both) [R07 flag 8]. Same key + different
payload ⇒ 409 `invalid_idempotent_request`; same key while in flight ⇒ 409
`concurrent_idempotent_requests`. **Error responses do not consume the key**
(fixtures 25–27).

### 5.8 Domains

- `POST /domains` — `{ name, region? }` → creates SES identity (§7), responds with
  domain object incl. `records[]` (string `ttl`, §4) and
  `capabilities: { sending, receiving }`.
- `GET /domains` / `GET /domains/:id` / `POST /domains/:id/verify` (re-check via
  `GetEmailIdentity`) / `PATCH /domains/:id` (`click_tracking`, `open_tracking`,
  `tls`) / `DELETE /domains/:id` — **must remove tenant resource associations before
  `DeleteEmailIdentity`** (association blocks deletion [R03 §1.2]), then delete the
  config set.

### 5.9 API keys

- `POST /api-keys` — `{ name, permission, domain_id? }` → 201
  `{ id, object: "api_key", token }` (token visible only here).
- `GET /api-keys` (no GET by id upstream), `DELETE /api-keys/:id` → 200
  `{ object, id, deleted: true }`.

### 5.10 Segments & Audiences (alias surface — ticket 11)

Segments is the real model. Both surfaces are served, backed by the same entities:

- `/segments` CRUD (current-generation SDK).
- `/audiences` CRUD (deprecated alias, older SDKs) — create 201 `{ object, id, name }`
  (no created_at), get adds `created_at`, delete `{ object, id, deleted: true }`
  (fixtures 16, 17, 23).

### 5.11 Contacts (audience/segment-scoped routes)

- `POST /audiences/:audience_id/contacts` — `{ email, first_name?, last_name?,
unsubscribed? }` → 201 `{ object: "contact", id }`.
- `GET .../contacts` / `GET .../contacts/:id` — lookup by id **and** by email; GET
  includes `properties: {}` (fixture 19).
- `PATCH .../contacts/:id` → `{ object, id }`.
- `DELETE .../contacts/:id` → **`{ object: "contact", contact: "<id>",
deleted: true }` — the id field is named `contact`** (fixture 22; replicate the
  inconsistency).
- Mirror the same routes under `/segments/:segment_id/contacts`.

### 5.12 Broadcasts

- `POST /broadcasts` — `{ segment_id | audience_id (alias), from, subject, html?,
text?, name?, reply_to? }`. Merge tags (§11.1).
- `GET /broadcasts` / `GET /broadcasts/:id` / `PATCH /broadcasts/:id` /
  `DELETE /broadcasts/:id`.
- `POST /broadcasts/:id/send` — `{ scheduled_at? }`. Fan-out via `broadcast-fanout`
  SQS, respecting suppressions and `unsubscribed`.

### 5.13 Webhooks CRUD — copy upstream shapes exactly [R02 §7]

Resend DOES ship REST CRUD:

| Endpoint               | Notes                                                                      |
| ---------------------- | -------------------------------------------------------------------------- | -------------------------- |
| `POST /webhooks`       | `{ endpoint, events[] }` → 201 `{ object: "webhook", id, signing_secret }` |
| `GET /webhooks`        | list envelope; **no** `signing_secret` in list items                       |
| `GET /webhooks/:id`    | includes `signing_secret` (retrievable every time)                         |
| `PATCH /webhooks/:id`  | `{ endpoint?, events?, status? }`, status `enabled                         | disabled`→`{ object, id }` |
| `DELETE /webhooks/:id` | `{ object, id, deleted: true }`                                            |

The dashboard uses these same endpoints.

### 5.14 Inbound receiving endpoints [R02 §6]

- `GET /emails/receiving` — paginated list of received emails.
- `GET /emails/receiving/:id` — full email: `html`/`text`/`headers` (nullable),
  attachments metadata (+ size, no URL).
- `GET /emails/receiving/:id/attachments[/:attachment_id]` — with signed
  `download_url` + `expires_at` (S3 presigned, 1 h).

### 5.15 Cross-cutting validations

- `from` must belong to a `verified` domain of the team (Resend's exact 403
  `validation_error` message, fixtures 25–27).
- Suppressed recipients rejected/skipped as Resend does.
- **Hard-delete everywhere**: DELETE removes the DynamoDB record AND S3 content.

## 6. Send pipeline (SES v2 + Tenants)

1. `POST /emails` validates, persists Email as `queued` (or `scheduled`), and sends
   **synchronously** via SES v2 `SendEmail` (single sends need no queue; batch and
   broadcasts go through SQS).
2. **Message construction:** no attachments/custom headers ⇒ `Content.Simple`;
   otherwise raw MIME via `mail-composer` (`compile().build()` → Buffer) ⇒
   `Content.Raw`. `path` attachments are downloaded server-side through `safeFetch`
   (§16) with size caps. SES total message cap: **40 MB post-base64 (fixed, both
   Simple and Raw)** [R03 §2]; >10 MB messages get bandwidth-throttled by SES.
3. **Multi-tenancy:** each Team gets an SES **Tenant** at creation (`CreateTenant` —
   name ≤64 chars `[a-zA-Z0-9_-]`; **Standard reputation policy is auto-assigned, no
   param exists on CreateTenant**; changes go through `UpdateReputationEntityPolicy`
   on the tenant ARN [R03 §1.4]). Each verified domain + its config set is associated
   via `CreateTenantResourceAssociation`. Every `SendEmail` includes `TenantName` +
   `ConfigurationSetName` (a tenant send requires an associated config set [R03 §1.5]).
4. **Tags:** map request tags to SES message tags (sanitize `[a-zA-Z0-9_-]`), always
   adding internal `email_id` + `team_id` tags for event correlation.
5. Store `sesMessageId` from the response (it equals `mail.messageId` in events
   [R03 §3.3]).
6. Emit our own `email.sent` immediately (don't wait for SES's SEND event).
7. Paused-tenant sends fail — the exact exception name is undocumented; **handle both
   `SendingPausedException` and `BadRequestException` defensively** [R03 §1.5].

## 7. Domains: multi-tenant DNS onboarding

On `POST /domains`:

1. `CreateEmailIdentity` (Easy DKIM, default 2048-bit) → 3 DKIM tokens ⇒ 3 CNAMEs
   `<token>._domainkey.<domain>` → `<token>.<SigningHostedZone>` — **build the value
   from `DkimAttributes.SigningHostedZone` in the response, never hardcode**
   (region-dependent; us-east-1 is `dkim.amazonses.com`) [R03 §5.2].
2. `PutEmailIdentityMailFromAttributes` with MAIL FROM `send.<domain>` ⇒ records: MX
   `send.<domain>` → `10 feedback-smtp.us-east-1.amazonses.com` and TXT SPF
   `v=spf1 include:amazonses.com ~all`. **Exactly one MX on that subdomain, and it
   must never receive mail** (constraints surfaced in onboarding UI/docs) [R03 §4].
3. Include optional DMARC TXT at `_dmarc.<domain>` in `records[]`.
4. Create the domain's configuration set with EventBridge event destination (types:
   `SEND, DELIVERY, DELIVERY_DELAY, BOUNCE, COMPLAINT, REJECT, OPEN, CLICK,
RENDERING_FAILURE, SUBSCRIPTION` — the exact `MatchingEventTypes` enum) and
   tracking options per `click/open_tracking`.
5. Associate identity + config set to the team's tenant.
6. Return `records[]` with `status: not_started`.

`POST /domains/:id/verify` + a 10-min cron re-check via `GetEmailIdentity`: poll
`DkimAttributes.Status`, `MailFromAttributes.MailFromDomainStatus`,
`VerificationStatus` (enums in R03 §5.3); surface `VerificationInfo` DNS diagnostics
in the dashboard. SES searches DNS for up to 72 h, then `FAILED` — re-trigger.

Custom tracking domains: phase 2, leave the hook.

## 8. Events and webhooks (Svix-compatible signing)

### 8.1 Ingestion — SES shapes (ACL boundary)

EventBridge rule → SQS `email-events` → `event-processor`:

- Envelope: `source: "aws.ses"`, `detail-type` per the R03 §3.2 table (`Email Sent`,
  `Email Bounced`, …), `detail` = the SES event record (`eventType` + `mail` +
  event object). Delivery is best-effort and **may be out of order**.
- `mail.messageId` = the SendEmail `MessageId` → resolve the Email (GSI), fall back to
  the `email_id` message tag. **`mail.tags` is `map<string, string[]>`**.
- Event-object gotchas [R03 §3.4]: `send` is `{}`; rendering failure's key is
  **`failure`** (not `renderingFailure`); `bounce.bounceType`
  `Permanent|Transient|Undetermined` with subtypes incl. `Suppressed`,
  `OnAccountSuppressionList`, `OnTenantSuppressionList`; only hard bounces and
  retries-exhausted soft bounces are published; `open`/`click` carry `isBotEvent`;
  `deliveryDelay.delayType` enum; `headers`/`commonHeaders` conditionally absent.

Mapping to Resend events: DELIVERY → `email.delivered`; DELIVERY_DELAY →
`email.delivery_delayed`; BOUNCE → `email.bounced` (+ hard bounce ⇒ Suppression);
COMPLAINT → `email.complained` (+ Suppression); REJECT / RENDERING_FAILURE →
`email.failed`; OPEN → `email.opened`; CLICK → `email.clicked`; SUBSCRIPTION →
unsubscribe handling for broadcasts. SEND is ignored (we emit `email.sent` at send
time). Then: update `Email.status` via the state machine, insert `EmailEvent`, update
broadcast stats, enqueue one `webhook-deliveries` message per subscribed endpoint.

### 8.2 Event catalog — 19 types [R02 §1]

Emit every type whose underlying action exists in our scope:

- **Email (11):** `email.sent`, `email.delivered`, `email.delivery_delayed`,
  `email.bounced`, `email.complained`, `email.failed`, `email.opened`,
  `email.clicked`, `email.scheduled`, `email.suppressed`, `email.received`.
- **Contact (3):** `contact.created`, `contact.updated`, `contact.deleted`.
- **Domain (3):** `domain.created`, `domain.updated`, `domain.deleted`.
- **Suppression (2):** `suppression.added`, `suppression.removed`.

Envelope: `{ type, created_at, data }`. Payload shapes per R02 §3 — outbound events
share `OutboundEmailEventData` (**include `message_id`** — docs show it, spec lags);
`email.bounced` adds `bounce {type, subType, message, diagnosticCode[]}`;
`email.clicked` adds `click {ipAddress, link, timestamp, userAgent}` (camelCase);
`email.failed` adds `failed {reason}`; `email.suppressed` adds `suppressed`;
contact/domain/suppression payloads per R02 §3.7–3.9. **`email.received` is
metadata-only** (§9).

### 8.3 Dispatch — `webhook-dispatcher`

- **Signature identical to Svix** [R02 §4]: headers `svix-id` (stable across retries),
  `svix-timestamp` (epoch seconds), `svix-signature` = `v1,` +
  Base64(HMAC-SHA256(base64decode(secret after `whsec_`), `${id}.${ts}.${body}`)).
  Sign the exact bytes sent. Multi-signature space-delimited format and 5-min
  timestamp tolerance are consumer-side conventions. **Mandatory test: verification
  passes with the official `svix` npm library.**
- Timeout 10 s (our choice — upstream's is undocumented). Retries with backoff
  approximating Resend's documented schedule — immediately, 5 s, 5 m, 30 m, 2 h, 5 h,
  10 h, 10 h = **8 attempts over ~28 h** — via visibility timeout + redrive; DLQ on
  exhaustion; log each attempt in WebhookDelivery. Repeated failures ⇒ circuit breaker
  opens, endpoint marked `disabled`, dashboard notice (upstream auto-disables too).
- Dashboard: delivery log with status/latency + **replay** button (replays succeeded
  and failed deliveries).

## 9. Inbound

1. IaC: SES receipt rule set active in us-east-1, catch-all rule for inbound-enabled
   domains: S3 action (`inbound-raw`, object key = `mail.messageId`) + Lambda trigger
   (`Event` invocation). **Receipt-rule management uses the v1 API**
   (`@aws-sdk/client-ses`) [R03 §6.2]. **Set `ScanEnabled: true` explicitly** (API
   default is false) to get verdict headers; `Enabled` also defaults false. Rule-set
   constraint: only one active per account. When a team enables inbound on a domain,
   add the MX record `<domain>` → `10 inbound-smtp.us-east-1.amazonaws.com` to its
   `records[]` and update capabilities.
2. `inbound-processor`: read MIME from S3 (cap 40 MB — larger bounces), parse with
   **postal-mime** (accepts the S3 Buffer directly; attachments come as ArrayBuffer ⇒
   `Buffer.from()`), store Email `direction: inbound` + attachments in S3, read
   verdict headers (`X-SES-Spam-Verdict`, `X-SES-Virus-Verdict`,
   `Authentication-Results`) into internal metadata, emit `email.received`.
3. **`email.received` carries metadata only** — no body, no headers, no attachment
   content/URLs, no spam verdicts (upstream payload parity [R02 §6]). Content is
   served via `GET /emails/receiving/*` (§5.14); attachment `download_url` = 1 h
   presigned S3 URL with `expires_at`. Verdicts stay internal (dashboard-only),
   since upstream documents no verdict fields.

## 10. Scheduling and cancellation

- `scheduled_at` ⇒ EventBridge Scheduler one-time schedule targeting
  `scheduled-sender` with the emailId; store `scheduleArn`. Emit `email.scheduled`.
- `PATCH /emails/:id` ⇒ `UpdateSchedule`; `POST /emails/:id/cancel` ⇒ `DeleteSchedule`
  - `canceled`. Valid only while `scheduled` (state machine enforces); otherwise
    Resend's error. Canceled emails cannot be rescheduled.
- `scheduled-sender` reuses the §6 pipeline and deletes the schedule on completion.

## 11. Broadcasts and bulk-sender compliance

- `POST /broadcasts/:id/send` ⇒ fan-out: paginate the segment's contacts (excluding
  `unsubscribed` and suppressions) into SQS chunks; consumer Lambda sends individually
  (same pipeline, same tenant).

### 11.1 Merge tags — current syntax [R01 §5]

`{{{contact.first_name|fallback}}}`, `{{{contact.last_name|fallback}}}`,
`{{{contact.email}}}` — lowercase, `contact.`-prefixed, inline fallback after `|`.
Plus `{{{RESEND_UNSUBSCRIBE_URL}}}` (unique per recipient per broadcast). The
uppercase `{{{FIRST_NAME}}}` forms are gone from upstream broadcast docs — support
only the current syntax. Custom contact properties: out of scope (§19).

### 11.2 Compliance (Gmail/Yahoo 2024)

Every broadcast: `List-Unsubscribe` (mailto + URL) and `List-Unsubscribe-Post:
List-Unsubscribe=One-Click` (RFC 8058) headers, `{{{RESEND_UNSUBSCRIBE_URL}}}`
replacement. Public unsubscribe endpoint: `POST` (one-click, no UI) + `GET` (minimal
landing) marking the contact `unsubscribed` via signed token (HMAC, long expiry) — no
auth.

## 12. Multi-tenant guardrails

- Tenants get the Standard reputation policy automatically (§6.3). Subscribe to
  tenant-status EventBridge events (`Sending Status Enabled/Disabled`, tenant ARN
  format `arn:aws:ses:<region>:<account>:tenant/{name}/{id}`): SES pauses a tenant ⇒
  mark team `frozen`, reject sends with a clear error, alert (email to the instance
  alert address + dashboard banner). Re-enable is a manual operator action
  (`update-reputation-entity-customer-managed-status`) [R03 §1.4].
- Own guardrails above SES: per-plan daily quota (DynamoDB counter), preventive
  auto-freeze when a team's rolling bounce rate >5% or complaint rate >0.1%
  (configurable). New teams start on the conservative default plan (§20).
- Team suppression list consulted on every send.

## 13. Dashboard (Vite)

Consumes the **public API** with the typed contract client (dogfooding), plus
`x-internal` endpoints for what isn't Resend surface (delivery logs, webhook replay,
usage). Screens:

1. **Auth** (Better-auth): login; **sign-up only when `signupOpen: true`** — when
   closed, Better-auth's sign-up path is disabled **server-side**, not just hidden
   (ticket 13). Team creation, invitations.
2. **Admin bootstrap** (ticket 13): while the instance has zero users, a first-run
   screen creates the first admin user, gated by a **one-time bootstrap token**
   emitted at deploy (`sst deploy` output / SSM — Grafana-style). Creates only that
   user; once any user exists the screen never shows again. Team creation stays a
   normal per-user flow.
3. **Emails:** filterable list + detail with event timeline and sandboxed HTML preview.
4. **Domains:** DNS instructions table (copyable records, per-record status), verify
   button, tracking toggles, inbound toggle.
5. **API Keys:** create (token shown once), list, revoke.
6. **Webhooks:** CRUD, event selector, signing secret (retrievable — §5.13), delivery
   log with status/latency + replay.
7. **Segments & Contacts:** CRUD + CSV import.
8. **Broadcasts:** composer (HTML + merge tags), preview, send/schedule, stats.
9. **Usage:** sends/month, bounce & complaint rates, tenant status, quotas.
10. **Metrics:** simple DynamoDB aggregation (no warehouse).
11. **OAuth screens**: `/consent` + `/select-team` serve the
    OAuth 2.1 authorize flow (an app requests access, the user picks the team
    and the permission actually granted); **Connected apps** lists the user's
    grants on the active team and revokes them (consent deleted + refresh
    tokens killed server-side via `x-internal /internal/oauth-grants`).

Sober developer-first design (Resend/Vercel aesthetic), shadcn/ui primitives (Table,
Dialog, Sheet, Tabs, Sonner, Command). Dark mode default. Branding strings from
`instance.config.ts`.

## 14. MCP server

- `POST /mcp`, **Streamable HTTP** via **`@hono/mcp`** (`StreamableHTTPTransport`),
  mounted on the same Hono/Lambda app. **Run stateless** (`sessionIdGenerator:
undefined`) with **`enableJsonResponse: true`**; return **405 on GET** (no SSE
  stream) — all spec-legal and exactly Lambda's request/response model [R05]. The
  official SDK's `WebStandardStreamableHTTPServerTransport` is the fallback if
  `@hono/mcp` stalls.
- **Auth:** `Authorization: Bearer re_...` **or an OAuth 2.1 JWT access token**;
  key/scope permissions apply (`sending_access` /
  `emails:send` exposes only send-related tools). The connect flow is fully
  discoverable: unauthenticated `/mcp` calls answer with `WWW-Authenticate:
  Bearer resource_metadata=".../.well-known/oauth-protected-resource"`, whose
  document points at the better-auth `oauthProvider` authorization server
  under `/auth/oauth2/*` (RFC 8414 metadata, RFC 7591 dynamic client
  registration, PKCE S256, refresh rotation). Hosts MUST send the RFC 8707
  `resource` parameter — without it the access token is opaque and rejected.
- **Single source of truth:** tools call the same `core` service layer; input/output
  schemas derive from the contract.
- **Minimum tools:** `send_email`, `get_email`, `list_emails`, `create_domain`,
  `list_domains`, `verify_domain`, `list_segments`, `add_contact`,
  `unsubscribe_contact`, `create_broadcast`, `send_broadcast`, `get_usage_stats`.
- **Agent-first design:** actionable tool descriptions, compact responses (never full
  HTML — summarize + offer the id), explanatory errors with suggested next step, same
  rate limiting as the API.
- Expose `openapi.json` as an MCP resource.

## 15. Observability and costs (cheap but professional)

Principle: **native CloudWatch + free tiers, zero paid SaaS.** Everything in SST.

- **Logs:** Lambda Powertools structured JSON logger everywhere, correlation by
  `requestId`/`emailId`/`teamId`. INFO sampled 10%, WARN/ERROR always. **30-day
  retention set in SST on every log group.**
- **Metrics:** Powertools Metrics (EMF). Hard budget: **max ~15 custom metrics**
  (sends, deliveries, bounces, complaints, webhook_failures, dlq_depth, api_latency,
  inbound_received + few more). X-Ray off.
- **Errors:** Sentry free tier (5k events/mo) in all Lambdas + frontend. DSN via
  `sst secret`. Email alerts.
- **CloudWatch alarms** (first 10 free): DLQ depth > 0 (each DLQ),
  `ApproximateAgeOfOldestMessage` per queue, per-Lambda error rate, API p99, SES
  account bounce/complaint rate, tenant paused (EventBridge rule), Budget. All → SNS →
  the instance alert email.
- **Uptime + status page:** **Better Stack free tier** (decided) hitting `GET /health`
  every 1–3 min + its public status page. `/health` does one light DynamoDB read —
  never calls SES.
- **Cost monitoring:** (1) global `app` + `stage` tags via SST transform + cost
  allocation tags; (2) **AWS Budgets** alerts at 50/80/100% of the instance's monthly
  budget; (3) Cost Anomaly Detection on; (4) weekly cron Lambda querying Cost Explorer
  (~$0.01/query) and mailing the per-service summary **through the platform itself**
  (dogfooding). Note: Cost Explorer must be enabled once per account; data appears
  ~24 h later [R09].
- **Dashboard:** one CloudWatch dashboard (volume, bounce/complaint rates, DLQs,
  latency, errors).
- **README runbook:** account limits and raises, secret rotation, DLQ redrive,
  SES-paused-tenant procedure, weekly cost summary, post-run credential hygiene
  (rotate/deactivate the bootstrap IAM key — R09 §6).

## 16. Security

- API keys: SHA-256 hash in DB, constant-time compare, `re_` + 32+ crypto-random
  chars. `sending_access` blocks everything except `POST /emails*`.
- OAuth 2.1: access tokens are 15-minute JWTs verified
  in-process against our own JWKS (opaque tokens rejected — no introspection
  hop); scopes map onto the key permissions (`emails:send` → `sending_access`,
  `full_access`); a grant binds to ONE team and every issuance — including
  refresh — re-checks that the user still belongs to it. Refresh tokens
  rotate on use and are stored hashed, like API keys. Revoking a grant from
  the dashboard kills consent + refresh tokens; an unexpired JWT survives at
  most 15 minutes (accepted staleness window, same as Resend's).
- Strict input validation with the contract-compiled Ajv validators.
- Unsubscribe endpoint and tracking links never expose unsigned internal IDs.
- CORS: public API server-to-server only (no permissive CORS); dashboard on an origin
  allowlist.
- Per-Lambda least-privilege IAM.
- **Anti-SSRF on every user-supplied outbound URL** (path-attachment downloads,
  webhook dispatch): one `safeFetch` helper in `core` — resolve DNS and block
  private/link-local/loopback ranges (10.x, 172.16-31.x, 192.168.x, 169.254.169.254,
  ::1), http/https only, capped redirects (re-validating each hop), short timeout,
  content-length cap, re-resolve per request (DNS-rebinding mitigation).

## 17. Testing and acceptance criteria

### Harness (no emulators — NO LocalStack)

- **DynamoDB Local** (official `amazon/dynamodb-local` image) via **testcontainers**
  (decided) for repository/ElectroDB tests.
- **Golden fixtures, two sets:**
  1. **Resend API fixtures** — already captured (37 files), vendored into
     `packages/contract/fixtures/resend/` at M0. Conformance tests replay
     them against our handlers: same status, same body shape, same headers.
     Known gap: domain create/delete success shapes were not capturable (fixture
     account's plan limit) — those follow the vendored spec + R02 §3.8 instead.
  2. **SES event fixtures** — captured ONCE from the real stage into
     `packages/core/test/fixtures/ses-events/` using the SES mailbox simulators
     (`success@simulator.amazonses.com`, `bounce@`, `complaint@`); script in
     `packages/scripts/capture-fixtures`. `event-processor`/`webhook-dispatcher`
     tests replay them offline.
- **Email provider fake:** SES accessed only through the `EmailProvider` port; tests
  inject an in-memory fake that records calls and simulates throttling/errors.
- **CI runs 100% offline.** Only the acceptance suite touches the cloud (against
  `production`, on demand).

### Suites

1. **Unit (vitest) in `core`:** Svix signing (verified with the `svix` lib),
   SES→Resend event mapping, MIME building with attachments, `scheduled_at` parsing,
   merge tags, state-machine transitions.
2. **Acceptance** in `packages/scripts/acceptance/`: official `resend` npm SDK,
   baseURL → production, dedicated test team. Full flow: create key → create domain →
   send simple → send with attachments → batch (strict + permissive) → scheduled +
   patch + cancel → get email → segments/contacts CRUD (via both audiences and
   segments SDK surfaces) → broadcast → webhooks CRUD → receive and svix-verify a real
   webhook against a capture endpoint. **The suite must pass without touching the
   SDK.**
3. **Contract conformance:** `GET /openapi.json` serves the bundle (`x-internal`
   filtered); **Schemathesis** on demand against production — ALWAYS with a
   minimal-quota test team and recipients restricted to SES simulator addresses
   (fuzzing can trigger real sends; junk recipients burn reputation); CI codegen gate.
4. **Rate limit test:** 11th request in the same second (per team) returns 429 with
   the exact fixture-30 headers/body.
5. **MCP smoke test:** MCP Inspector (or programmatic client): list tools, run
   `send_email` + `get_email`, verify a `sending_access` key sees no admin tools.

## 18. Milestones

M0–M10, each blocked by the previous, each with its own verify gate. Deploy at the end of every milestone; a milestone closes only when
its verify checklist passes against production.

## 19. Non-goals (phase 2 — do NOT build now)

- SMTP submission interface.
- **Shared onboarding domain** (`onboarding@resend.dev` equivalent) — conscious v1
  decision: every send requires an owned, verified domain. Do not "improve" this.
- Dedicated IPs and warming.
- Custom tracking domains (leave the hook in Domain).
- Templates API, Topics, Contact custom properties, Automations, Logs API, top-level
  `/contacts` collection, OAuth surface, multi-region sending, SSO.
- Billing/payments — teams are provisioned manually; `plan` is a config enum.
- Guided "getting started" onboarding checklist in the dashboard (ruled out in
  ticket 13).
- Replicating upstream's User-Agent-required 403 (decision, §5.1).

## 20. Instance configuration (`instance.config.ts`)

Typed config read by `sst.config.ts`. Secrets NEVER here (use `sst secret`).

| Field              | Type                    | acme (instance #1)                                                                                           |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `productName`      | string                  | `opensender`                                                                                                  |
| `instanceName`     | string                  | `opensender` (dashboard title/branding)                                                                    |
| `domain`           | string                  | `mailing.example.com` (dashboard; API at `api.mailing.example.com`)                                                 |
| `region`           | string                  | `us-east-1`                                                                                                   |
| `dnsMode`          | `'route53' \| 'manual'` | `route53` (zone `example.com` lives in account 123456789012)                                                     |
| `alertEmail`       | string                  | `ops@example.com`                                                                                         |
| `monthlyBudgetUsd` | number                  | `25`                                                                                                          |
| `signupOpen`       | boolean                 | `false` (teams provisioned manually)                                                                          |
| `plans`            | record                  | `default`: 1,000 emails/day · `internal`: 50,000/day (account cap). API rate limit 10 req/s per team on both. |

Constraints to encode: inbound requires us-east-1/us-west-2/eu-west-1; SES account
quota is 50k/day and **14 rps** — the send pipeline must throttle below the account
send rate regardless of per-team API limits; stage is always `production`.

---
