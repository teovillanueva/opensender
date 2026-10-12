import type { Contact } from "@opensender/core";
import { verifyUnsubscribeToken } from "@opensender/core";
import { Hono } from "hono";
import { errors } from "../errors.js";

/**
 * Contact resolver for the PUBLIC unsubscribe flow. The signed token carries
 * `contactId`/`segmentId`/`broadcastId` but no team, so the load is
 * team-agnostic — unlike the authed `ContactsPort.getByIdOrEmail`. The Infra
 * phase implements `getById` against the Contact entity's primary-key read and
 * `setUnsubscribed` against `ContactsService.setUnsubscribed`.
 */
export interface UnsubscribeContactsPort {
  getById(contactId: string): Promise<Contact | undefined>;
  setUnsubscribed(contact: Contact, unsubscribed: boolean): Promise<Contact>;
}

export interface UnsubscribeRouteDeps {
  unsubscribeContacts: UnsubscribeContactsPort;
  /** HMAC secret backing the signed one-click token (SPEC §11.2). */
  unsubscribeSecret: string;
}

function landingPage(email: string): string {
  const safe = email.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribed</title></head>
<body>
<main>
<h1>You're unsubscribed</h1>
<p>${safe} will no longer receive these emails.</p>
</main>
</body>
</html>`;
}

/**
 * Resolve the token to a contact and ensure it is unsubscribed. Idempotent: a
 * contact that is already unsubscribed is left untouched (no duplicate event).
 */
async function resolveAndUnsubscribe(deps: UnsubscribeRouteDeps, token: string): Promise<Contact> {
  const payload = verifyUnsubscribeToken(token, deps.unsubscribeSecret);
  if (!payload) throw errors.notFound("Invalid unsubscribe token");
  const contact = await deps.unsubscribeContacts.getById(payload.contactId);
  if (!contact) throw errors.notFound("Contact not found");
  if (contact.unsubscribed) return contact;
  return deps.unsubscribeContacts.setUnsubscribed(contact, true);
}

/**
 * Public unsubscribe surface (SPEC §11.2). Mounted OUTSIDE the authed group —
 * no API key, no session. GET renders a confirmation landing; POST is the
 * RFC 8058 one-click endpoint (body may be `List-Unsubscribe=One-Click`).
 */
export function unsubscribeRoutes(deps: UnsubscribeRouteDeps): Hono {
  const app = new Hono();

  app.get("/:token", async (c) => {
    const contact = await resolveAndUnsubscribe(deps, c.req.param("token"));
    return c.body(landingPage(contact.email), 200, {
      "content-type": "text/html; charset=utf-8",
    });
  });

  app.post("/:token", async (c) => {
    await resolveAndUnsubscribe(deps, c.req.param("token"));
    return c.body(null, 204);
  });

  return app;
}
