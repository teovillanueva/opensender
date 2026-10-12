import type { TeamEntity } from "../adapters/dynamo-entities.js";
import type { Clock, EmailProvider } from "../ports.js";

export interface PlanConfig {
  dailyEmailLimit: number;
  apiRateLimitPerSecond: number;
}

export interface TeamsConfig {
  plans: Record<string, PlanConfig>;
  defaultPlan: string;
}

export interface Team {
  teamId: string;
  name: string;
  sesTenantName: string;
  plan: string;
  status: "active" | "frozen";
  createdAt: string;
}

class TeamAlreadyExistsError extends Error {}
class UnknownPlanError extends Error {}

/** SES tenant names: ≤64 chars of [a-zA-Z0-9_-] (SPEC §6.3). */
export function tenantNameForTeam(teamId: string): string {
  return `team-${teamId}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
}

export interface TeamsServiceDeps {
  teams: TeamEntity;
  emailProvider: EmailProvider;
  config: TeamsConfig;
  clock: Clock;
}

export class TeamsService {
  constructor(private readonly deps: TeamsServiceDeps) {}

  /**
   * Creates the SES tenant first, then persists the Team; if the persist
   * fails the tenant is deleted best-effort. Retrying with the same teamId
   * is safe: the tenant name is deterministic and AlreadyExists on the
   * tenant is treated as ours.
   */
  async createTeam(input: { teamId: string; name: string; plan?: string }): Promise<Team> {
    const { teams, emailProvider, config, clock } = this.deps;
    const plan = input.plan ?? config.defaultPlan;
    if (!(plan in config.plans)) {
      throw new UnknownPlanError(`unknown plan "${plan}"`);
    }

    const existing = await this.getTeam(input.teamId);
    if (existing) {
      throw new TeamAlreadyExistsError(`team ${input.teamId} already exists`);
    }

    const sesTenantName = tenantNameForTeam(input.teamId);
    await emailProvider.createTenant(sesTenantName);

    const team: Team = {
      teamId: input.teamId,
      name: input.name,
      sesTenantName,
      plan,
      status: "active",
      createdAt: clock().toISOString(),
    };
    try {
      await teams.create(team).go();
    } catch (error) {
      await emailProvider.deleteTenant(sesTenantName).catch(() => {
        // Rollback is best-effort; the deterministic tenant name makes a
        // retry of createTeam converge instead of leaking tenants.
      });
      throw error;
    }
    return team;
  }

  async getTeam(teamId: string): Promise<Team | undefined> {
    const result = await this.deps.teams.get({ teamId }).go();
    return result.data ?? undefined;
  }

  /** Keep the Team record's name in sync with the better-auth organization
   * (renames happen through the org surface; usage/metrics read this record). */
  async updateName(teamId: string, name: string): Promise<void> {
    await this.deps.teams.patch({ teamId }).set({ name }).go();
  }

  /** Freeze/unfreeze a team (SPEC §12). Returns the updated Team. */
  async setStatus(teamId: string, status: Team["status"]): Promise<Team> {
    await this.deps.teams.patch({ teamId }).set({ status }).go();
    const team = await this.getTeam(teamId);
    if (!team) throw new Error(`team ${teamId} not found`);
    return team;
  }

  /**
   * Resolve the Team owning an SES tenant, given the tenant name from a
   * sending-status event. `tenantNameForTeam` prefixes the teamId with
   * `team-` and only rewrites characters outside [a-zA-Z0-9_-]; better-auth
   * org ids are already in that set, so the teamId is recoverable by stripping
   * the prefix. The get is confirmed against `sesTenantName` so a collision or
   * a sanitized id never freezes the wrong team.
   */
  async getTeamByTenantName(tenantName: string): Promise<Team | undefined> {
    const teamId = tenantName.startsWith("team-") ? tenantName.slice("team-".length) : tenantName;
    const team = await this.getTeam(teamId);
    return team && team.sesTenantName === tenantName ? team : undefined;
  }

  quotasFor(team: Team): PlanConfig {
    const plan = this.deps.config.plans[team.plan];
    // A team whose plan vanished from config falls back to the default plan
    // rather than failing every request.
    return plan ?? (this.deps.config.plans[this.deps.config.defaultPlan] as PlanConfig);
  }
}
