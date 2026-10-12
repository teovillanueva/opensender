# Sending email

opensender implements the Resend API, so you talk to it with the official
Resend SDKs or plain HTTP. Your instance's API lives at `https://api.<domain>`.

## 1. Verify a domain and create an API key

In the dashboard:

1. **Domains → Add domain.** Add the DNS records it shows (DKIM, SPF/MAIL
   FROM, DMARC) at your DNS provider. The domain verifies on its own once they
   resolve.
2. **API keys → Create.** Keys look like `re_…`. Choose *Full access* or
   *Sending access*.

## 2. Point the SDK at your instance

### Node.js

```ts
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY, {
  baseUrl: "https://api.mailing.example.com",
});

const { data, error } = await resend.emails.send({
  from: "Acme <hello@example.com>",
  to: ["delivered@example.com"],
  subject: "Hello World",
  html: "<strong>it works!</strong>",
});
```

Instead of `baseUrl`, you can set `RESEND_BASE_URL=https://api.mailing.example.com`
in the environment and keep `new Resend(apiKey)` unchanged.

### Other languages

Any Resend SDK that lets you override the API base URL works the same way:
set it to `https://api.<domain>`. Check your SDK's docs for the option name.

### HTTP

```bash
curl -X POST https://api.mailing.example.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "Acme <hello@example.com>",
    "to": ["delivered@example.com"],
    "subject": "Hello World",
    "html": "<strong>it works!</strong>"
  }'
```

Request and response shapes, errors, pagination and webhook payloads match
[Resend's API reference](https://resend.com/docs/api-reference), so its docs
apply as-is.

## What's supported

| Area | Endpoints |
| --- | --- |
| Emails | send, batch, retrieve, list (cursor pagination), update/cancel scheduled, attachments |
| Scheduling | `scheduled_at` up to 30 days out |
| Idempotency | `Idempotency-Key` header |
| Domains | create, verify, list, update, delete |
| API keys | create, list, delete |
| Contacts | contacts, segments and audiences |
| Broadcasts | create, send, schedule, with merge tags and one-click unsubscribe |
| Webhooks | create, list, update, delete; Svix-compatible signatures |
| Inbound | receive email on your domains; `email.received` webhooks and `/emails/receiving` |

Agents can connect through the MCP server at `https://api.<domain>/mcp`, with an
API key or OAuth.

## Limits

- **Request size: 6 MB.** The API runs behind a Lambda Function URL, so inline
  base64 attachments top out at ~4.5 MB of raw bytes per request. For larger
  files, pass `attachments[].path` (a URL the API downloads server-side); SES
  accepts messages up to 40 MB.
- **Retention:** stored attachments and inbound raw messages expire after
  90 days.
- **Rate limit and daily quota** come from the team's plan in
  `instance.config.ts`. Responses carry the usual `ratelimit-*` headers.
- **Guardrails:** a team whose bounce or complaint rate crosses the configured
  thresholds is frozen and gets `403 restricted` until an operator restores it
  (see [Operations](operations.md#paused-or-frozen-teams)).
