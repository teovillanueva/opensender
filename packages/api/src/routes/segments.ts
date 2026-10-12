import type { Segment } from "@opensender/core";
import { toWireTimestamp } from "@opensender/core";
import { Hono } from "hono";
import { errors, sendJson } from "../errors.js";
import { type ContactsRouteDeps, contactRoutes } from "./contacts.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The two labels the same segment record wears on the wire (SPEC §11). */
type ObjectName = "segment" | "audience";

/** Segment routes need the segments port plus everything contacts need. */
export type SegmentsRouteDeps = ContactsRouteDeps;

/** GET/PATCH shape: the full record including the wire timestamp. */
function segmentDetail(objectName: ObjectName, segment: Segment) {
  return {
    object: objectName,
    id: segment.segmentId,
    name: segment.name,
    created_at: toWireTimestamp(new Date(segment.createdAt)),
  };
}

/** List-item shape: no `object` label, but the timestamp is present. */
function segmentSummary(segment: Segment) {
  return {
    id: segment.segmentId,
    name: segment.name,
    created_at: toWireTimestamp(new Date(segment.createdAt)),
  };
}

async function requireSegment(
  deps: SegmentsRouteDeps,
  teamId: string,
  id: string,
): Promise<Segment> {
  if (!UUID_PATTERN.test(id)) {
    throw errors.invalidParameter("The `id` must be a valid UUID.");
  }
  const segment = await deps.segments.get(teamId, id);
  if (!segment) throw errors.notFound("Audience not found");
  return segment;
}

/**
 * Resend audiences surface (§5.11). `/segments` and the deprecated `/audiences`
 * alias share this factory; `objectName` is the only difference on the wire.
 * Contacts mount underneath at `/:id/contacts`.
 */
export function segmentRoutes(deps: SegmentsRouteDeps, opts: { objectName: ObjectName }): Hono {
  const app = new Hono();
  const { objectName } = opts;

  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => {
      throw errors.validationError(400, "Request body must be valid JSON.");
    })) as { name?: unknown };
    if (typeof body.name !== "string" || body.name.length === 0) {
      throw errors.validationError(422, "Missing `name` field.");
    }
    const segment = await deps.segments.create({
      teamId: c.get("principal").teamId,
      name: body.name,
    });
    // Create response carries no created_at (fixture 16).
    return sendJson(c, 201, { object: objectName, id: segment.segmentId, name: segment.name });
  });

  app.get("/", async (c) => {
    const list = await deps.segments.list(c.get("principal").teamId);
    return sendJson(c, 200, { object: "list", has_more: false, data: list.map(segmentSummary) });
  });

  app.get("/:id", async (c) => {
    const segment = await requireSegment(deps, c.get("principal").teamId, c.req.param("id"));
    return sendJson(c, 200, segmentDetail(objectName, segment));
  });

  app.patch("/:id", async (c) => {
    const segment = await requireSegment(deps, c.get("principal").teamId, c.req.param("id"));
    const body = (await c.req.json().catch(() => {
      throw errors.validationError(400, "Request body must be valid JSON.");
    })) as { name?: unknown };
    const updated =
      typeof body.name === "string" && body.name.length > 0
        ? await deps.segments.updateName(segment, body.name)
        : segment;
    return sendJson(c, 200, segmentDetail(objectName, updated));
  });

  app.delete("/:id", async (c) => {
    const segment = await requireSegment(deps, c.get("principal").teamId, c.req.param("id"));
    await deps.segments.delete(segment.segmentId);
    return sendJson(c, 200, { object: objectName, id: segment.segmentId, deleted: true });
  });

  // Contacts hang off the parent segment; the parent id is c.req.param("id").
  app.route("/:id/contacts", contactRoutes(deps));

  return app;
}
