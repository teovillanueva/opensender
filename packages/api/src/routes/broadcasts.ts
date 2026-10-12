import type { Broadcast, BroadcastsPort, SegmentsPort } from "@opensender/core";
import { parseScheduledAt, SendValidationError, toWireTimestamp } from "@opensender/core";
import { Hono } from "hono";
import { errors, ResendApiError, sendJson } from "../errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fan-out trigger for a broadcast (SPEC §11). The API layer only records the
 * intent and hands the id to this port; the Infra phase implements it (SQS
 * enqueue / scheduled dispatch). `scheduledAt` is the resolved ISO instant when
 * the send is deferred, omitted for send-now.
 */
export interface BroadcastSenderPort {
  send(broadcastId: string, teamId: string, scheduledAt?: string): Promise<void>;
}

export interface BroadcastsRouteDeps {
  broadcasts: BroadcastsPort;
  /** Validates that a referenced audience/segment belongs to the caller's team. */
  segments: SegmentsPort;
  broadcastSender: BroadcastSenderPort;
  now: () => Date;
}

/** A broadcast may only target an audience the caller's team owns (SPEC §12). */
async function requireOwnedSegment(
  deps: BroadcastsRouteDeps,
  teamId: string,
  segmentId: string,
): Promise<void> {
  const segment = await deps.segments.get(teamId, segmentId);
  if (!segment) throw errors.notFound("Audience not found");
}

function broadcastDetail(broadcast: Broadcast) {
  return {
    object: "broadcast",
    id: broadcast.broadcastId,
    name: broadcast.name ?? null,
    audience_id: broadcast.segmentId,
    from: broadcast.from,
    subject: broadcast.subject,
    reply_to: broadcast.replyTo ?? null,
    status: broadcast.status,
    created_at: toWireTimestamp(new Date(broadcast.createdAt)),
    scheduled_at:
      broadcast.scheduledAt === undefined ? null : toWireTimestamp(new Date(broadcast.scheduledAt)),
    sent_at: null,
  };
}

function broadcastSummary(broadcast: Broadcast) {
  return {
    id: broadcast.broadcastId,
    audience_id: broadcast.segmentId,
    status: broadcast.status,
    created_at: toWireTimestamp(new Date(broadcast.createdAt)),
    scheduled_at:
      broadcast.scheduledAt === undefined ? null : toWireTimestamp(new Date(broadcast.scheduledAt)),
    sent_at: null,
  };
}

async function requireBroadcast(
  deps: BroadcastsRouteDeps,
  teamId: string,
  id: string,
): Promise<Broadcast> {
  if (!UUID_PATTERN.test(id)) {
    throw errors.invalidParameter("The `id` must be a valid UUID.");
  }
  const broadcast = await deps.broadcasts.get(teamId, id);
  if (!broadcast) throw errors.notFound("Broadcast not found");
  return broadcast;
}

/** `audience_id` is the wire alias for `segment_id` on the marketing surface. */
function readSegmentId(body: { segment_id?: unknown; audience_id?: unknown }): string | undefined {
  if (typeof body.segment_id === "string") return body.segment_id;
  if (typeof body.audience_id === "string") return body.audience_id;
  return undefined;
}

