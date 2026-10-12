import type { Contact, ContactsPort, SegmentsPort } from "@opensender/core";
import { toWireTimestamp } from "@opensender/core";
import { type Context, Hono } from "hono";
import { errors, sendJson } from "../errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ContactsRouteDeps {
  contacts: ContactsPort;
  segments: SegmentsPort;
}

/** GET shape: full record, always including `properties:{}` (fixture 19). */
function contactDetail(contact: Contact) {
  return {
    object: "contact",
    id: contact.contactId,
    email: contact.email,
    first_name: contact.firstName ?? null,
    last_name: contact.lastName ?? null,
    created_at: toWireTimestamp(new Date(contact.createdAt)),
    unsubscribed: contact.unsubscribed,
    properties: {},
  };
}

/** List-item shape: no `object`, no `properties` (fixture 20). */
function contactSummary(contact: Contact) {
  return {
    id: contact.contactId,
    email: contact.email,
    first_name: contact.firstName ?? null,
    last_name: contact.lastName ?? null,
    created_at: toWireTimestamp(new Date(contact.createdAt)),
    unsubscribed: contact.unsubscribed,
  };
}

/**
 * Contacts nested under a segment/audience (SPEC §11). The parent id is the
 * `:id` path segment of the mount point; the contact path segment resolves by
 * UUID or, when it is an email address, via the (segmentId,email) GSI.
 */
export function contactRoutes(deps: ContactsRouteDeps): Hono {
  const app = new Hono();

  async function requireSegment(c: Context): Promise<{ teamId: string; segmentId: string }> {
    const teamId = c.get("principal").teamId;
    // The parent `:id` comes from the mount point, so Hono cannot infer it.
    const segmentId = c.req.param("id") ?? "";
    if (!UUID_PATTERN.test(segmentId)) {
      throw errors.invalidParameter("The `id` must be a valid UUID.");
    }
    const segment = await deps.segments.get(teamId, segmentId);
    if (!segment) throw errors.notFound("Audience not found");
    return { teamId, segmentId };
  }

  async function requireContact(
    teamId: string,
    segmentId: string,
    idOrEmail: string,
  ): Promise<Contact> {
    const contact = await deps.contacts.getByIdOrEmail(teamId, segmentId, idOrEmail);
    if (!contact) throw errors.notFound("Contact not found");
    return contact;
  }

  app.post("/", async (c) => {
    const { teamId, segmentId } = await requireSegment(c);
    const body = (await c.req.json().catch(() => {
      throw errors.validationError(400, "Request body must be valid JSON.");
    })) as {
      email?: unknown;
      first_name?: unknown;
      last_name?: unknown;
      unsubscribed?: unknown;
    };
    if (typeof body.email !== "string" || body.email.length === 0) {
      throw errors.validationError(422, "Missing `email` field.");
    }
    const contact = await deps.contacts.create({
      teamId,
      segmentId,
      email: body.email,
      ...(typeof body.first_name === "string" ? { firstName: body.first_name } : {}),
      ...(typeof body.last_name === "string" ? { lastName: body.last_name } : {}),
      ...(typeof body.unsubscribed === "boolean" ? { unsubscribed: body.unsubscribed } : {}),
    });
    // Create response carries the id only (fixture 18).
    return sendJson(c, 201, { object: "contact", id: contact.contactId });
  });

  app.get("/", async (c) => {
    const { segmentId } = await requireSegment(c);
    const list = await deps.contacts.list(segmentId);
    return sendJson(c, 200, { object: "list", has_more: false, data: list.map(contactSummary) });
  });

  app.get("/:contactId", async (c) => {
    const { teamId, segmentId } = await requireSegment(c);
    const contact = await requireContact(teamId, segmentId, c.req.param("contactId"));
    return sendJson(c, 200, contactDetail(contact));
  });

  app.patch("/:contactId", async (c) => {
    const { teamId, segmentId } = await requireSegment(c);
    const contact = await requireContact(teamId, segmentId, c.req.param("contactId"));
    const body = (await c.req.json().catch(() => {
      throw errors.validationError(400, "Request body must be valid JSON.");
    })) as { first_name?: unknown; last_name?: unknown; unsubscribed?: unknown };
    await deps.contacts.update(contact, {
      ...(typeof body.first_name === "string" ? { firstName: body.first_name } : {}),
      ...(typeof body.last_name === "string" ? { lastName: body.last_name } : {}),
      ...(typeof body.unsubscribed === "boolean" ? { unsubscribed: body.unsubscribed } : {}),
    });
    // Update response carries the id only (fixture 21).
    return sendJson(c, 200, { object: "contact", id: contact.contactId });
  });

  app.delete("/:contactId", async (c) => {
    const { teamId, segmentId } = await requireSegment(c);
    const contact = await requireContact(teamId, segmentId, c.req.param("contactId"));
    await deps.contacts.delete(contact);
    // Quirk: the id field is named `contact`, not `id` (fixture 22).
    return sendJson(c, 200, { object: "contact", contact: contact.contactId, deleted: true });
  });

  return app;
}
