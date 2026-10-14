import type { ReputationCounters, ReputationWindow } from "../adapters/reputation-counters.js";
import type { AlertPublisher } from "../ports.js";
import type { TeamsService } from "../teams/teams.js";

/** Reputation auto-freeze thresholds (mirrors instance.config `guardrails`). */
export interface GuardrailsConfig {
  bounceRateThreshold: number;
  complaintRateThreshold: number;
  minSampleSize: number;
}

/**
 * Reputation guardrails (SPEC §12): tracks per-team send/bounce/complaint
 * counts per recipient (like SES does) and auto-freezes a team whose rolling bounce or complaint rate
 * breaches the configured thresholds, alerting the operator. Freezing only
 * ever transitions an `active` team, so a manual operator re-enable is not
 * immediately undone by a redelivered event, and an already-frozen team never
 * re-alerts.
 */

export interface ReputationServiceDeps {
  counters: Pick<
    ReputationCounters,
    "recordSends" | "recordBounce" | "recordComplaint" | "current"
  >;
  teams: Pick<TeamsService, "getTeam" | "setStatus">;
  alerts: AlertPublisher;
  config: GuardrailsConfig;
}

type Outcome = "bounce" | "complaint";

export class ReputationService {
  constructor(private readonly deps: ReputationServiceDeps) {}

  /** Count accepted recipients into the reputation window (called on the send path). */
  recordSends(teamId: string, recipients: number): Promise<void> {
    return this.deps.counters.recordSends(teamId, recipients);
  }

  /**
   * Record a hard bounce or complaint affecting `recipients` recipients and, if
   * it pushes the team over a threshold, freeze the team and alert. Returns
   * whether the team was frozen by this call.
   */
  async recordOutcome(teamId: string, outcome: Outcome, recipients = 1): Promise<boolean> {
    if (outcome === "bounce") await this.deps.counters.recordBounce(teamId, recipients);
    else await this.deps.counters.recordComplaint(teamId, recipients);

    const window = await this.deps.counters.current(teamId);
    const breach = this.breach(window);
    if (!breach) return false;

    // Only freeze a currently-active team (idempotent; respects a manual re-enable).
    const team = await this.deps.teams.getTeam(teamId);
    if (!team || team.status !== "active") return false;

    await this.deps.teams.setStatus(teamId, "frozen");
    await this.deps.alerts.publish(
      `Team ${teamId} auto-frozen (${breach.kind} rate ${(breach.rate * 100).toFixed(2)}%)`,
      [
        `Team ${teamId} ("${team.name}") was automatically frozen.`,
        `Reason: ${breach.kind} rate ${(breach.rate * 100).toFixed(2)}% exceeded the ` +
          `${(breach.threshold * 100).toFixed(2)}% threshold.`,
        `Window: ${window.sends} recipients, ${window.bounces} hard bounces, ${window.complaints} complaints.`,
        "Investigate the sending list quality before re-enabling the team.",
      ].join("\n"),
    );
    return true;
  }

  private breach(
    window: ReputationWindow,
  ): { kind: Outcome; rate: number; threshold: number } | undefined {
    if (window.sends < this.deps.config.minSampleSize) return undefined;
    const complaintRate = window.complaints / window.sends;
    if (complaintRate > this.deps.config.complaintRateThreshold) {
      return {
        kind: "complaint",
        rate: complaintRate,
        threshold: this.deps.config.complaintRateThreshold,
      };
    }
    const bounceRate = window.bounces / window.sends;
    if (bounceRate > this.deps.config.bounceRateThreshold) {
      return { kind: "bounce", rate: bounceRate, threshold: this.deps.config.bounceRateThreshold };
    }
    return undefined;
  }
}