/** Resend broadcasts surface (§5.12). */
export function broadcastRoutes(deps: BroadcastsRouteDeps): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => {
      throw errors.validationError(400, "Request body must be valid JSON.");
    })) as {
      segment_id?: unknown;
      audience_id?: unknown;
      from?: unknown;
      subject?: unknown;
      html?: unknown;
      text?: unknown;
      name?: unknown;
      reply_to?: unknown;
    };
    const segmentId = readSegmentId(body);
    if (segmentId === undefined) {
      throw errors.validationError(422, "Missing `audience_id` field.");
    }
    if (typeof body.from !== "string" || body.from.length === 0) {
      throw errors.validationError(422, "Missing `from` field.");
    }
    if (typeof body.subject !== "string" || body.subject.length === 0) {
      throw errors.validationError(422, "Missing `subject` field.");
    }
    const teamId = c.get("principal").teamId;
    await requireOwnedSegment(deps, teamId, segmentId);
    const broadcast = await deps.broadcasts.create({
      teamId,
      segmentId,
      from: body.from,
      subject: body.subject,
      ...(typeof body.html === "string" ? { html: body.html } : {}),
      ...(typeof body.text === "string" ? { text: body.text } : {}),
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.reply_to === "string" ? { replyTo: body.reply_to } : {}),
    });
    return sendJson(c, 201, { object: "broadcast", id: broadcast.broadcastId });
  });

  app.get("/", async (c) => {
    const list = await deps.broadcasts.list(c.get("principal").teamId);
    return sendJson(c, 200, {
      object: "list",
      has_more: false,
      data: list.map(broadcastSummary),
    });
  });

  app.get("/:id", async (c) => {
    const broadcast = await requireBroadcast(deps, c.get("principal").teamId, c.req.param("id"));
    return sendJson(c, 200, broadcastDetail(broadcast));
  });

  app.patch("/:id", async (c) => {
    const broadcast = await requireBroadcast(deps, c.get("principal").teamId, c.req.param("id"));
    const body = (await c.req.json().catch(() => {
      throw errors.validationError(400, "Request body must be valid JSON.");
    })) as {
      segment_id?: unknown;
      audience_id?: unknown;
      from?: unknown;
      subject?: unknown;
      html?: unknown;
      text?: unknown;
      name?: unknown;
      reply_to?: unknown;
    };
    const segmentId = readSegmentId(body);
    if (segmentId !== undefined) {
      await requireOwnedSegment(deps, c.get("principal").teamId, segmentId);
    }
    await deps.broadcasts.update(broadcast, {
      ...(segmentId === undefined ? {} : { segmentId }),
      ...(typeof body.from === "string" ? { from: body.from } : {}),
      ...(typeof body.subject === "string" ? { subject: body.subject } : {}),
      ...(typeof body.html === "string" ? { html: body.html } : {}),
      ...(typeof body.text === "string" ? { text: body.text } : {}),
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.reply_to === "string" ? { replyTo: body.reply_to } : {}),
    });
    return sendJson(c, 200, { object: "broadcast", id: broadcast.broadcastId });
  });

  app.post("/:id/send", async (c) => {
    const teamId = c.get("principal").teamId;
    const broadcast = await requireBroadcast(deps, teamId, c.req.param("id"));
    const body = (await c.req.json().catch(() => ({}))) as { scheduled_at?: unknown };

    let scheduledAt: string | undefined;
    if (typeof body.scheduled_at === "string" && body.scheduled_at.length > 0) {
      try {
        scheduledAt = parseScheduledAt(body.scheduled_at, deps.now());
      } catch (error) {
        if (error instanceof SendValidationError) {
          throw new ResendApiError(
            error.statusCode as ResendApiError["statusCode"],
            error.errorName,
            error.message,
          );
        }
        throw error;
      }
    }

    if (scheduledAt === undefined) {
      await deps.broadcasts.markStatus(broadcast.broadcastId, "sending");
      await deps.broadcastSender.send(broadcast.broadcastId, teamId);
    } else {
      await deps.broadcasts.setSchedule(broadcast.broadcastId, scheduledAt);
      await deps.broadcastSender.send(broadcast.broadcastId, teamId, scheduledAt);
    }
    return sendJson(c, 200, { object: "broadcast", id: broadcast.broadcastId });
  });

  app.delete("/:id", async (c) => {
    const broadcast = await requireBroadcast(deps, c.get("principal").teamId, c.req.param("id"));
    await deps.broadcasts.delete(broadcast.broadcastId);
    return sendJson(c, 200, { object: "broadcast", id: broadcast.broadcastId, deleted: true });
  });

  return app;
}
