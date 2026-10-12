/**
 * Per-instance configuration (SPEC §20). A new opensender instance = fork the
 * repo, edit this file, point AWS credentials at the target account, deploy.
 * The schema lives in `instance.config.types.ts`; keep this file values-only.
 * Secrets NEVER live here — they go through `sst secret`.
 */
import type { InstanceConfig } from "./instance.config.types.js";

export const instanceConfig: InstanceConfig = {
  productName: "opensender",
  instanceName: "opensender",
  domain: "mailing.example.com",
  region: "us-east-1",
  dnsMode: "route53",
  alertEmail: "ops@example.com",
  monthlyBudgetUsd: 25,
  signupOpen: false,
  sesMaxSendRatePerSecond: 14,
  plans: {
    default: { dailyEmailLimit: 1_000, apiRateLimitPerSecond: 10 },
    internal: { dailyEmailLimit: 50_000, apiRateLimitPerSecond: 10 },
  },
  defaultPlan: "default",
  guardrails: {
    // Conservative: SES's own account-review thresholds sit near these.
    bounceRateThreshold: 0.05,
    complaintRateThreshold: 0.001,
    minSampleSize: 50,
  },
};
