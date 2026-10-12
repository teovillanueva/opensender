import { describe, expect, it, vi } from "vitest";
import type { ReputationWindow } from "../src/adapters/reputation-counters.js";
import type { AlertPublisher } from "../src/ports.js";
import { type GuardrailsConfig, ReputationService } from "../src/reputation/reputation.js";
import type { Team } from "../src/teams/teams.js";

const CONFIG: GuardrailsConfig = {
  bounceRateThreshold: 0.05,
  complaintRateThreshold: 0.001,
  minSampleSize: 50,
};

/** In-memory counters + team + alert fakes for the rate/freeze logic. */
function harness(initial: Partial<ReputationWindow>, teamStatus: Team["status"] = "active") {
  const window: ReputationWindow = { sends: 0, bounces: 0, complaints: 0, ...initial };
  const team: Team = {
    teamId: "t1",
    name: "T1",
    sesTenantName: "team-t1",
    plan: "default",
    status: teamStatus,
    createdAt: "2026-08-09T00:00:00.000Z",
  };
  const alerts: AlertPublisher = { publish: vi.fn(async () => {}) };
  const counters = {
    recordSends: vi.fn(async (_t: string, n: number) => {
      window.sends += n;
    }),
    recordBounce: vi.fn(async () => {
      window.bounces += 1;
    }),
    recordComplaint: vi.fn(async () => {
      window.complaints += 1;
    }),
    current: vi.fn(async () => ({ ...window })),
  };
  const teams = {
    getTeam: vi.fn(async () => team),
    setStatus: vi.fn(async (_t: string, status: Team["status"]) => {
      team.status = status;
      return team;
    }),
  };
  const service = new ReputationService({ counters, teams, alerts, config: CONFIG });
  return { service, alerts, teams, counters, team };
}

describe("reputation auto-freeze (SPEC §12)", () => {
  it("freezes and alerts when the bounce rate breaches the threshold", async () => {
    // 99 sends already; this bounce makes 5/99 ≈ 5.05% > 5%.
    const { service, teams, alerts } = harness({ sends: 99, bounces: 4 });
    const froze = await service.recordOutcome("t1", "bounce");
    expect(froze).toBe(true);
    expect(teams.setStatus).toHaveBeenCalledWith("t1", "frozen");
    expect(alerts.publish).toHaveBeenCalledOnce();
    expect((alerts.publish as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/auto-frozen/);
  });

  it("freezes on a single complaint once past the 0.1% threshold", async () => {
    // 999 sends; one complaint = 1/1000 = 0.1% which is NOT > 0.1%, so 2 is needed.
    const { service, teams } = harness({ sends: 1000, complaints: 1 });
    expect(await service.recordOutcome("t1", "complaint")).toBe(true);
    expect(teams.setStatus).toHaveBeenCalledWith("t1", "frozen");
  });

  it("does not freeze below the minimum sample size", async () => {
    const { service, teams, alerts } = harness({ sends: 10, bounces: 5 });
    expect(await service.recordOutcome("t1", "bounce")).toBe(false);
    expect(teams.setStatus).not.toHaveBeenCalled();
    expect(alerts.publish).not.toHaveBeenCalled();
  });

  it("never re-freezes an already-frozen team (idempotent, respects re-enable)", async () => {
    const { service, teams, alerts } = harness({ sends: 200, bounces: 50 }, "frozen");
    expect(await service.recordOutcome("t1", "bounce")).toBe(false);
    expect(teams.setStatus).not.toHaveBeenCalled();
    expect(alerts.publish).not.toHaveBeenCalled();
  });
});
