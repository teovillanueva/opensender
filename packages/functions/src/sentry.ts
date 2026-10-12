import * as Sentry from "@sentry/aws-serverless";
import type { Handler } from "aws-lambda";
import { Resource } from "sst";

/**
 * Sentry error reporting for every Lambda (SPEC §15). Initialized once at
 * module load; the DSN is linked to all functions in sst.config. `withSentry`
 * wraps a handler so any unhandled error is captured and flushed before the
 * invocation ends. Tracing is off (errors only) to stay within the free tier.
 * An empty DSN (secret unset) makes Sentry a no-op rather than an error.
 */
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** Recursively mask email addresses anywhere in the event so recipient PII
 * never leaves the platform, regardless of where the SDK placed it (message,
 * exception values, the captured Lambda event/request). */
function scrubPii<T>(value: T): T {
  if (typeof value === "string") return value.replace(EMAIL_RE, "[redacted-email]") as T;
  if (Array.isArray(value)) return value.map(scrubPii) as T;
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      (value as Record<string, unknown>)[key] = scrubPii((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

Sentry.init({
  dsn: Resource.SentryDsn.value,
  environment: "production",
  tracesSampleRate: 0,
  beforeSend: (event) => scrubPii(event),
});

export function withSentry<E, R>(handler: Handler<E, R>): Handler<E, R> {
  return Sentry.wrapHandler(handler);
}
