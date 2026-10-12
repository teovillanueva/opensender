import * as chrono from "chrono-node";
import { SendValidationError } from "./validate.js";

/**
 * `scheduled_at` accepts ISO 8601 and natural language, parsed 100%
 * server-side with chrono-node; timezone-less phrases resolve against UTC
 * (SPEC §5.6). Max 30 days out.
 */

const MAX_DAYS_OUT = 30;

export function parseScheduledAt(value: string, now: Date): string {
  const parsed = chrono.parseDate(value, { instant: now, timezone: "UTC" }, { forwardDate: true });
  if (!parsed) {
    throw new SendValidationError(
      422,
      "validation_error",
      "Invalid `scheduled_at` field. Use ISO 8601 or natural language (e.g. 'in 1 min').",
    );
  }
  const maxMs = now.getTime() + MAX_DAYS_OUT * 24 * 60 * 60 * 1000;
  if (parsed.getTime() > maxMs) {
    throw new SendValidationError(
      422,
      "validation_error",
      "The `scheduled_at` field can be at most 30 days in the future.",
    );
  }
  return parsed.toISOString();
}
