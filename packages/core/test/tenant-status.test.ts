import { describe, expect, it } from "vitest";
import { parseTenantStatusEvent } from "../src/teams/tenant-status.js";

/** Verbatim shape from the SES Developer Guide "Tenants" EventBridge example. */
function event(status: string, origin = "CUSTOMER_MANAGED") {
  return {
    "detail-type": status === "DISABLED" ? "Sending Status Disabled" : "Sending Status Enabled",
    source: "aws.ses",
    resources: ["arn:aws:ses:us-east-1:012345678901:tenant/team-abc123/tn-2a8c678ec0000fd"],
    detail: {
      version: "1.0.0",
      data: {
        origin,
        record: { status, cause: "Status manually updated.", lastUpdatedTimestamp: [2025, 7, 24] },
      },
    },
  };
}

describe("parseTenantStatusEvent (SES tenant sending-status)", () => {
  it("maps DISABLED to frozen and extracts the tenant from the ARN", () => {
    expect(parseTenantStatusEvent(event("DISABLED"))).toEqual({
      tenantName: "team-abc123",
      tenantId: "tn-2a8c678ec0000fd",
      status: "frozen",
      sesStatus: "DISABLED",
      origin: "CUSTOMER_MANAGED",
    });
  });

  it("maps ENABLED and REINSTATED to active", () => {
    expect(parseTenantStatusEvent(event("ENABLED"))?.status).toBe("active");
    expect(parseTenantStatusEvent(event("REINSTATED"))?.status).toBe("active");
  });

  it("carries the AWS_MANAGED origin (reputation-policy auto-pause)", () => {
    expect(parseTenantStatusEvent(event("DISABLED", "AWS_MANAGED"))?.origin).toBe("AWS_MANAGED");
  });

  it("returns undefined for malformed or non-tenant events", () => {
    expect(parseTenantStatusEvent(null)).toBeUndefined();
    expect(parseTenantStatusEvent({ resources: [], detail: {} })).toBeUndefined();
    expect(
      parseTenantStatusEvent({ resources: ["arn:aws:ses:us-east-1:0:identity/x.com"], detail: {} }),
    ).toBeUndefined();
    expect(
      parseTenantStatusEvent({ resources: ["arn:...:tenant/team-x/tn-1"], detail: {} }),
    ).toBeUndefined(); // no status
  });
});
