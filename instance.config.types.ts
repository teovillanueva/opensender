/**
 * Shape of `instance.config.ts` (SPEC §20). Kept apart from the values so
 * instance forks only ever edit `instance.config.ts` and upstream changes to
 * the schema merge cleanly.
 */

/** Inbound receiving is only supported by SES in these regions (SPEC §2). */
type InstanceRegion = "us-east-1" | "us-west-2" | "eu-west-1";

interface PlanConfig {
  /** Max outbound emails per team per day. */
  dailyEmailLimit: number;
  /** Public-API rate limit per team, requests per second (SPEC §5.2). */
  apiRateLimitPerSecond: number;
}

export interface InstanceConfig {
  productName: string;
  /** Dashboard title / branding. */
  instanceName: string;
  /** Dashboard domain; the API is served at `api.<domain>`. */
  domain: string;
  region: InstanceRegion;
  /**
   * `route53`: the zone lives in this account and records are created
   * automatically. `manual`: bootstrap emits the required records for the
   * operator to load at any DNS provider.
   */
  dnsMode: "route53" | "manual";
  alertEmail: string;
  monthlyBudgetUsd: number;
  /** When false, Better-auth sign-up is disabled server-side (SPEC §13.1). */
  signupOpen: boolean;
  /**
   * SES account-level send rate. The broadcast fan-out paces its sends to a
   * fair share of this cap (rate / consumer concurrency) so the fleet's
   * aggregate stays below it regardless of per-team API limits (SPEC §20).
   */
  sesMaxSendRatePerSecond: number;
  /** Named quota profiles; teams are assigned one manually (no billing). */
  plans: Record<string, PlanConfig>;
  /** Plan new teams start on — the conservative one (SPEC §12). */
  defaultPlan: string;
  /** Reputation auto-freeze thresholds (SPEC §12). */
  guardrails: GuardrailsConfig;
}

interface GuardrailsConfig {
  /** Freeze a team when bounces/sends in the window exceed this (0–1). */
  bounceRateThreshold: number;
  /** Freeze a team when complaints/sends in the window exceed this (0–1). */
  complaintRateThreshold: number;
  /** Only evaluate rates once the window has at least this many sends, so a
   * handful of early bounces can't freeze a low-volume team. */
  minSampleSize: number;
}
