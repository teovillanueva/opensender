# Glossary

Ubiquitous language for opensender. Terms only — no implementation details.

## Instance

An independent, self-contained deployment of opensender: its own AWS account, domain,
configuration, and data. Instances know nothing about each other.

## Team

A customer of an Instance — the unit of ownership for domains, API keys, emails,
contacts, and quotas. Equivalent to a Resend "team". Every Team is backed 1:1 by a
Tenant.

## Tenant

The SES-side reputation-isolation unit (SES v2 Tenant) backing a Team. "Tenant" always
means the SES resource; the business-side concept is Team.

## Plan

A named quota profile assigned to a Team (config enum — e.g. daily send limit, rate).
Carries no billing: plans are assigned manually by the Instance operator.

## Segment

A named list of Contacts, targetable by a Broadcast. This is the real domain concept;
"Audience" is its deprecated upstream alias, and the `/audiences` API surface is an
alias over Segments (mirroring Resend).

## Contact

An email recipient inside a Segment, with optional profile fields and an
`unsubscribed` flag.

## Golden fixture

A captured request/response pair from the real Resend API. The highest-authority
source of wire-format truth: fixtures > official docs > OpenAPI spec.

## Admin bootstrap

The one-time first-run flow of a freshly deployed Instance: while zero users exist,
the UI offers to create the first admin user, gated by a bootstrap token emitted at
deploy. Creates only that user — teams and everything else follow the normal per-user
flows.

## Suppression

A Team-scoped block on a recipient address (hard bounce, complaint, or manual);
suppressed recipients are excluded from every send.
