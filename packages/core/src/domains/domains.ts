import type { DomainEntity } from "../adapters/dynamo-entities.js";
import type { EventsService } from "../events/emitter.js";
import type {
  Clock,
  DnsResolver,
  EmailProvider,
  IdGenerator,
  ProviderVerificationStatus,
} from "../ports.js";
import type { TeamsService } from "../teams/teams.js";
import { buildDomainRecords, type DomainRecord, domainStatus } from "./records.js";

export type DomainStatus = "not_started" | "pending" | "verified" | "failed" | "temporary_failure";

export interface Domain {
  domainId: string;
  teamId: string;
  name: string;
  region: string;
  status: DomainStatus;
  clickTracking: boolean;
  openTracking: boolean;
  tls: "opportunistic" | "enforced";
  inboundEnabled: boolean;
  dkimTokens: string[];
  signingHostedZone: string;
  configurationSetName: string;
  dkimStatus: string;
  mailFromStatus: string;
  /** DNS-observed state of the receiving MX (binary: PENDING/SUCCESS).
   * Absent on rows written before the field existed. */
  inboundMxStatus?: string;
  createdAt: string;
}

export class DomainAlreadyExistsError extends Error {}
export class UnsupportedRegionError extends Error {}

export interface DomainsServiceDeps {
  domains: DomainEntity;
  emitter: Pick<EventsService, "emit">;
  emailProvider: EmailProvider;
  teams: Pick<TeamsService, "getTeam">;
  /** The instance's SES region — the only region this instance can accept. */
  region: string;
  /** Resolves the receiving MX; optional so tests without DNS skip the check. */
  dns?: DnsResolver;
  clock: Clock;
  idGenerator: IdGenerator;
}

export class DomainsService {
  constructor(private readonly deps: DomainsServiceDeps) {}

  /**
   * SPEC §7: config set (with EventBridge destination) → identity (Easy DKIM
   * 2048, attached to the config set) → MAIL FROM send.<domain> → tenant
   * associations for both resources → persist as not_started. On any
   * failure everything created so far is rolled back best-effort.
   */
  async createDomain(input: {
    teamId: string;
    name: string;
    region?: string;
    clickTracking?: boolean;
    openTracking?: boolean;
  }): Promise<Domain> {
    const { domains, emailProvider, teams, clock, idGenerator } = this.deps;
    if (input.region !== undefined && input.region !== this.deps.region) {
      throw new UnsupportedRegionError(
        `This instance only supports the ${this.deps.region} region`,
      );
    }
    const name = input.name.toLowerCase();
    const existing = await domains.query.byName({ name }).go();
    if (existing.data.length > 0) {
      throw new DomainAlreadyExistsError(`domain ${name} already exists`);
    }
    const team = await teams.getTeam(input.teamId);
    // An authenticated principal implies a team; its absence is an invariant
    // breach, not a client error.
    if (!team) throw new Error(`team ${input.teamId} has no Team record`);

    const domainId = idGenerator();
    const configurationSetName = `domain-${domainId}`;
    const tracking = {
      clickTracking: input.clickTracking ?? false,
      openTracking: input.openTracking ?? false,
    };

    const rollback: Array<() => Promise<void>> = [];
    try {
      await emailProvider.createConfigurationSet(configurationSetName, tracking);
      rollback.push(() => emailProvider.deleteConfigurationSet(configurationSetName));

      const identity = await emailProvider.createDomainIdentity(name, configurationSetName);
      rollback.push(() => emailProvider.deleteDomainIdentity(name));

      await emailProvider.putMailFromAttributes(name, `send.${name}`);

      await emailProvider.associateTenantResource(
        team.sesTenantName,
        emailProvider.identityArn(name),
      );
      rollback.push(() =>
        emailProvider.disassociateTenantResource(
          team.sesTenantName,
          emailProvider.identityArn(name),
        ),
      );
      await emailProvider.associateTenantResource(
        team.sesTenantName,
        emailProvider.configurationSetArn(configurationSetName),
      );

      const domain: Domain = {
        domainId,
        teamId: input.teamId,
        name,
        region: this.deps.region,
        status: "not_started",
        ...tracking,
        tls: "opportunistic",
        inboundEnabled: false,
        dkimTokens: identity.dkimTokens,
        signingHostedZone: identity.signingHostedZone,
        configurationSetName,
        dkimStatus: "NOT_STARTED",
        mailFromStatus: "NOT_STARTED",
        inboundMxStatus: "PENDING",
        createdAt: clock().toISOString(),
      };
      await domains.create(domain).go();
      await this.deps.emitter.emit(input.teamId, {
        type: "domain.created",
        data: this.domainEventData(domain),
      });
      return domain;
    } catch (error) {
      for (const undo of rollback.reverse()) {
        await undo().catch(() => {
          // Best-effort rollback: names are deterministic, so a retried
          // create converges rather than leaking resources.
        });
      }
      throw error;
    }
  }

