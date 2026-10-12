import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * The single error seam (SPEC §5.1): every non-2xx body leaves through here,
 * shaped exactly like the golden fixtures — including the quirks (invalid
 * API key is 400 `validation_error`, not the documented 403).
 */

export class ResendApiError extends Error {
  constructor(
    readonly statusCode: ContentfulStatusCode,
    readonly errorName: string,
    message: string,
  ) {
    super(message);
  }
}

export const errors = {
  missingApiKey: () => new ResendApiError(401, "missing_api_key", "Missing API Key"),
  invalidApiKey: () => new ResendApiError(400, "validation_error", "API key is invalid"),
  restrictedApiKey: () =>
    new ResendApiError(401, "restricted_api_key", "This API key is restricted to only send emails"),
  notFound: (message: string) => new ResendApiError(404, "not_found", message),
  methodNotAllowed: (method: string) =>
    new ResendApiError(
      405,
      "method_not_allowed",
      `Method ${method} is not allowed for the requested path.`,
    ),
  rateLimitExceeded: () =>
    new ResendApiError(
      429,
      "rate_limit_exceeded",
      "Too many requests. You can only make 10 requests per second. See rate limit response headers for more information. Or contact support to increase rate limit.",
    ),
  validationError: (status: ContentfulStatusCode, message: string) =>
    new ResendApiError(status, "validation_error", message),
  invalidAccess: (message: string) => new ResendApiError(422, "invalid_access", message),
  invalidParameter: (message: string) => new ResendApiError(422, "invalid_parameter", message),
  invalidRegion: () =>
    new ResendApiError(
      422,
      "invalid_region",
      "Region must be 'us-east-1' | 'eu-west-1' | 'sa-east-1' | 'ap-northeast-1'",
    ),
  internal: () => new ResendApiError(500, "internal_server_error", "Internal server error"),
};

/** Fixture parity includes the charset — Hono's c.json omits it. */
export function sendJson(c: Context, status: ContentfulStatusCode, body: unknown): Response {
  return c.body(JSON.stringify(body), status, {
    "content-type": "application/json; charset=utf-8",
  });
}

export function sendError(c: Context, error: ResendApiError): Response {
  return sendJson(c, error.statusCode, {
    statusCode: error.statusCode,
    message: error.message,
    name: error.errorName,
  });
}
