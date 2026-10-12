import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createApiKeyEntity,
  createDomainEntity,
  createEmailEntity,
  createEmailEventEntity,
  createSuppressionEntity,
  createTeamEntity,
  createWebhookDeliveryEntity,
  createWebhookEndpointEntity,
} from "../src/adapters/dynamo-entities.js";
import { IdempotencyStore } from "../src/adapters/idempotency-store.js";
import { QuotaCounters } from "../src/adapters/quota-counters.js";
import { RateLimiter } from "../src/adapters/rate-limiter.js";
import { ApiKeysService } from "../src/api-keys/api-keys.js";
import { createAuth } from "../src/auth/auth.js";
import {
  BootstrapService,
  BootstrapTokenMismatchError,
  BootstrapUnavailableError,
} from "../src/auth/bootstrap.js";
import { createOAuthGrants } from "../src/auth/oauth-grants.js";
import { createOAuthTokenVerifier } from "../src/auth/oauth-verifier.js";
import { DomainsService } from "../src/domains/domains.js";
import { EmailsService, outboundEmailEventData, type StoredEmail } from "../src/emails/emails.js";
import { validateSendRequest } from "../src/emails/validate.js";
import { EventsService } from "../src/events/emitter.js";
import { EventProcessorService } from "../src/events/processor.js";
import { TeamsService, tenantNameForTeam } from "../src/teams/teams.js";
import { WebhookDispatchService } from "../src/webhooks/dispatcher.js";
import { WebhooksService } from "../src/webhooks/webhooks.js";
import { type LocalDynamo, startLocalDynamo } from "./helpers/ddb-local.js";
import {
  FakeBlobStore,
  FakeEmailProvider,
  FakeQueuePublisher,
  FakeScheduler,
} from "./helpers/fake-email-provider.js";

let dynamo: LocalDynamo;

beforeAll(async () => {
  dynamo = await startLocalDynamo();
}, 120_000);

afterAll(async () => {
  await dynamo.stop();
});

const PLANS = {
  default: { dailyEmailLimit: 1_000, apiRateLimitPerSecond: 10 },
  internal: { dailyEmailLimit: 50_000, apiRateLimitPerSecond: 10 },
};

function makeTeamsService(provider: FakeEmailProvider) {
  return new TeamsService({
    teams: createTeamEntity({ client: dynamo.client, table: dynamo.table }),
    emailProvider: provider,
    config: { plans: PLANS, defaultPlan: "default" },
    clock: () => new Date("2026-08-09T10:00:00.000Z"),
  });
}

let emitterSeq = 0;
function makeEmitter(queue = new FakeQueuePublisher()) {
  const webhooks = new WebhooksService({
    endpoints: createWebhookEndpointEntity({ client: dynamo.client, table: dynamo.table }),
    clock: () => new Date("2026-08-09T12:00:00.000Z"),
    idGenerator: () => `wh-${++emitterSeq}-${Math.random().toString(36).slice(2, 8)}`,
  });
  const emitter = new EventsService({
    events: createEmailEventEntity({ client: dynamo.client, table: dynamo.table }),
    webhooks,
    deliveries: queue,
    clock: () => new Date("2026-08-09T12:00:00.000Z"),
    idGenerator: () => `ev-${++emitterSeq}-${Math.random().toString(36).slice(2, 8)}`,
  });
  return { emitter, webhooks, queue };
}

describe("teams service", () => {
  it("creates the tenant and the team record, resolving quotas from the plan", async () => {
    const provider = new FakeEmailProvider();
    const teams = makeTeamsService(provider);
    const team = await teams.createTeam({ teamId: "team-a", name: "Team A" });

    expect(team.sesTenantName).toBe(tenantNameForTeam("team-a"));
    expect(provider.tenants.has(team.sesTenantName)).toBe(true);
    expect(team.plan).toBe("default");
    expect(teams.quotasFor(team)).toEqual(PLANS.default);
    expect(await teams.getTeam("team-a")).toMatchObject({ name: "Team A", status: "active" });
  });

  it("sanitizes tenant names to SES constraints", () => {
    expect(tenantNameForTeam("weird id!@#")).toBe("team-weird-id---");
    expect(tenantNameForTeam("x".repeat(100))).toHaveLength(64);
  });

  it("rejects duplicate teams and unknown plans", async () => {
    const provider = new FakeEmailProvider();
    const teams = makeTeamsService(provider);
    await teams.createTeam({ teamId: "team-dup", name: "Dup" });
    await expect(teams.createTeam({ teamId: "team-dup", name: "Dup" })).rejects.toThrow(
      /already exists/,
    );
    await expect(teams.createTeam({ teamId: "team-p", name: "P", plan: "nope" })).rejects.toThrow(
      /unknown plan/,
    );
  });

  it("freezes and unfreezes a team, and resolves a team by its SES tenant name", async () => {
    const provider = new FakeEmailProvider();
    const teams = makeTeamsService(provider);
    const team = await teams.createTeam({ teamId: "team-frz", name: "Frz" });

    const frozen = await teams.setStatus("team-frz", "frozen");
    expect(frozen.status).toBe("frozen");
    expect((await teams.getTeam("team-frz"))?.status).toBe("frozen");

    // A tenant-status event carries only the tenant name; it must resolve back
    // to this exact team, confirmed against sesTenantName.
    const resolved = await teams.getTeamByTenantName(team.sesTenantName);
    expect(resolved?.teamId).toBe("team-frz");
    expect(await teams.getTeamByTenantName("team-does-not-exist")).toBeUndefined();

    expect((await teams.setStatus("team-frz", "active")).status).toBe("active");
  });
});

