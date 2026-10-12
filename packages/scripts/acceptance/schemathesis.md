# Contract fuzzing — Schemathesis (SPEC §17 #3)

Property-based fuzzing of the public API against its own OpenAPI contract. Run
**on demand** against production — never in CI (it can trigger real sends).

## Guardrails (mandatory)

- Use a **dedicated, minimal-quota test team** and a `full_access` key for it.
- Recipients are restricted to the **SES mailbox simulator**
  (`success@simulator.amazonses.com`); fuzzed junk recipients would burn SES
  reputation. Keep the fuzz focused on non-send paths, or ensure any generated
  `to` is overridden — prefer excluding `POST /emails*` mutation of `to`.
- The public schema (`x-internal` filtered) is what we fuzz:
  `GET https://api.<domain>/openapi.json`.

## Run

```sh
# 1. Install (once): pipx install schemathesis   (or: uv tool install schemathesis)
# 2. Provision a throwaway key (under sst shell), e.g. via create-user + the
#    dashboard, or reuse the acceptance suite's provisioning.

API=https://api.mailing.example.com
KEY=re_...   # minimal-quota test team, full_access

schemathesis run "$API/openapi.json" \
  --base-url "$API" \
  --header "Authorization: Bearer $KEY" \
  --checks all \
  --hypothesis-max-examples 50 \
  --exclude-path-regex '/emails' \   # skip send mutation (reputation safety)
  --report
```

## Triage

- **4xx on malformed input** is expected and correct (our Ajv validators reject
  it) — not a finding.
- Investigate **5xx**, schema-mismatch (response doesn't match the documented
  shape), and any 2xx on input that should have been rejected.
- Record triaged findings in the M10 ledger. A schema drift is fixed by
  updating the contract + handler; the codegen gate keeps types in sync.
