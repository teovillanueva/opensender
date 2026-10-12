import { requestBodyValidator } from "@opensender/contract";
import type { ApiKeysPort } from "@opensender/core";
import { toWireTimestamp } from "@opensender/core";
import { Hono } from "hono";
import { errors, sendJson } from "../errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERMISSIONS = ["full_access", "sending_access"] as const;

interface CreateApiKeyBody {
  name: string;
  permission?: (typeof PERMISSIONS)[number];
  domain_id?: string;
}

/** Resend surface §5.9: POST /api-keys, GET /api-keys, DELETE /api-keys/:id. */
export function apiKeyRoutes(deps: { apiKeys: ApiKeysPort }): Hono {
  const app = new Hono();
  const validateCreate = requestBodyValidator("/api-keys", "post");

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => {
      throw errors.validationError(400, "Request body must be valid JSON.");
    });

    // The SPEC error table pins bad permission values to invalid_access —
    // check it before the generic schema pass.
    if (
      body !== null &&
      typeof body === "object" &&
      "permission" in body &&
      !PERMISSIONS.includes((body as { permission: never }).permission)
    ) {
      throw errors.invalidAccess("Access must be 'full_access' | 'sending_access'");
    }
    if (!validateCreate(body)) {
      throw errors.validationError(422, ajvMessage(validateCreate.errors));
    }

    const input = body as unknown as CreateApiKeyBody;
    const principal = c.get("principal");
    const { key, token } = await deps.apiKeys.createKey({
      teamId: principal.teamId,
      name: input.name,
      permission: input.permission ?? "full_access",
      ...(input.domain_id === undefined ? {} : { domainId: input.domain_id }),
    });
    return sendJson(c, 201, { id: key.keyId, object: "api_key", token });
  });

  app.get("/", async (c) => {
    const principal = c.get("principal");
    const keys = await deps.apiKeys.listKeys(principal.teamId);
    return sendJson(c, 200, {
      object: "list",
      has_more: false,
      data: keys.map((key) => ({
        id: key.keyId,
        name: key.name,
        created_at: toWireTimestamp(new Date(key.createdAt)),
        last_used_at: key.lastUsedAt ? toWireTimestamp(new Date(key.lastUsedAt)) : null,
      })),
    });
  });

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID_PATTERN.test(id)) {
      throw errors.invalidParameter("The `id` must be a valid UUID.");
    }
    const principal = c.get("principal");
    const deleted = await deps.apiKeys.deleteKey(principal.teamId, id);
    if (!deleted) throw errors.notFound("API key not found");
    return sendJson(c, 200, { object: "api_key", id, deleted: true });
  });

  return app;
}

function ajvMessage(errorList: unknown): string {
  const first = Array.isArray(errorList) ? errorList[0] : undefined;
  const message =
    first && typeof first === "object" && "message" in first
      ? String((first as { message: unknown }).message)
      : "Invalid request body";
  return message.charAt(0).toUpperCase() + message.slice(1);
}
