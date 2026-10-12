import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mapSesEvent, type SesEventDetail } from "../src/events/ses-mapping.js";

/**
 * Replay of REAL SES events captured from production via the mailbox
 * simulators (SPEC §17 harness) — the ACL must map every captured shape.
 */

const FIXTURES = join(import.meta.dirname, "fixtures/ses-events");

function fixture(name: string): SesEventDetail {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

describe("captured SES event fixtures replay offline", () => {
  it("has the four simulator-captured shapes committed", () => {
    const files = readdirSync(FIXTURES);
    for (const name of ["send.json", "delivery.json", "bounce.json", "complaint.json"]) {
      expect(files, name).toContain(name);
    }
  });

  it("maps the real delivery event", () => {
    const mapped = mapSesEvent(fixture("delivery.json"));
    expect(mapped).toMatchObject({ resendType: "email.delivered", newStatus: "delivered" });
  });

  it("maps the real bounce with suppression and diagnostics", () => {
    const detail = fixture("bounce.json");
    const mapped = mapSesEvent(detail);
    expect(mapped.resendType).toBe("email.bounced");
    expect(mapped.suppress?.reason).toBe("hard_bounce");
    expect(mapped.suppress?.recipients.length).toBeGreaterThan(0);
    const bounce = mapped.extras.bounce as { type: string; diagnosticCode: string[] };
    expect(bounce.type).toBe("Permanent");
    expect(detail.mail.tags?.email_id?.[0]).toBeTruthy();
  });

  it("maps the real complaint to suppression", () => {
    const mapped = mapSesEvent(fixture("complaint.json"));
    expect(mapped.resendType).toBe("email.complained");
    expect(mapped.suppress?.reason).toBe("complaint");
  });

  it("ignores the real Send event (we emit email.sent ourselves)", () => {
    expect(mapSesEvent(fixture("send.json")).resendType).toBeNull();
  });
});
