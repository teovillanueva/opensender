import type { ProviderVerificationStatus } from "../ports.js";

/**
 * DNS record construction (SPEC §7), pure. Shapes are fixture-31-exact:
 * relative record names, string ttl ("Auto" for DKIM/DMARC, "60" for the
 * MAIL FROM pair), the MX line tagged record "SPF" with a separate numeric
 * `priority`, per-record status.
 */

export type WireRecordStatus =
  | "not_started"
  | "pending"
  | "verified"
  | "failed"
  | "temporary_failure";

export interface DomainRecord {
  record: "DKIM" | "SPF" | "DMARC" | "MX";
  name: string;
  type: "CNAME" | "MX" | "TXT";
  ttl: string;
  status: WireRecordStatus;
  value: string;
  priority?: number;
}

export function toWireStatus(status: ProviderVerificationStatus): WireRecordStatus {
  switch (status) {
    case "SUCCESS":
      return "verified";
    case "PENDING":
      return "pending";
    case "FAILED":
      return "failed";
    case "TEMPORARY_FAILURE":
      return "temporary_failure";
    case "NOT_STARTED":
      return "not_started";
  }
}

/** Overall domain status: verified only when DKIM and MAIL FROM both are. */
export function domainStatus(
  dkim: ProviderVerificationStatus,
  mailFrom: ProviderVerificationStatus,
): WireRecordStatus {
  const statuses = [dkim, mailFrom];
  if (statuses.every((status) => status === "SUCCESS")) return "verified";
  if (statuses.includes("FAILED")) return "failed";
  if (statuses.includes("TEMPORARY_FAILURE")) return "temporary_failure";
  if (statuses.includes("PENDING")) return "pending";
  return "not_started";
}

export interface BuildRecordsInput {
  region: string;
  dkimTokens: string[];
  signingHostedZone: string;
  dkimStatus: ProviderVerificationStatus;
  mailFromStatus: ProviderVerificationStatus;
  /** When inbound is enabled, the receiving MX joins records[] (SPEC §9). */
  inboundEnabled?: boolean;
  /** Observed state of the receiving MX (DNS-resolved by refreshVerification —
   * SES never reports it). Absent means it was never checked. */
  inboundMxStatus?: ProviderVerificationStatus | undefined;
}

export function buildDomainRecords(input: BuildRecordsInput): DomainRecord[] {
  const dkimStatus = toWireStatus(input.dkimStatus);
  const mailFromStatus = toWireStatus(input.mailFromStatus);
  return [
    ...input.dkimTokens.map(
      (token): DomainRecord => ({
        record: "DKIM",
        name: `${token}._domainkey`,
        type: "CNAME",
        ttl: "Auto",
        status: dkimStatus,
        value: `${token}.${input.signingHostedZone}`,
      }),
    ),
    {
      record: "SPF",
      name: "send",
      type: "MX",
      ttl: "60",
      status: mailFromStatus,
      value: `feedback-smtp.${input.region}.amazonses.com`,
      priority: 10,
    },
    {
      record: "SPF",
      name: "send",
      type: "TXT",
      ttl: "60",
      status: mailFromStatus,
      value: "v=spf1 include:amazonses.com ~all",
    },
    {
      // Optional but always suggested; we never poll it, so it stays
      // not_started (SPEC §7 step 3).
      record: "DMARC",
      name: "_dmarc",
      type: "TXT",
      ttl: "Auto",
      status: "not_started",
      value: "v=DMARC1; p=none;",
    },
    ...(input.inboundEnabled
      ? [
          {
            // Receiving MX on the apex; priority 10 (R03 §6.1). Its status is
            // observed via DNS (inboundMxStatus), never via SES — receiving is
            // independent of sending verification.
            record: "MX" as const,
            name: "",
            type: "MX" as const,
            ttl: "Auto",
            // Binary: pending until DNS shows the MX, verified after.
            status: toWireStatus(input.inboundMxStatus ?? "PENDING"),
            // Inbound host is amazonAWS (not amazonSES like the feedback MX).
            value: `inbound-smtp.${input.region}.amazonaws.com`,
            priority: 10,
          },
        ]
      : []),
  ];
}
