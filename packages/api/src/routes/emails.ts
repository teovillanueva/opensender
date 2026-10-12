import { createHash } from "node:crypto";
import type { EmailsPort, QuotaUsage, StoredEmail } from "@opensender/core";
import {
  type IdempotencyStore,
  parseScheduledAt,
  SendRejectedError,
  SendValidationError,
  toWireEmail,
  toWireTimestamp,
  validateSendRequest,
} from "@opensender/core";
import type { Context, Hono } from "hono";
import { Hono as HonoApp } from "hono";
import { errors, ResendApiError, sendJson } from "../errors.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTACHMENT_URL_TTL_SECONDS = 3600;

export interface EmailsRouteDeps {
  emails: EmailsPort;
  idempotency: Pick<IdempotencyStore, "claim" | "complete" | "release">;
  quotaUsage: (teamId: string) => Promise<QuotaUsage>;
  now: () => Date;
}

function toApiError(error: unknown): ResendApiError {
  if (error instanceof ResendApiError) return error;
  if (error instanceof SendValidationError || error instanceof SendRejectedError) {
    return new ResendApiError(
      error.statusCode as ResendApiError["statusCode"],
      error.errorName,
      error.message,
    );
  }
  throw error;
}

function quotaHeaders(usage: QuotaUsage): Record<string, string> {
  return {
    "x-resend-daily-quota": String(usage.daily),
    "x-resend-monthly-quota": String(usage.monthly),
  };
}

function respond(
  c: Context,
  status: number,
  body: unknown,
  headers: Record<string, string>,
): Response {
  const response = sendJson(c, status as Parameters<typeof sendJson>[1], body);
  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
  return response;
}