  /** DomainEventData (R02 §3.8): id, name, status, created_at, region, records. */
  private domainEventData(domain: Domain): Record<string, unknown> {
    return {
      id: domain.domainId,
      name: domain.name,
      status: domain.status,
      created_at: new Date(domain.createdAt).toISOString(),
      region: domain.region,
      records: this.recordsFor(domain),
    };
  }

  async getDomain(teamId: string, domainId: string): Promise<Domain | undefined> {
    const result = await this.deps.domains.get({ domainId }).go();
    const domain = result.data ?? undefined;
    return domain && domain.teamId === teamId ? domain : undefined;
  }

  async listDomains(teamId: string): Promise<Domain[]> {
    const result = await this.deps.domains.query.byTeam({ teamId }).go({ pages: "all" });
    return result.data.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  recordsFor(domain: Domain): DomainRecord[] {
    return buildDomainRecords({
      region: domain.region,
      dkimTokens: domain.dkimTokens,
      signingHostedZone: domain.signingHostedZone,
      dkimStatus: domain.dkimStatus as ProviderVerificationStatus,
      mailFromStatus: domain.mailFromStatus as ProviderVerificationStatus,
      inboundEnabled: domain.inboundEnabled,
      inboundMxStatus: domain.inboundMxStatus as ProviderVerificationStatus | undefined,
    });
  }

  /**
   * Observe the receiving MX in DNS (SES never reports it). Binary on
   * purpose: the record either resolves to this region's inbound host or it
   * doesn't yet — NXDOMAIN and lookup errors both read as still-pending.
   */
  private async checkInboundMx(domain: Domain): Promise<ProviderVerificationStatus | undefined> {
    const { dns } = this.deps;
    if (!dns || !domain.inboundEnabled) return undefined;
    const expected = `inbound-smtp.${domain.region}.amazonaws.com`;
    try {
      const exchanges = await dns.resolveMx(domain.name);
      const found = exchanges.some(
        (exchange) => exchange.toLowerCase().replace(/\.$/, "") === expected,
      );
      return found ? "SUCCESS" : "PENDING";
    } catch {
      return "PENDING";
    }
  }

  /** Toggle receiving (SPEC §9): flips the flag, capability, and the MX record.
   * Enabling also checks the MX immediately so the record's status is real
   * from the first render. */
  async setInboundEnabled(domain: Domain, inboundEnabled: boolean): Promise<Domain> {
    const inboundMxStatus = inboundEnabled
      ? await this.checkInboundMx({ ...domain, inboundEnabled })
      : undefined;
    await this.deps.domains
      .patch({ domainId: domain.domainId })
      .set({ inboundEnabled, ...(inboundMxStatus ? { inboundMxStatus } : {}) })
      .go();
    const updated: Domain = {
      ...domain,
      inboundEnabled,
      ...(inboundMxStatus ? { inboundMxStatus } : {}),
    };
    await this.deps.emitter.emit(domain.teamId, {
      type: "domain.updated",
      data: this.domainEventData(updated),
    });
    return updated;
  }

  async getDomainByName(name: string): Promise<Domain | undefined> {
    const result = await this.deps.domains.query.byName({ name: name.toLowerCase() }).go();
    return (result.data[0] as Domain | undefined) ?? undefined;
  }

  /** Re-check SES verification state (plus the receiving MX via DNS) and
   * persist the transition. */
  async refreshVerification(domain: Domain): Promise<Domain> {
    const verification = await this.deps.emailProvider.getDomainVerification(domain.name);
    if (!verification) return domain;
    const inboundMxStatus = (await this.checkInboundMx(domain)) ?? domain.inboundMxStatus;
    const nextStatus = domainStatus(verification.dkimStatus, verification.mailFromStatus);
    // SES reports NOT_STARTED until it first finds records; keep `pending`
    // sticky once a verify was requested so the UI doesn't regress.
    const status =
      nextStatus === "not_started" && domain.status !== "not_started" ? domain.status : nextStatus;
    const updated: Domain = {
      ...domain,
      status,
      dkimStatus: verification.dkimStatus,
      mailFromStatus: verification.mailFromStatus,
      ...(inboundMxStatus ? { inboundMxStatus } : {}),
    };
    await this.deps.domains
      .patch({ domainId: domain.domainId })
      .set({
        status: updated.status,
        dkimStatus: updated.dkimStatus,
        mailFromStatus: updated.mailFromStatus,
        ...(inboundMxStatus ? { inboundMxStatus } : {}),
      })
      .go();
    return updated;
  }

  /** POST /domains/:id/verify — kicks the async check (SPEC §5.8). */
  async requestVerification(domain: Domain): Promise<Domain> {
    const refreshed = await this.refreshVerification(domain);
    if (refreshed.status === "not_started") {
      await this.deps.domains.patch({ domainId: domain.domainId }).set({ status: "pending" }).go();
      return { ...refreshed, status: "pending" };
    }
    return refreshed;
  }

  /** Cron sweep: every non-terminal domain gets re-checked (SPEC §7). */
  async refreshAllPending(): Promise<number> {
    let refreshed = 0;
    for (const status of ["pending", "temporary_failure"] as const) {
      const result = await this.deps.domains.query.byStatus({ status }).go({ pages: "all" });
      for (const domain of result.data) {
        await this.refreshVerification(domain);
        refreshed += 1;
      }
    }
    return refreshed;
  }

  async updateDomain(
    domain: Domain,
    patch: { clickTracking?: boolean; openTracking?: boolean; tls?: "opportunistic" | "enforced" },
  ): Promise<Domain> {
    const updated: Domain = {
      ...domain,
      clickTracking: patch.clickTracking ?? domain.clickTracking,
      openTracking: patch.openTracking ?? domain.openTracking,
      tls: patch.tls ?? domain.tls,
    };
    if (
      updated.clickTracking !== domain.clickTracking ||
      updated.openTracking !== domain.openTracking
    ) {
      await this.deps.emailProvider.updateConfigurationSetTracking(domain.configurationSetName, {
        clickTracking: updated.clickTracking,
        openTracking: updated.openTracking,
      });
    }
    await this.deps.domains
      .patch({ domainId: domain.domainId })
      .set({
        clickTracking: updated.clickTracking,
        openTracking: updated.openTracking,
        tls: updated.tls,
      })
      .go();
    await this.deps.emitter.emit(domain.teamId, {
      type: "domain.updated",
      data: this.domainEventData(updated),
    });
    return updated;
  }

  /**
   * DELETE order matters: tenant resource associations FIRST (they block
   * identity deletion, R03 §1.2), then identity, then config set, then the
   * record — a hard delete (SPEC §5.15).
   */
  async deleteDomain(domain: Domain): Promise<void> {
    const { emailProvider, teams, domains } = this.deps;
    const team = await teams.getTeam(domain.teamId);
    if (team) {
      await emailProvider.disassociateTenantResource(
        team.sesTenantName,
        emailProvider.identityArn(domain.name),
      );
      await emailProvider.disassociateTenantResource(
        team.sesTenantName,
        emailProvider.configurationSetArn(domain.configurationSetName),
      );
    }
    await emailProvider.deleteDomainIdentity(domain.name);
    await emailProvider.deleteConfigurationSet(domain.configurationSetName);
    await domains.delete({ domainId: domain.domainId }).go();
    await this.deps.emitter.emit(domain.teamId, {
      type: "domain.deleted",
      data: this.domainEventData(domain),
    });
  }
}
