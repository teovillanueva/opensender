import type { WebhookEndpoint, WebhooksPort } from "@opensender/core";
import { toWireTimestamp } from "@opensender/core";
import { Hono } from "hono";
import { errors, sendJson } from "../errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The 19-type catalog (SPEC §8.2). */
const EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.opened",
  "email.clicked",
  "email.scheduled",
  "email.suppressed",
  "email.received",
  "contact.created",
  "contact.updated",
  "contact.deleted",
  "domain.created",
  "domain.updated",
  "domain.deleted",
  "suppression.added",
  "suppression.removed",
];

function summary(endpoint: WebhookEndpoint) {
  return {
    id: endpoint.endpointId,
    endpoint: endpoint.endpoint,
    events: endpoint.events,
    status: endpoint.status,
    created_at: toWireTimestamp(new Date(endpoint.createdAt)),
  };
}

function validateEvents(events: unknown): string[] {
  if (!Array.isArray(events) || events.length === 0) {
    throw errors.validationError(422, "Missing `events` field.");
  }
  for (const event of events) {
    if (typeof event !== "string" || !EVENT_TYPES.includes(event)) {
      throw errors.validationError(422, `Invalid event type \`${String(event)}\`.`);
    }
  }
  return events as string[];
}

/** Resend surface §5.13 — upstream shapes verbatim (R02 §7). */
export function webhookRoutes(deps: { webhooks: WebhooksPort }): Hono {
  const app = new Hono();

  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => {
      throw errors.validationError(400, "Request body must be valid JSON.");
    })) as { endpoint?: unknown; events?: unknown };
    if (typeof body.endpoint !== "string" || !/^https?:\/\//.test(body.endpoint)) {
      throw errors.validationError(422, "Missing or invalid `endpoint` field.");
    }
    const events = validateEvents(body.events);
    const endpoint = await deps.webhooks.createEndpoint({
      teamId: c.get("principal").teamId,
      endpoint: body.endpoint,
      events,
    });
    return sendJson(c, 201, {
      object: "webhook",
      id: endpoint.endpointId,
      signing_secret: endpoint.signingSecret,
    });
  });

  app.get("/", async (c) => {
    const list = await deps.webhooks.listEndpoints(c.get("principal").teamId);
    // No signing_secret in list items (R02 §7).
    return sendJson(c, 200, { object: "list", has_more: false, data: list.map(summary) });
  });

  app.get("/:id", async (c) => {
    const endpoint = await requireEndpoint(c.get("principal").teamId, c.req.param("id") ?? "");
    return sendJson(c, 200, {
      object: "webhook",
      ...summary(endpoint),
      signing_secret: endpoint.signingSecret,
    });
  });

  app.patch("/:id", async (c) => {
    const endpoint = await requireEndpoint(c.get("principal").teamId, c.req.param("id") ?? "");
    const body = (await c.req.json().catch(() => {
      throw errors.validationError(400, "Request body must be valid JSON.");
    })) as { endpoint?: unknown; events?: unknown; status?: unknown };
    if (body.status !== undefined && body.status !== "enabled" && body.status !== "disabled") {
      throw errors.validationError(422, "The `status` field must be 'enabled' | 'disabled'.");
    }
    await deps.webhooks.updateEndpoint(endpoint, {
      ...(typeof body.endpoint === "string" ? { endpoint: body.endpoint } : {}),
      ...(body.events === undefined ? {} : { events: validateEvents(body.events) }),
      ...(body.status === undefined ? {} : { status: body.status as "enabled" | "disabled" }),
    });
    return sendJson(c, 200, { object: "webhook", id: endpoint.endpointId });
  });

  app.delete("/:id", async (c) => {
    const endpoint = await requireEndpoint(c.get("principal").teamId, c.req.param("id") ?? "");
    await deps.webhooks.deleteEndpoint(endpoint.endpointId);
    return sendJson(c, 200, { object: "webhook", id: endpoint.endpointId, deleted: true });
  });

  async function requireEndpoint(teamId: string, id: string): Promise<WebhookEndpoint> {
    if (!UUID_PATTERN.test(id)) {
      throw errors.invalidParameter("The `id` must be a valid UUID.");
    }
    const endpoint = await deps.webhooks.getEndpoint(teamId, id);
    if (!endpoint) throw errors.notFound("Webhook not found");
    return endpoint;
  }

  return app;
}