/** Resend surface §5.4–5.7: /emails and /emails/batch. */
export function emailRoutes(deps: EmailsRouteDeps): Hono {
  const app = new HonoApp();

  async function readJson(c: Context): Promise<{ raw: string; body: unknown }> {
    const raw = await c.req.text();
    try {
      return { raw, body: JSON.parse(raw) };
    } catch {
      throw errors.validationError(400, "Request body must be valid JSON.");
    }
  }

  /**
   * Wraps a POST handler with idempotency (SPEC §5.7) and the quota headers
   * (POST /emails* only; also present on errors, fixtures 26-28). Error
   * responses never consume the idempotency key.
   */
  async function withSendSemantics(
    c: Context,
    endpoint: string,
    rawBody: string,
    handler: () => Promise<{ status: number; body: unknown; usage: QuotaUsage }>,
  ): Promise<Response> {
    const teamId = c.get("principal").teamId;
    const key = c.req.header("idempotency-key");

    if (key === undefined) {
      try {
        const result = await handler();
        return respond(c, result.status, result.body, quotaHeaders(result.usage));
      } catch (error) {
        const apiError = toApiError(error);
        return respond(
          c,
          apiError.statusCode,
          { statusCode: apiError.statusCode, message: apiError.message, name: apiError.errorName },
          quotaHeaders(await deps.quotaUsage(teamId)),
        );
      }
    }

    if (key.length < 1 || key.length > 256) {
      const usage = await deps.quotaUsage(teamId);
      return respond(
        c,
        400,
        {
          statusCode: 400,
          message: "The `Idempotency-Key` header must be between 1 and 256 characters.",
          name: "invalid_idempotency_key",
        },
        quotaHeaders(usage),
      );
    }

    const bodyHash = createHash("sha256").update(rawBody).digest("hex");
    const claim = await deps.idempotency.claim(teamId, endpoint, key, bodyHash);

    if (claim.kind === "replay") {
      // Replays still tick the daily counter (R07 flag 9 / fixture 35).
      const usage = await deps.quotaUsage(teamId);
      const response = respond(c, claim.response.status, JSON.parse(claim.response.body), {
        ...quotaHeaders(usage),
        "idempotent-replayed": "true",
      });
      return response;
    }
    if (claim.kind === "mismatch") {
      const usage = await deps.quotaUsage(teamId);
      return respond(
        c,
        409,
        {
          statusCode: 409,
          name: "invalid_idempotent_request",
          message:
            "This idempotency key has been used with this HTTP method and endpoint within the last 24 hours, but the request body was modified and doesn't match the original request.",
        },
        quotaHeaders(usage),
      );
    }
    if (claim.kind === "in_flight") {
      const usage = await deps.quotaUsage(teamId);
      return respond(
        c,
        409,
        {
          statusCode: 409,
          name: "concurrent_idempotent_requests",
          message:
            "Another request with the same idempotency key is still being processed. Retry once it completes.",
        },
        quotaHeaders(usage),
      );
    }

    try {
      const result = await handler();
      await deps.idempotency.complete(teamId, endpoint, key, {
        status: result.status,
        body: JSON.stringify(result.body),
      });
      return respond(c, result.status, result.body, {
        ...quotaHeaders(result.usage),
        "idempotent-replayed": "false",
      });
    } catch (error) {
      const apiError = toApiError(error);
      await deps.idempotency.release(teamId, endpoint, key);
      return respond(
        c,
        apiError.statusCode,
        { statusCode: apiError.statusCode, message: apiError.message, name: apiError.errorName },
        {
          ...quotaHeaders(await deps.quotaUsage(teamId)),
          "idempotent-replayed": "false",
        },
      );
    }
  }

  app.post("/", async (c) => {
    const { raw, body } = await readJson(c);
    return withSendSemantics(c, "POST /emails", raw, async () => {
      const request = validateSendRequest(body);
      if (request.scheduledAt !== undefined) {
        request.scheduledAt = parseScheduledAt(request.scheduledAt, deps.now());
      }
      const principal = c.get("principal");
      const { email, usage } = await deps.emails.send(principal.teamId, request, {
        enforceSync: true,
        ...(principal.apiKey ? { apiKeyId: principal.apiKey.keyId } : {}),
        allowedDomainIds: principal.allowedDomainIds,
      });
      return { status: 200, body: { id: email.emailId }, usage };
    });
  });

  app.post("/batch", async (c) => {
    const { raw, body } = await readJson(c);
    const permissive = c.req.header("x-batch-validation") === "permissive";
    return withSendSemantics(c, "POST /emails/batch", raw, async () => {
      if (!Array.isArray(body)) {
        throw errors.validationError(422, "The request body must be an array of emails.");
      }
      if (body.length === 0) {
        throw errors.validationError(422, "The request body must contain at least one email.");
      }
      if (body.length > 100) {
        throw errors.validationError(422, "The request body can contain at most 100 emails.");
      }

      const teamId = c.get("principal").teamId;
      const parsed: Array<
        | { index: number; request: ReturnType<typeof validateSendRequest> }
        | { index: number; error: ResendApiError }
      > = body.map((item, index) => {
        try {
          const request = validateSendRequest(item);
          if (request.attachments.length > 0) {
            throw new SendValidationError(
              422,
              "validation_error",
              "Attachments are not supported for batch emails.",
            );
          }
          if (request.scheduledAt !== undefined) {
            request.scheduledAt = parseScheduledAt(request.scheduledAt, deps.now());
          }
          return { index, request };
        } catch (error) {
          return { index, error: toApiError(error) };
        }
      });

      const firstError = parsed.find(
        (entry): entry is { index: number; error: ResendApiError } => "error" in entry,
      );
      if (firstError && !permissive) {
        // Strict default: all-or-nothing, first error, no index (fixture 28).
        throw firstError.error;
      }

      const data: Array<{ id: string }> = [];
      let usage: QuotaUsage = await deps.quotaUsage(teamId);
      for (const entry of parsed) {
        if ("error" in entry) continue;
        const batchPrincipal = c.get("principal");
        const result = await deps.emails.send(teamId, entry.request, {
          enforceSync: false,
          ...(batchPrincipal.apiKey ? { apiKeyId: batchPrincipal.apiKey.keyId } : {}),
          allowedDomainIds: batchPrincipal.allowedDomainIds,
        });
        data.push({ id: result.email.emailId });
        usage = result.usage;
      }

      if (permissive) {
        const errorList = parsed
          .filter((entry): entry is { index: number; error: ResendApiError } => "error" in entry)
          .map((entry) => ({ index: entry.index, message: entry.error.message }));
        return { status: 202, body: { data, errors: errorList }, usage };
      }
      return { status: 200, body: { data }, usage };
    });
  });

  app.get("/:id", async (c) => {
    const email = await requireEmail(c);
    return sendJson(c, 200, toWireEmail(email));
  });

  app.get("/", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = Math.min(Math.max(Number(limitParam ?? 20) || 20, 1), 100);
    const after = c.req.query("after");
    const before = c.req.query("before");
    if (after !== undefined && before !== undefined) {
      throw errors.invalidParameter("Cannot use both `after` and `before` parameters.");
    }
    for (const [name, value] of [
      ["after", after],
      ["before", before],
    ] as const) {
      if (value !== undefined && !UUID_PATTERN.test(value)) {
        throw errors.invalidParameter(`The \`${name}\` parameter must be a valid email ID.`);
      }
    }
    const page = await deps.emails.listEmailsByCursor(c.get("principal").teamId, limit, {
      after,
      before,
    });
    if (!page) throw errors.notFound("Email not found");
    return sendJson(c, 200, {
      object: "list",
      has_more: page.hasMore,
      data: page.emails.map((email) => toWireEmail(email)),
    });
  });

  app.patch("/:id", async (c) => {
    const email = await requireEmail(c);
    const { body: patchBody } = await readJson(c);
    const body = patchBody as { scheduled_at?: unknown };
    if (typeof body.scheduled_at !== "string") {
      throw errors.validationError(422, "Missing `scheduled_at` field.");
    }
    try {
      await deps.emails.updateScheduledAt(email, parseScheduledAt(body.scheduled_at, deps.now()));
    } catch (error) {
      throw toApiError(error);
    }
    return sendJson(c, 200, { object: "email", id: email.emailId });
  });

  app.post("/:id/cancel", async (c) => {
    const email = await requireEmail(c);
    try {
      await deps.emails.cancel(email);
    } catch (error) {
      throw toApiError(error);
    }
    return sendJson(c, 200, { object: "email", id: email.emailId });
  });

  app.get("/:id/attachments", async (c) => {
    const email = await requireEmail(c);
    const data = await Promise.all(
      (email.attachments ?? []).map((attachment) => wireAttachment(attachment)),
    );
    return sendJson(c, 200, { object: "list", has_more: false, data });
  });

  app.get("/:id/attachments/:attachmentId", async (c) => {
    const email = await requireEmail(c);
    const attachment = (email.attachments ?? []).find(
      (entry) => entry.attachmentId === (c.req.param("attachmentId") ?? ""),
    );
    if (!attachment) throw errors.notFound("Attachment not found");
    return sendJson(c, 200, await wireAttachment(attachment));
  });

  async function requireEmail(c: Context): Promise<StoredEmail> {
    const id = c.req.param("id") ?? "";
    if (!UUID_PATTERN.test(id)) {
      throw errors.invalidParameter("The `id` must be a valid UUID.");
    }
    const email = await deps.emails.getEmail(c.get("principal").teamId, id);
    if (!email) throw errors.notFound("Email not found");
    return email;
  }

  async function wireAttachment(attachment: NonNullable<StoredEmail["attachments"]>[number]) {
    const expiresAt = new Date(deps.now().getTime() + ATTACHMENT_URL_TTL_SECONDS * 1000);
    return {
      object: "attachment",
      id: attachment.attachmentId,
      filename: attachment.filename,
      content_type: attachment.contentType ?? "application/octet-stream",
      content_disposition: attachment.contentId ? "inline" : "attachment",
      ...(attachment.contentId ? { content_id: attachment.contentId } : {}),
      size: attachment.sizeBytes,
      download_url: await deps.emails.attachmentDownloadUrl(attachment, ATTACHMENT_URL_TTL_SECONDS),
      expires_at: toWireTimestamp(expiresAt),
    };
  }

  return app;
}