describe("api keys service", () => {
  function makeService() {
    let n = 0;
    return new ApiKeysService({
      apiKeys: createApiKeyEntity({ client: dynamo.client, table: dynamo.table }),
      clock: () => new Date(Date.UTC(2026, 7, 9, 10, 0, n)),
      idGenerator: () => `key-${++n}-${Math.random().toString(36).slice(2, 10)}`,
    });
  }

  it("creates a key whose token verifies to the same team and permission", async () => {
    const service = makeService();
    const { key, token } = await service.createKey({
      teamId: "team-k",
      name: "prod",
      permission: "full_access",
    });
    expect(token).toMatch(/^re_[A-Za-z0-9]{32}$/);

    const verified = await service.verifyToken(token);
    expect(verified).toMatchObject({
      keyId: key.keyId,
      teamId: "team-k",
      permission: "full_access",
    });
  });

  it("rejects unknown and malformed tokens", async () => {
    const service = makeService();
    expect(await service.verifyToken("re_00000000000000000000000000000000")).toBeUndefined();
    expect(await service.verifyToken("not-a-token")).toBeUndefined();
  });

  it("lists team keys without the hash and deletes only own keys", async () => {
    const service = makeService();
    const { key } = await service.createKey({
      teamId: "team-l",
      name: "one",
      permission: "sending_access",
    });
    const listed = await service.listKeys("team-l");
    expect(listed.some((item) => item.keyId === key.keyId)).toBe(true);
    expect(listed[0]).not.toHaveProperty("tokenHash");

    expect(await service.deleteKey("other-team", key.keyId)).toBe(false);
    expect(await service.deleteKey("team-l", key.keyId)).toBe(true);
    expect(await service.deleteKey("team-l", key.keyId)).toBe(false);
  });
});

describe("rate limiter", () => {
  it("admits exactly `limit` requests per window, atomically under concurrency", async () => {
    const frozenNow = new Date("2026-08-09T10:30:00.500Z");
    const limiter = new RateLimiter({
      client: dynamo.client,
      table: dynamo.table,
      clock: () => frozenNow,
    });

    const decisions = await Promise.all(
      Array.from({ length: 11 }, () => limiter.consume("team-rl", 10)),
    );
    const rejected = decisions.filter((decision) => !decision.allowed);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ limit: 10, remaining: 0, resetSeconds: 1 });
  });

  it("opens a fresh window the next second", async () => {
    let now = new Date("2026-08-09T10:31:00.000Z");
    const limiter = new RateLimiter({
      client: dynamo.client,
      table: dynamo.table,
      clock: () => now,
    });
    for (let i = 0; i < 10; i++) await limiter.consume("team-rl2", 10);
    expect((await limiter.consume("team-rl2", 10)).allowed).toBe(false);

    now = new Date("2026-08-09T10:31:01.000Z");
    const fresh = await limiter.consume("team-rl2", 10);
    expect(fresh).toMatchObject({ allowed: true, remaining: 9 });
  });
});

describe("domains service", () => {
  let uniqueId = 0;
  async function makeDomainsService(
    provider: FakeEmailProvider,
    idGenerator: () => string = () =>
      `00000000-0000-4000-8000-${String(++uniqueId).padStart(12, "0")}`,
  ) {
    const teams = makeTeamsService(provider);
    try {
      await teams.createTeam({ teamId: "team-dom", name: "Dom" });
    } catch {
      // already created by an earlier test in this block
    }
    return new DomainsService({
      domains: createDomainEntity({ client: dynamo.client, table: dynamo.table }),
      emitter: makeEmitter().emitter,
      emailProvider: provider,
      teams,
      region: "us-east-1",
      clock: () => new Date("2026-08-09T12:00:00.000Z"),
      idGenerator,
    });
  }

  it("orchestrates config set, identity, MAIL FROM, and tenant associations", async () => {
    const provider = new FakeEmailProvider();
    const domains = await makeDomainsService(provider);
    const domain = await domains.createDomain({ teamId: "team-dom", name: "Example.COM" });

    expect(domain.name).toBe("example.com");
    expect(domain.status).toBe("not_started");
    expect(provider.configurationSets.has(domain.configurationSetName)).toBe(true);
    expect(provider.identities.get("example.com")).toMatchObject({
      configurationSetName: domain.configurationSetName,
      mailFrom: "send.example.com",
    });
    const tenant = "team-team-dom";
    expect(provider.associations.has(`${tenant}|arn:fake:identity/example.com`)).toBe(true);
    expect(
      provider.associations.has(
        `${tenant}|arn:fake:configuration-set/${domain.configurationSetName}`,
      ),
    ).toBe(true);

    await expect(domains.createDomain({ teamId: "team-dom", name: "example.com" })).rejects.toThrow(
      /already exists/,
    );
    await expect(
      domains.createDomain({ teamId: "team-dom", name: "other.com", region: "eu-west-1" }),
    ).rejects.toThrow(/only supports/);
  });

  it("tracks verification through pending to verified and hard-deletes cleanly", async () => {
    const provider = new FakeEmailProvider();
    const domains = await makeDomainsService(provider);
    const created = await domains.createDomain({ teamId: "team-dom", name: "verify.me" });

    const pending = await domains.requestVerification(created);
    expect(pending.status).toBe("pending");

    provider.verificationState = { dkimStatus: "SUCCESS", mailFromStatus: "SUCCESS" };
    const verified = await domains.refreshVerification(pending);
    expect(verified.status).toBe("verified");
    expect(
      domains.recordsFor(verified).every((r) => r.record === "DMARC" || r.status === "verified"),
    ).toBe(true);

    await domains.deleteDomain(verified);
    expect(provider.identities.has("verify.me")).toBe(false);
    expect(provider.configurationSets.has(created.configurationSetName)).toBe(false);
    expect([...provider.associations].filter((a) => a.includes("verify.me"))).toHaveLength(0);
    expect(await domains.getDomain("team-dom", created.domainId)).toBeUndefined();

    // Recreating the same name proves clean teardown.
    const again = await domains.createDomain({ teamId: "team-dom", name: "verify.me" });
    expect(again.name).toBe("verify.me");
  });

  it("rolls back provider resources when persistence fails", async () => {
    const provider = new FakeEmailProvider();
    const domains = await makeDomainsService(provider);
    const first = await domains.createDomain({ teamId: "team-dom", name: "dup-target.com" });
    // A colliding id makes the DynamoDB create() fail after the provider
    // resources exist — the rollback must remove them.
    const colliding = await makeDomainsService(provider, () => first.domainId);
    await expect(
      colliding.createDomain({ teamId: "team-dom", name: "rollback.me" }),
    ).rejects.toThrow();
    // The new domain's provider resources are gone; the existing domain's
    // identity is untouched. (The config set is shared in this artificial
    // id-collision setup, so it is not asserted.)
    expect(provider.identities.has("rollback.me")).toBe(false);
    expect(provider.identities.has("dup-target.com")).toBe(true);
  });
});

