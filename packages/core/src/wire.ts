/**
 * Resend serializes timestamps Postgres-style — space separator, microsecond
 * precision, `+00` offset: "2026-08-08 17:58:15.369000+00" (SPEC §5,
 * fixture-observed on every created_at). JS Dates carry milliseconds, so the
 * last three digits are always zero.
 */
export function toWireTimestamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 23)}000+00`;
}