describe("emails pipeline", () => {
  let n = 0;
  const nextId = () => `10000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

  const scheduler = new FakeScheduler();
  async function makeEmailsService(provider: FakeEmailProvider, blobs = new FakeBlobStore()) {
    const teams = makeTeamsService(provider);
    try {
      await teams.createTeam({ teamId: "team-em", name: "Em" });
    } catch {
      // already created
    }
    const domainEntity = createDomainEntity({ client: dynamo.client, table: dynamo.table });
    const domainsService = new DomainsService({
      domains: domainEntity,
      emitter: makeEmitter().emitter,
      emailProvider: provider,
      teams,
      region: "us-east-1",
      clock: () => new Date("2026-08-09T12:00:00.000Z"),
      idGenerator: nextId,
    });
    let domain = (await domainsService.listDomains("team-em")).find(
      (entry) => entry.name === "send.example",
    );
    if (!domain) {
      domain = await domainsService.createDomain({ teamId: "team-em", name: "send.example" });
    }
    provider.verificationState = { dkimStatus: "SUCCESS", mailFromStatus: "SUCCESS" };
    await domainsService.refreshVerification(domain);

    const emails = new EmailsService({
      emails: createEmailEntity({ client: dynamo.client, table: dynamo.table }),
      emitter: makeEmitter().emitter,
      suppressions: createSuppressionEntity({ client: dynamo.client, table: dynamo.table }),
      quotas: new QuotaCounters({
        client: dynamo.client,
        table: dynamo.table,
        clock: () => new Date("2026-08-09T12:00:00.000Z"),
      }),
      blobs,
      emailProvider: provider,
      teams,
      domains: domainsService,
      scheduler,
      clock: () => new Date("2026-08-09T12:00:00.000Z"),
      idGenerator: nextId,
    });
    return { emails, provider, blobs, scheduler, domainId: domain.domainId };
  }

  const request = (over: Record<string, unknown> = {}) =>
    validateSendRequest({
      from: "hello@send.example",
      to: ["dest@other.example"],
      subject: "s",
      html: "<p>x</p>",
      ...over,
    });

  it("sends via the tenant with internal tags and records the sent event", async () => {
    const { emails, provider } = await makeEmailsService(new FakeEmailProvider());
    const { email, usage } = await emails.send("team-em", request(), { enforceSync: true });

    expect(email.status).toBe("sent");
    expect(email.messageId).toMatch(/^<ses-msg-\d+@email\.amazonses\.com>$/);
    const sent = provider.sentMessages.at(-1);
    expect(sent?.tenantName).toBe("team-team-em");
    expect(sent?.configurationSetName).toMatch(/^domain-/);
    expect(sent?.tags.email_id).toBe(email.emailId);
    expect(usage.daily).toBeGreaterThanOrEqual(1);

    const fetched = await emails.getEmail("team-em", email.emailId);
    expect(fetched?.status).toBe("sent");
  });

  it("enforces an OAuth grant's domain restriction on the from domain", async () => {
    const { emails, domainId } = await makeEmailsService(new FakeEmailProvider());

    // Restriction naming another domain: rejected like a restricted key.
    await expect(
      emails.send("team-em", request(), {
        enforceSync: true,
        allowedDomainIds: ["some-other-domain-id"],
      }),
    ).rejects.toMatchObject({ statusCode: 401, errorName: "restricted_api_key" });

    // Restriction naming the resolved domain: sends normally.
    const { email } = await emails.send("team-em", request(), {
      enforceSync: true,
      allowedDomainIds: [domainId],
    });
    expect(email.status).toBe("sent");
  });

  it("is idempotent on a deterministic emailId — a redelivered page never re-sends", async () => {
    const { emails, provider } = await makeEmailsService(new FakeEmailProvider());
    const fixedId = "det-broadcast-recipient-id";
    const before = provider.sentMessages.length;

    const first = await emails.send("team-em", request(), { enforceSync: false, emailId: fixedId });
    const second = await emails.send("team-em", request(), {
      enforceSync: false,
      emailId: fixedId,
    });

    expect(first.email.emailId).toBe(fixedId);
    expect(first.deduped).toBeFalsy();
    expect(second.email.emailId).toBe(fixedId);
    expect(second.deduped).toBe(true);
    // Exactly one real SES send despite two send() calls with the same id.
    expect(provider.sentMessages.length).toBe(before + 1);
  });

  it("caps the body size before the provider call and never explodes persist", async () => {
    const { emails, provider } = await makeEmailsService(new FakeEmailProvider());
    const before = provider.sentMessages.length;
    const huge = request({ html: `<p>${"x".repeat(300 * 1024)}</p>` });

    await expect(emails.send("team-em", huge, { enforceSync: true })).rejects.toMatchObject({
      statusCode: 422,
      errorName: "validation_error",
    });
    // Rejected before SES — nothing went out.
    expect(provider.sentMessages.length).toBe(before);

    // In batch mode it is recorded failed with the oversized body stripped, so
    // the DynamoDB create stays under the item limit.
    const { email } = await emails.send("team-em", huge, { enforceSync: false });
    expect(email.status).toBe("failed");
    const fetched = await emails.getEmail("team-em", email.emailId);
    expect(fetched?.html).not.toContain("xxxxxxxxxx");
  });

  it("rejects unverified from-domains synchronously, accepts+fails in batch mode", async () => {
    const { emails } = await makeEmailsService(new FakeEmailProvider());
    const bad = request({ from: "x@unverified.example" });

    await expect(emails.send("team-em", bad, { enforceSync: true })).rejects.toMatchObject({
      statusCode: 403,
      errorName: "validation_error",
    });

    const { email } = await emails.send("team-em", bad, { enforceSync: false });
    expect(email.status).toBe("failed");
  });

  it("rejects sends from a frozen team with a clear error (SPEC §12)", async () => {
    const { emails } = await makeEmailsService(new FakeEmailProvider());
    const teams = makeTeamsService(new FakeEmailProvider());
    await teams.setStatus("team-em", "frozen");

    await expect(emails.send("team-em", request(), { enforceSync: true })).rejects.toMatchObject({
      statusCode: 403,
      errorName: "restricted",
    });
    // Batch mode records the item failed rather than rejecting the request.
    const { email } = await emails.send("team-em", request(), { enforceSync: false });
    expect(email.status).toBe("failed");

    await teams.setStatus("team-em", "active");
    expect((await emails.send("team-em", request(), { enforceSync: true })).email.status).toBe(
      "sent",
    );
  });

  it("blocks suppressed recipients", async () => {
    const { emails } = await makeEmailsService(new FakeEmailProvider());
    await createSuppressionEntity({ client: dynamo.client, table: dynamo.table })
      .create({
        teamId: "team-em",
        email: "blocked@other.example",
        reason: "hard_bounce",
        createdAt: "2026-08-09T00:00:00.000Z",
      })
      .go();
    await expect(
      emails.send("team-em", request({ to: ["blocked@other.example"] }), { enforceSync: true }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("schedules, reschedules, fires, and cancels through the scheduler port", async () => {
    const provider = new FakeEmailProvider();
    const { emails, scheduler: fakeScheduler } = await makeEmailsService(provider);
    const before = provider.sentMessages.length;
    const { email } = await emails.send(
      "team-em",
      request({ scheduled_at: "2026-08-10T09:00:00.000Z" }),
      { enforceSync: true },
    );
    expect(email.status).toBe("scheduled");
    expect(provider.sentMessages.length).toBe(before);
    const scheduleName = `email-${email.emailId}`;
    expect(fakeScheduler.schedules.get(scheduleName)?.at.toISOString()).toBe(
      "2026-08-10T09:00:00.000Z",
    );

    await emails.updateScheduledAt(email, "2026-08-11T09:00:00.000Z");
    expect(fakeScheduler.schedules.get(scheduleName)?.at.toISOString()).toBe(
      "2026-08-11T09:00:00.000Z",
    );

    // Fire it: the pipeline sends and transitions scheduled -> sent.
    expect(await emails.sendScheduled(email.emailId)).toBe("sent");
    expect(provider.sentMessages.length).toBe(before + 1);
    expect((await emails.getEmail("team-em", email.emailId))?.status).toBe("sent");
    // Refire is a no-op.
    expect(await emails.sendScheduled(email.emailId)).toBe("skipped");

    // A second scheduled email cancels cleanly.
    const { email: second } = await emails.send(
      "team-em",
      request({ scheduled_at: "2026-08-10T10:00:00.000Z" }),
      { enforceSync: true },
    );
    await emails.cancel(second);
    expect(fakeScheduler.schedules.has(`email-${second.emailId}`)).toBe(false);
    expect((await emails.getEmail("team-em", second.emailId))?.status).toBe("canceled");
    await expect(emails.cancel({ ...second, status: "canceled" })).rejects.toMatchObject({
      statusCode: 422,
    });
    await expect(
      emails.updateScheduledAt({ ...second, status: "canceled" }, "2026-08-12T09:00:00.000Z"),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("stores attachment blobs and lists them with size metadata", async () => {
    const blobs = new FakeBlobStore();
    const { emails } = await makeEmailsService(new FakeEmailProvider(), blobs);
    const { email } = await emails.send(
      "team-em",
      request({
        attachments: [{ filename: "hi.txt", content: Buffer.from("hello!").toString("base64") }],
      }),
      { enforceSync: true },
    );
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments?.[0]).toMatchObject({ filename: "hi.txt", sizeBytes: 6 });
    expect(blobs.blobs.size).toBe(1);
  });

  it("sends content_id attachments as inline parts and derives missing content types", async () => {
    const { emails, provider } = await makeEmailsService(new FakeEmailProvider());
    const png = Buffer.from("png-bytes").toString("base64");
    const { email } = await emails.send(
      "team-em",
      request({
        html: '<img src="cid:ic_cub">',
        attachments: [
          { filename: "cub.png", content: png, content_id: "ic_cub", content_type: "image/png" },
          { filename: "rank-4.png", content: png },
        ],
      }),
      { enforceSync: true },
    );
    expect(email.attachments?.[0]).toMatchObject({ contentId: "ic_cub", contentType: "image/png" });
    expect(email.attachments?.[1]).toMatchObject({ contentType: "image/png" });
    expect(email.attachments?.[1]?.contentId).toBeUndefined();

    const sent = provider.sentMessages.at(-1);
    if (sent?.content.kind !== "raw") expect.unreachable("expected raw MIME");
    const mime = Buffer.from(sent.content.mime).toString();
    expect(mime).toContain("Content-ID: <ic_cub>");
    expect(mime).toContain("Content-Disposition: inline; filename=cub.png");
    expect(mime).toContain("Content-Disposition: attachment; filename=rank-4.png");
  });

  it("persists request tags and echoes them on webhook event data", async () => {
    const { emails, provider } = await makeEmailsService(new FakeEmailProvider());
    const { email } = await emails.send(
      "team-em",
      request({ tags: [{ name: "ref", value: "CDM-261009-HN55" }] }),
      { enforceSync: true },
    );
    expect(provider.sentMessages.at(-1)?.tags.ref).toBe("CDM-261009-HN55");
    const stored = await emails.getEmail("team-em", email.emailId);
    expect(stored?.tags).toEqual([{ name: "ref", value: "CDM-261009-HN55" }]);
    expect(outboundEmailEventData(stored as StoredEmail).tags).toEqual({
      ref: "CDM-261009-HN55",
    });
  });

  it("pages GET /emails by after/before email id without repeats or gaps", async () => {
    const { emails } = await makeEmailsService(new FakeEmailProvider());
    // Same fixed clock ⇒ every createdAt ties; the emailId tiebreak must hold.
    for (let i = 0; i < 5; i++) {
      await emails.send("team-em", request({ subject: `page ${i}` }), { enforceSync: true });
    }
    const everything = await emails.listEmailsByCursor("team-em", 100);
    const allIds = everything?.emails.map((email) => email.emailId) ?? [];
    expect(allIds.length).toBeGreaterThanOrEqual(5);
    expect(everything?.hasMore).toBe(false);

    const walked: string[] = [];
    let page = await emails.listEmailsByCursor("team-em", 2);
    const pages = [page];
    while (page) {
      walked.push(...page.emails.map((email) => email.emailId));
      if (!page.hasMore) break;
      page = await emails.listEmailsByCursor("team-em", 2, { after: walked.at(-1) });
      pages.push(page);
    }
    expect(walked).toEqual(allIds);
    expect(pages.every((entry) => (entry?.emails.length ?? 0) <= 2)).toBe(true);

    const previous = await emails.listEmailsByCursor("team-em", 2, { before: allIds[2] });
    expect(previous?.emails.map((email) => email.emailId)).toEqual(allIds.slice(0, 2));
    expect(previous?.hasMore).toBe(false);

    expect(
      await emails.listEmailsByCursor("team-em", 2, {
        after: "99999999-0000-4000-8000-000000000000",
      }),
    ).toBeUndefined();
  });
});

describe("idempotency store", () => {
  it("claims once, replays completed responses, releases on error", async () => {
    const store = new IdempotencyStore({
      client: dynamo.client,
      table: dynamo.table,
      clock: () => new Date("2026-08-09T12:00:00.000Z"),
    });

    expect(await store.claim("t", "POST /emails", "k1", "hash-a")).toEqual({ kind: "claimed" });
    expect(await store.claim("t", "POST /emails", "k1", "hash-a")).toEqual({ kind: "in_flight" });
    expect(await store.claim("t", "POST /emails", "k1", "hash-b")).toEqual({ kind: "mismatch" });

    await store.complete("t", "POST /emails", "k1", { status: 200, body: '{"id":"x"}' });
    expect(await store.claim("t", "POST /emails", "k1", "hash-a")).toEqual({
      kind: "replay",
      response: { status: 200, body: '{"id":"x"}' },
    });

    await store.release("t", "POST /emails", "k1");
    expect(await store.claim("t", "POST /emails", "k1", "hash-a")).toEqual({ kind: "claimed" });
  });

  it("admits exactly one concurrent claim", async () => {
    const store = new IdempotencyStore({
      client: dynamo.client,
      table: dynamo.table,
      clock: () => new Date("2026-08-09T12:00:00.000Z"),
    });
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => store.claim("t", "POST /emails", "k-conc", "h")),
    );
    expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
  });
});

describe("event processor + webhook fan-out", () => {
  it("processes a bounce end to end: status, timeline, suppression, fan-out, dedup", async () => {
    const provider = new FakeEmailProvider();
    const queue = new FakeQueuePublisher();
    const { emitter, webhooks } = makeEmitter(queue);
    const teams = makeTeamsService(provider);
    try {
      await teams.createTeam({ teamId: "team-ev", name: "Ev" });
    } catch {
      // exists
    }

    // A sent email to bounce.
    const emailEntity = createEmailEntity({ client: dynamo.client, table: dynamo.table });
    await emailEntity
      .create({
        emailId: "20000000-0000-4000-8000-000000000001",
        teamId: "team-ev",
        direction: "outbound",
        from: "hello@ev.example",
        to: ["gone@example.com"],
        subject: "s",
        status: "sent",
        sesMessageId: "ses-bounce-1",
        createdAt: "2026-08-09T12:00:00.000Z",
      })
      .go();

    const endpoint = await webhooks.createEndpoint({
      teamId: "team-ev",
      endpoint: "https://hooks.example/capture",
      events: ["email.bounced", "suppression.added"],
    });

    const suppressions = createSuppressionEntity({ client: dynamo.client, table: dynamo.table });
    const processor = new EventProcessorService({
      emails: emailEntity,
      suppressions,
      emitter,
      clock: () => new Date("2026-08-09T12:05:00.000Z"),
    });

    const detail = {
      eventType: "Bounce",
      mail: {
        messageId: "ses-bounce-1",
        timestamp: "2026-08-09T12:04:00.000Z",
        tags: { email_id: ["20000000-0000-4000-8000-000000000001"] },
      },
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [
          { emailAddress: "gone@example.com", diagnosticCode: "smtp; 550 user unknown" },
        ],
      },
    };
    expect(await processor.processSesEvent(detail)).toBe("processed");

    const email = await emailEntity.get({ emailId: "20000000-0000-4000-8000-000000000001" }).go();
    expect(email.data?.status).toBe("bounced");
    expect(
      (await suppressions.get({ teamId: "team-ev", email: "gone@example.com" }).go()).data,
    ).toMatchObject({ reason: "hard_bounce" });

    const types = queue.messages.map((entry) => entry.message.type);
    expect(types).toContain("email.bounced");
    expect(types).toContain("suppression.added");
    const bounced = queue.messages.find((entry) => entry.message.type === "email.bounced");
    expect(bounced?.message.endpointId).toBe(endpoint.endpointId);

    // Redelivery of the same SES event must be a no-op.
    const before = queue.messages.length;
    expect(await processor.processSesEvent(detail)).toBe("skipped");
    expect(queue.messages.length).toBe(before);
  });

  it("dispatcher trips the circuit breaker after consecutive failures", async () => {
    const { webhooks } = makeEmitter();
    const endpoint = await webhooks.createEndpoint({
      teamId: "team-ev",
      // 192.0.2.1 is TEST-NET: safeFetch rejects it up front, so every
      // dispatch fails without touching the network.
      endpoint: "http://192.0.2.1/hook",
      events: ["email.sent"],
    });
    const dispatcher = new WebhookDispatchService({
      webhooks,
      deliveries: createWebhookDeliveryEntity({ client: dynamo.client, table: dynamo.table }),
      clock: () => new Date("2026-08-09T12:00:00.000Z"),
      idGenerator: () => `del-${Math.random().toString(36).slice(2, 10)}`,
    });

    let disabled = false;
    for (let attempt = 1; attempt <= 20 && !disabled; attempt++) {
      const result = await dispatcher.dispatch(
        { endpointId: endpoint.endpointId, svixId: "msg_x", type: "email.sent", body: "{}" },
        attempt,
      );
      if (result.outcome === "failure") disabled = result.disabled;
    }
    expect(disabled).toBe(true);
    expect((await webhooks.getEndpointById(endpoint.endpointId))?.status).toBe("disabled");

    const log = await dispatcher.listDeliveries(endpoint.endpointId, 50);
    expect(log.length).toBeGreaterThanOrEqual(20);
    expect(log[0]).toMatchObject({ outcome: "failure" });

    // A disabled endpoint drops instead of retrying.
    const dropped = await dispatcher.dispatch(
      { endpointId: endpoint.endpointId, svixId: "msg_y", type: "email.sent", body: "{}" },
      1,
    );
    expect(dropped).toEqual({ outcome: "dropped" });
  });
});

describe("better-auth on the single table", () => {
  function makeAuth(provider: FakeEmailProvider, signupOpen: boolean) {
    return createAuth({
      client: dynamo.client,
      table: dynamo.table,
      secret: "test-secret-test-secret-test-secret",
      baseURL: "http://localhost:3000",
      trustedOrigins: ["http://localhost:3000"],
      dashboardOrigin: "http://localhost:5173",
      signupOpen,
      teams: makeTeamsService(provider),
    });
  }

  it("rejects sign-up server-side when signupOpen is false", async () => {
    const auth = makeAuth(new FakeEmailProvider(), false);
    const response = await auth.handler(
      new Request("http://localhost:3000/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "nope@example.com",
          password: "password123",
          name: "Nope",
        }),
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("bootstraps the first admin exactly once, then signs in and creates a team", async () => {
    const provider = new FakeEmailProvider();
    const auth = makeAuth(provider, false);
    const bootstrap = new BootstrapService({
      auth,
      expectedToken: async () => "expected-token",
    });

    expect(await bootstrap.needsBootstrap()).toBe(true);

    await expect(
      bootstrap.createFirstAdmin({
        token: "wrong-token",
        email: "admin@example.com",
        password: "password123",
        name: "Admin",
      }),
    ).rejects.toThrow(BootstrapTokenMismatchError);

    const created = await bootstrap.createFirstAdmin({
      token: "expected-token",
      email: "admin@example.com",
      password: "password123",
      name: "Admin",
    });
    expect(created.userId).toBeTruthy();
    expect(await bootstrap.needsBootstrap()).toBe(false);

    await expect(
      bootstrap.createFirstAdmin({
        token: "expected-token",
        email: "second@example.com",
        password: "password123",
        name: "Second",
      }),
    ).rejects.toThrow(BootstrapUnavailableError);

    // Sign in with the bootstrapped credentials through the HTTP surface.
    const signIn = await auth.handler(
      new Request("http://localhost:3000/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@example.com", password: "password123" }),
      }),
    );
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("better-auth");

    const session = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });
    expect(session?.user.email).toBe("admin@example.com");

    // Creating an organization runs the afterCreateOrganization hook, which
    // provisions the SES tenant + Team record with the same id.
    const org = await auth.api.createOrganization({
      body: { name: "Acme", slug: "acme" },
      headers: new Headers({ cookie }),
    });
    expect(org?.id).toBeTruthy();
    const orgId = org?.id as string;
    expect(provider.tenants.has(tenantNameForTeam(orgId))).toBe(true);

    const teams = makeTeamsService(provider);
    expect(await teams.getTeam(orgId)).toMatchObject({ name: "Acme", status: "active" });
  });

  it("serves OAuth authorization-server metadata", async () => {
    const auth = makeAuth(new FakeEmailProvider(), false);
    const response = await auth.handler(
      new Request("http://localhost:3000/auth/.well-known/oauth-authorization-server"),
    );
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      authorization_endpoint: "http://localhost:3000/auth/oauth2/authorize",
      token_endpoint: "http://localhost:3000/auth/oauth2/token",
      registration_endpoint: "http://localhost:3000/auth/oauth2/register",
      revocation_endpoint: "http://localhost:3000/auth/oauth2/revoke",
      code_challenge_methods_supported: ["S256"],
    });
    expect(metadata.scopes_supported).toEqual(
      expect.arrayContaining(["emails:send", "full_access", "offline_access"]),
    );
  });

  it("registers a public OAuth client dynamically without authentication", async () => {
    const auth = makeAuth(new FakeEmailProvider(), false);
    const response = await auth.handler(
      new Request("http://localhost:3000/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Test MCP host",
          redirect_uris: ["http://127.0.0.1:33418/callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    // oauth-provider 1.6.26 responds 200 (not RFC 7591's 201) — pinned here
    // so a future upgrade that fixes it fails loudly instead of silently.
    expect(response.status).toBe(200);
    const client = (await response.json()) as Record<string, unknown>;
    expect(client.client_id).toBeTruthy();
    // Public client: no secret is minted, PKCE is mandatory instead.
    expect(client.client_secret).toBeUndefined();
    expect(client.token_endpoint_auth_method).toBe("none");
    expect(client.scope).toBe("emails:send offline_access");
  });

  it("issues team-scoped JWTs through the authorization-code + PKCE flow", async () => {
    const auth = makeAuth(new FakeEmailProvider(), true);
    const base = "http://localhost:3000/auth";

    // A signed-in user with one active team (sign-up open for this instance).
    const signUp = await auth.handler(
      new Request(`${base}/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "granter@example.com",
          password: "password123",
          name: "Granter",
        }),
      }),
    );
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers.get("set-cookie") ?? "";
    const headers = new Headers({ cookie });
    const org = await auth.api.createOrganization({
      body: { name: "Grant Co", slug: "grant-co" },
      headers,
    });
    const teamId = org?.id as string;
    await auth.api.setActiveOrganization({ body: { organizationId: teamId }, headers });

    // The connecting app: a dynamically registered public client.
    const registered = await auth.handler(
      new Request(`${base}/oauth2/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Flow test app",
          redirect_uris: ["http://127.0.0.1:33418/callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    const clientId = ((await registered.json()) as { client_id: string }).client_id;

    // PKCE S256 pair.
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    const authorizeUrl = new URL(`${base}/oauth2/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", "http://127.0.0.1:33418/callback");
    authorizeUrl.searchParams.set("scope", "emails:send offline_access");
    authorizeUrl.searchParams.set("state", "state-xyz");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    // RFC 8707: naming the API as the resource is what makes the access token
    // a JWT with that audience (no resource ⇒ opaque token, which the API
    // rejects — issue 03). MCP hosts send this automatically.
    authorizeUrl.searchParams.set("resource", "http://localhost:3000");
    const authorize = await auth.handler(
      new Request(authorizeUrl, { headers: new Headers({ cookie }) }),
    );
    // Single membership + active org: postLogin is skipped, straight to consent.
    expect(authorize.status).toBe(302);
    const consentRedirect = new URL(authorize.headers.get("location") ?? "");
    expect(consentRedirect.origin).toBe("http://localhost:5173");
    expect(consentRedirect.pathname).toBe("/consent");

    // The consent page approves with the signed oauth_query it received.
    const consent = await auth.handler(
      new Request(`${base}/oauth2/consent`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          accept: true,
          oauth_query: consentRedirect.search.slice(1),
        }),
      }),
    );
    expect(consent.status).toBe(200);
    // 1.6.26 returns `{ redirect: true, url }` (its OpenAPI metadata says
    // `redirect_uri`, the implementation disagrees — trust the code).
    const consentBody = (await consent.json()) as { url: string };
    const callback = new URL(consentBody.url);
    expect(`${callback.origin}${callback.pathname}`).toBe("http://127.0.0.1:33418/callback");
    expect(callback.searchParams.get("state")).toBe("state-xyz");
    expect(callback.searchParams.get("iss")).toBe(base);
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    // Code + verifier exchange for the token pair.
    const tokenResponse = await auth.handler(
      new Request(`${base}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code ?? "",
          redirect_uri: "http://127.0.0.1:33418/callback",
          client_id: clientId,
          code_verifier: verifier,
          resource: "http://localhost:3000",
        }).toString(),
      }),
    );
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as Record<string, unknown>;
    expect(tokens.refresh_token).toBeTruthy();
    expect(tokens.expires_in).toBe(15 * 60);

    // The access token is a JWT carrying the consented team + scopes.
    const accessToken = tokens.access_token as string;
    const [, payloadPart] = accessToken.split(".");
    const payload = JSON.parse(Buffer.from(payloadPart ?? "", "base64url").toString()) as Record<
      string,
      unknown
    >;
    expect(payload.team_id).toBe(teamId);
    expect(payload.scope).toContain("emails:send");
    expect((payload.exp as number) - (payload.iat as number)).toBe(15 * 60);

    // azp + sub identify the grant — the keys of the domain restriction.
    expect(payload.azp).toBe(clientId);
    expect(typeof payload.sub).toBe("string");

    // The API-side verifier resolves the same JWT into a team principal.
    const grants = createOAuthGrants(auth);
    const verify = createOAuthTokenVerifier({
      auth,
      baseURL: "http://localhost:3000",
      grants,
      grantDomainsCacheTtlMs: 0,
    });
    expect(await verify(accessToken)).toEqual({ teamId, permission: "sending_access" });
    // Tampered signature and garbage are both just invalid bearers.
    expect(await verify(`${accessToken.slice(0, -4)}AAAA`)).toBeNull();
    expect(await verify("not.a.jwt")).toBeNull();

    // Narrowing the grant to specific domains surfaces on the principal;
    // clearing the restriction removes it again.
    const grantKey = { clientId, userId: payload.sub as string, teamId };
    await grants.setGrantDomains(grantKey, ["dom-1", "dom-2"]);
    expect(await verify(accessToken)).toEqual({
      teamId,
      permission: "sending_access",
      allowedDomainIds: ["dom-1", "dom-2"],
    });
    expect(await grants.getGrantDomains(grantKey)).toEqual(["dom-1", "dom-2"]);
    await grants.setGrantDomains(grantKey, null);
    expect(await verify(accessToken)).toEqual({ teamId, permission: "sending_access" });

    // last_used_at derives from the newest refresh-token issuance.
    const [grant] = await grants.listGrants(payload.sub as string, teamId);
    expect(grant?.lastUsedAt).toBeTruthy();

    // Refresh rotation: a new pair is minted and the old token dies.
    const refreshed = await auth.handler(
      new Request(`${base}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token as string,
          client_id: clientId,
        }).toString(),
      }),
    );
    expect(refreshed.status).toBe(200);
    const rotated = (await refreshed.json()) as Record<string, unknown>;
    expect(rotated.refresh_token).toBeTruthy();
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);

    const replayed = await auth.handler(
      new Request(`${base}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token as string,
          client_id: clientId,
        }).toString(),
      }),
    );
    expect(replayed.status).toBeGreaterThanOrEqual(400);

    // With consent persisted, a repeat authorize skips the consent screen and
    // redirects straight to the callback with a fresh code — which must be
    // useless to anyone holding the wrong PKCE verifier.
    const repeatAuthorize = await auth.handler(
      new Request(authorizeUrl, { headers: new Headers({ cookie }) }),
    );
    expect(repeatAuthorize.status).toBe(302);
    const directCallback = new URL(repeatAuthorize.headers.get("location") ?? "");
    expect(`${directCallback.origin}${directCallback.pathname}`).toBe(
      "http://127.0.0.1:33418/callback",
    );
    const secondCode = directCallback.searchParams.get("code");
    expect(secondCode).toBeTruthy();

    const mismatched = await auth.handler(
      new Request(`${base}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: secondCode ?? "",
          redirect_uri: "http://127.0.0.1:33418/callback",
          client_id: clientId,
          code_verifier: randomBytes(32).toString("base64url"),
          resource: "http://localhost:3000",
        }).toString(),
      }),
    );
    expect(mismatched.status).toBeGreaterThanOrEqual(400);
  });
});
