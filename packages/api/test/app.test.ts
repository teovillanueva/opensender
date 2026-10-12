import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Broadcast, Contact, Segment } from "@opensender/core";
import { signUnsubscribeToken } from "@opensender/core";
import { describe, expect, it } from "vitest";
import type { AppDeps } from "../src/index.js";
import { createApp } from "../src/index.js";

/**
 * Conformance: fixture-replay against the real app with fake services
 * (SPEC §17). Bodies compare deep-equal to the vendored golden fixtures —
 * the wire truth, not our opinion of it.
 */

const FIXTURES = join(import.meta.dirname, "../../contract/fixtures/resend");

function fixture(name: string): {
  request: { method: string; path: string; headers: Record<string, string> };
  response: { status: number; body: unknown };
} {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

const VALID_TOKEN = "re_validvalidvalidvalidvalidvalid1";
const RESTRICTED_TOKEN = "re_restrictedrestrictedrestricted1";

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const keyRecords = [
    {
      keyId: "1acb43ac-f352-443c-b652-f35749321594",
      teamId: "team-1",
      name: "prod",
      permission: "full_access" as const,
      createdAt: "2026-08-08T17:51:40.073Z",
      lastUsedAt: "2026-08-08T17:56:13.378Z",
    },
  ];
  let counter = 0;
  return {
    apiKeys: {
      verifyToken: async (token: string) => {
        if (token === VALID_TOKEN) {
          return { keyId: "key-1", teamId: "team-1", permission: "full_access" as const };
        }
        if (token === RESTRICTED_TOKEN) {
          return { keyId: "key-2", teamId: "team-1", permission: "sending_access" as const };
        }
        return undefined;
      },
      createKey: async (input) => ({
        key: {
          keyId: "1acb43ac-f352-443c-b652-f35749321594",
          teamId: input.teamId,
          name: input.name,
          permission: input.permission,
          createdAt: "2026-08-08T17:51:40.073Z",
        },
        token: "re_NewToken00000000000000000000000",
      }),
      listKeys: async () => keyRecords,
      deleteKey: async (_teamId, keyId) => keyId === keyRecords[0]?.keyId,
    },
    teams: {
      createTeam: async () => {
        throw new Error("not under test");
      },
      getTeam: async (teamId) => ({
        teamId,
        name: "Team",
        sesTenantName: `team-${teamId}`,
        plan: "default",
        status: "active" as const,
        createdAt: "2026-08-08T00:00:00.000Z",
      }),
      quotasFor: () => ({ dailyEmailLimit: 1_000, apiRateLimitPerSecond: 10 }),
    },
    rateLimiter: {
      consume: async (_teamId, limit) => {
        counter += 1;
        return {
          allowed: counter <= limit,
          limit,
          remaining: Math.max(0, limit - counter),
          resetSeconds: 1,
        };
      },
    },
    domains: fakeDomains(),
    ...fakeEmailDeps(),
    webhooks: fakeWebhooks(),
    webhookReplay: { enqueue: async () => {} },
    ...fakeMarketing(),
    auth: fakeAuth(null, false),
    oauthGrants: {
      listGrants: async () => [
        {
          id: "consent-1",
          clientId: "client-1",
          clientName: "Test App",
          scopes: ["emails:send"],
          createdAt: "2026-08-13T00:00:00.000Z",
          lastUsedAt: "2026-08-13T01:00:00.000Z",
          domainIds: null,
        },
      ],
      revokeGrant: async (_userId, _teamId, consentId) => consentId === "consent-1",
      setGrantDomains: async () => {},
      getGrantDomains: async () => undefined,
    },
    bootstrap: {
      needsBootstrap: async () => true,
      createFirstAdmin: async () => ({ userId: "user-1" }),
    },
    dashboardOrigin: "https://mailing.example.com",
    ...overrides,
  };
}

const FIXTURE_DOMAIN = {
  domainId: "db88ac50-bb8c-4970-96e0-9e869ba8a150",
  teamId: "team-1",
  name: "example.net",
  region: "us-east-1",
  status: "verified" as const,
  clickTracking: false,
  openTracking: false,
  tls: "opportunistic" as const,
  inboundEnabled: false,
  dkimTokens: ["t1", "t2", "t3"],
  signingHostedZone: "dkim.amazonses.com",
  configurationSetName: "domain-db88ac50",
  dkimStatus: "SUCCESS",
  mailFromStatus: "SUCCESS",
  createdAt: "2025-12-05T15:28:00.278Z",
};

function fakeDomains(): AppDeps["domains"] {
  return {
    createDomain: async (input) => ({
      ...FIXTURE_DOMAIN,
      name: input.name.toLowerCase(),
      status: "not_started",
      dkimStatus: "NOT_STARTED",
      mailFromStatus: "NOT_STARTED",
    }),
    getDomain: async (_teamId, id) => (id === FIXTURE_DOMAIN.domainId ? FIXTURE_DOMAIN : undefined),
    listDomains: async () => [FIXTURE_DOMAIN],
    recordsFor: () => [
      {
        record: "DKIM",
        name: "t1._domainkey",
        type: "CNAME",
        ttl: "Auto",
        status: "verified",
        value: "t1.dkim.amazonses.com",
      },
    ],
    requestVerification: async (domain) => domain,
    refreshVerification: async (domain) => domain,
    updateDomain: async (domain) => domain,
    setInboundEnabled: async (domain) => ({ ...domain, inboundEnabled: true }),
    deleteDomain: async () => {},
  };
}

const SENT_EMAIL = {
  emailId: "f58cbaa7-e6a3-405f-a00a-90788eceb224",
  teamId: "team-1",
  direction: "outbound" as const,
  from: "onboarding@resend.dev",
  to: ["owner@example.net"],
  subject: "opensender fixture capture",
  html: "<p>Golden fixture capture. Please ignore.</p>",
  status: "sent" as const,
  sesMessageId: "0100019fe28688e6-87caea31-bf32-4c73-8032-91ac39760ba1-000000",
  messageId: "<0100019fe28688e6-87caea31-bf32-4c73-8032-91ac39760ba1-000000@email.amazonses.com>",
  createdAt: "2026-08-08T17:58:15.369Z",
};

const INBOUND_EMAIL = {
  emailId: "bbbb2222-0000-4000-8000-000000000002",
  teamId: "team-1",
  direction: "inbound" as const,
  from: "sender@external.example",
  to: ["inbox@test.mailing.example.com"],
  subject: "hello inbound",
  html: "<p>hi</p>",
  text: "hi",
  status: "received" as const,
  messageId: "inbound-msg-1",
  createdAt: "2026-08-09T18:00:00.000Z",
  headers: { "X-Custom": "1" },
  attachments: [
    {
      attachmentId: "cccc3333-0000-4000-8000-000000000003",
      filename: "a.txt",
      contentType: "text/plain",
      sizeBytes: 5,
      blobKey: "inbound/x/y",
    },
  ],
};

function fakeEmailDeps(): Pick<AppDeps, "emails" | "idempotency" | "quotaUsage" | "now"> {
  const records = new Map<
    string,
    { bodyHash: string; state: string; responseStatus?: number; responseBody?: string }
  >();
  let usage = { daily: 3, monthly: 9 };
  let sendCounter = 0;
  return {
    emails: {
      send: async (_teamId, request) => {
        sendCounter += 1;
        usage = { daily: usage.daily + 1, monthly: usage.monthly + 1 };
        return {
          email: {
            ...SENT_EMAIL,
            emailId:
              sendCounter === 1
                ? SENT_EMAIL.emailId
                : `00000000-0000-4000-8000-${String(sendCounter).padStart(12, "0")}`,
            from: request.from,
            to: request.to,
            subject: request.subject,
            status: request.scheduledAt ? ("scheduled" as const) : ("sent" as const),
          },
          usage,
        };
      },
      getEmail: async (_teamId, id) => (id === SENT_EMAIL.emailId ? SENT_EMAIL : undefined),
      getInboundEmail: async (_teamId, id) =>
        id === INBOUND_EMAIL.emailId ? INBOUND_EMAIL : undefined,
      listEmails: async (_teamId, _limit, direction = "outbound") => ({
        emails: direction === "inbound" ? [INBOUND_EMAIL] : [SENT_EMAIL],
        cursor: null,
      }),
      listEmailsByCursor: async (_teamId, _limit, cursor = {}) => {
        const anchor = cursor.after ?? cursor.before;
        if (anchor !== undefined && anchor !== SENT_EMAIL.emailId) return undefined;
        return { emails: anchor === undefined ? [SENT_EMAIL] : [], hasMore: false };
      },
      listEvents: async () => [],
      updateScheduledAt: async () => {},
      cancel: async () => {},
      attachmentDownloadUrl: async () => "https://example.com/signed",
      sendScheduled: async () => "sent" as const,
      listSuppressions: async () => ({ suppressions: [], cursor: null }),
      getSuppression: async () => undefined,
      addSuppression: async (teamId, email) => ({
        teamId,
        email: email.toLowerCase(),
        reason: "manual" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      removeSuppression: async () => false,
      metricsSummary: async () => ({
        start: "2026-01-01T00:00:00.000Z",
        end: "2026-01-02T00:00:00.000Z",
        totals: {
          sent: 0,
          attempted: 0,
          delivered: 0,
          bounced: 0,
          complained: 0,
          failed: 0,
          received: 0,
        },
        daily: [],
        domains: [],
      }),
    },
    idempotency: {
      claim: async (teamId, endpoint, key, bodyHash) => {
        const id = `${teamId}|${endpoint}|${key}`;
        const existing = records.get(id);
        if (!existing) {
          records.set(id, { bodyHash, state: "in_flight" });
          return { kind: "claimed" as const };
        }
        if (existing.bodyHash !== bodyHash) return { kind: "mismatch" as const };
        if (existing.state === "completed") {
          return {
            kind: "replay" as const,
            response: {
              status: existing.responseStatus ?? 200,
              body: existing.responseBody ?? "{}",
            },
          };
        }
        return { kind: "in_flight" as const };
      },
      complete: async (teamId, endpoint, key, response) => {
        records.set(`${teamId}|${endpoint}|${key}`, {
          bodyHash: records.get(`${teamId}|${endpoint}|${key}`)?.bodyHash ?? "",
          state: "completed",
          responseStatus: response.status,
          responseBody: response.body,
        });
      },
      release: async (teamId, endpoint, key) => {
        records.delete(`${teamId}|${endpoint}|${key}`);
      },
    },
    quotaUsage: async () => usage,
    now: () => new Date("2026-08-08T17:58:15.369Z"),
  };
}

const WEBHOOK_ENDPOINT = {
  endpointId: "aaaa1111-0000-4000-8000-000000000001",
  teamId: "team-1",
  endpoint: "https://example.com/hooks",
  events: ["email.sent"],
  signingSecret: "whsec_dGVzdC1zZWNyZXQtdGVzdC1zZWNyZXQ=",
  status: "enabled" as const,
  consecutiveFailures: 0,
  createdAt: "2026-08-08T17:58:15.369Z",
};

function fakeWebhooks(): AppDeps["webhooks"] {
  return {
    createEndpoint: async (input) => ({ ...WEBHOOK_ENDPOINT, ...input }),
    getEndpoint: async (_teamId, id) =>
      id === WEBHOOK_ENDPOINT.endpointId ? WEBHOOK_ENDPOINT : undefined,
    listEndpoints: async () => [WEBHOOK_ENDPOINT],
    updateEndpoint: async () => {},
    deleteEndpoint: async () => {},
    listDeliveries: async () => ({ deliveries: [], cursor: null }),
    getDelivery: async () => undefined,
  };
}

/**
 * Wire timestamps carry microsecond precision; JS Dates only milliseconds, so
 * `toWireTimestamp` always emits `...ffe000+00`. Seed fakes from the fixture
 * timestamps truncated to ms, and normalize the sub-ms digits on both sides
 * before comparing — everything else is asserted byte-for-byte.
 */
function wireToIso(wire: string): string {
  return new Date(`${wire.slice(0, 10)}T${wire.slice(11, 23)}Z`).toISOString();
}
function normalizeTimestamps<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(/(\.\d{3})\d{3}\+00/g, "$1000+00")) as T;
}

const AUDIENCE_GENERAL = {
  segmentId: "b3412b39-6587-4d5f-8e5f-6205044d7b72",
  teamId: "team-1",
  name: "General",
  createdAt: wireToIso("2025-12-05 13:23:51.056442+00"),
};
const TEMP_AUDIENCE_ID = "d1ef2c68-e254-431c-a96d-40eabcf623d1";
const TEMP_AUDIENCE_CREATED = wireToIso("2026-08-08 17:56:15.931344+00");
const FIXTURE_CONTACT_ID = "e46e5d30-2fba-402f-881e-0b49a7d5f9cb";
const FIXTURE_CONTACT_CREATED = wireToIso("2026-08-08 17:56:16.890024+00");

interface MarketingFake {
  segments: AppDeps["segments"];
  contacts: AppDeps["contacts"];
  broadcasts: AppDeps["broadcasts"];
  broadcastSender: AppDeps["broadcastSender"];
  unsubscribeContacts: AppDeps["unsubscribeContacts"];
  unsubscribeSecret: string;
  state: {
    segments: Map<string, Segment>;
    contacts: Map<string, Contact>;
    broadcasts: Map<string, Broadcast>;
    sends: Array<{ broadcastId: string; teamId: string; scheduledAt?: string }>;
  };
}

const UNSUBSCRIBE_SECRET = "unsub-test-secret";

function fakeMarketing(): MarketingFake {
  const segments = new Map<string, Segment>([
    [AUDIENCE_GENERAL.segmentId, { ...AUDIENCE_GENERAL }],
  ]);
  const contacts = new Map<string, Contact>();
  const broadcasts = new Map<string, Broadcast>();
  const sends: MarketingFake["state"]["sends"] = [];

  return {
    unsubscribeSecret: UNSUBSCRIBE_SECRET,
    state: { segments, contacts, broadcasts, sends },
    segments: {
      create: async ({ teamId, name }) => {
        const record: Segment = {
          segmentId: TEMP_AUDIENCE_ID,
          teamId,
          name,
          createdAt: TEMP_AUDIENCE_CREATED,
        };
        segments.set(record.segmentId, record);
        return record;
      },
      get: async (teamId, segmentId) => {
        const record = segments.get(segmentId);
        return record && record.teamId === teamId ? record : undefined;
      },
      list: async (teamId) =>
        [...segments.values()]
          .filter((s) => s.teamId === teamId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      updateName: async (segment, name) => {
        const updated = { ...segment, name };
        segments.set(segment.segmentId, updated);
        return updated;
      },
      delete: async (segmentId) => {
        segments.delete(segmentId);
      },
    },
    contacts: {
      create: async (input) => {
        const record: Contact = {
          contactId: FIXTURE_CONTACT_ID,
          teamId: input.teamId,
          segmentId: input.segmentId,
          email: input.email.toLowerCase(),
          ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
          ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
          unsubscribed: input.unsubscribed ?? false,
          createdAt: FIXTURE_CONTACT_CREATED,
        };
        contacts.set(record.contactId, record);
        return record;
      },
      getByIdOrEmail: async (teamId, segmentId, idOrEmail) => {
        const needle = idOrEmail.toLowerCase();
        return [...contacts.values()].find(
          (con) =>
            con.teamId === teamId &&
            con.segmentId === segmentId &&
            (con.contactId === idOrEmail || con.email === needle),
        );
      },
      list: async (segmentId) =>
        [...contacts.values()]
          .filter((con) => con.segmentId === segmentId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      listSendable: async (segmentId) =>
        [...contacts.values()].filter((con) => con.segmentId === segmentId && !con.unsubscribed),
      update: async (contact, patch) => {
        const updated: Contact = {
          ...contact,
          ...(patch.firstName === undefined ? {} : { firstName: patch.firstName }),
          ...(patch.lastName === undefined ? {} : { lastName: patch.lastName }),
          ...(patch.unsubscribed === undefined ? {} : { unsubscribed: patch.unsubscribed }),
        };
        contacts.set(contact.contactId, updated);
        return updated;
      },
      setUnsubscribed: async (contact, unsubscribed) => {
        const updated = { ...contact, unsubscribed };
        contacts.set(contact.contactId, updated);
        return updated;
      },
      delete: async (contact) => {
        contacts.delete(contact.contactId);
      },
    },
    broadcasts: {
      create: async (input) => {
        const record: Broadcast = {
          broadcastId: "f0000000-0000-4000-8000-000000000001",
          teamId: input.teamId,
          segmentId: input.segmentId,
          from: input.from,
          subject: input.subject,
          ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.html === undefined ? {} : { html: input.html }),
          ...(input.text === undefined ? {} : { text: input.text }),
          status: "draft",
          createdAt: "2026-08-09T12:00:00.000Z",
        };
        broadcasts.set(record.broadcastId, record);
        return record;
      },
      get: async (teamId, broadcastId) => {
        const record = broadcasts.get(broadcastId);
        return record && record.teamId === teamId ? record : undefined;
      },
      list: async (teamId) => [...broadcasts.values()].filter((b) => b.teamId === teamId),
      update: async (broadcast, patch) => {
        const updated: Broadcast = {
          ...broadcast,
          ...(patch.segmentId === undefined ? {} : { segmentId: patch.segmentId }),
          ...(patch.from === undefined ? {} : { from: patch.from }),
          ...(patch.subject === undefined ? {} : { subject: patch.subject }),
          ...(patch.replyTo === undefined ? {} : { replyTo: patch.replyTo }),
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.html === undefined ? {} : { html: patch.html }),
          ...(patch.text === undefined ? {} : { text: patch.text }),
        };
        broadcasts.set(broadcast.broadcastId, updated);
        return updated;
      },
      delete: async (broadcastId) => {
        broadcasts.delete(broadcastId);
      },
      markStatus: async (broadcastId, status) => {
        const record = broadcasts.get(broadcastId);
        if (record) broadcasts.set(broadcastId, { ...record, status });
      },
      setSchedule: async (broadcastId, scheduledAt) => {
        const record = broadcasts.get(broadcastId);
        if (record) broadcasts.set(broadcastId, { ...record, scheduledAt, status: "scheduled" });
      },
      setPendingPages: async (broadcastId, pages) => {
        const record = broadcasts.get(broadcastId);
        if (record) broadcasts.set(broadcastId, { ...record, pendingPages: pages });
      },
      completePage: async (broadcastId) => {
        const record = broadcasts.get(broadcastId);
        const remaining = (record?.pendingPages ?? 1) - 1;
        if (record) broadcasts.set(broadcastId, { ...record, pendingPages: remaining });
        return remaining;
      },
      incrementStat: async () => {},
    },
    broadcastSender: {
      send: async (broadcastId, teamId, scheduledAt) => {
        sends.push({
          broadcastId,
          teamId,
          ...(scheduledAt === undefined ? {} : { scheduledAt }),
        });
      },
    },
    unsubscribeContacts: {
      getById: async (contactId) => contacts.get(contactId),
      setUnsubscribed: async (contact, unsubscribed) => {
        const updated = { ...contact, unsubscribed };
        contacts.set(contact.contactId, updated);
        return updated;
      },
    },
  };
}

function marketingDeps(mkt: MarketingFake): Partial<AppDeps> {
  return {
    segments: mkt.segments,
    contacts: mkt.contacts,
    broadcasts: mkt.broadcasts,
    broadcastSender: mkt.broadcastSender,
    unsubscribeContacts: mkt.unsubscribeContacts,
    unsubscribeSecret: mkt.unsubscribeSecret,
  };
}

function fakeAuth(
  session: { session: { activeOrganizationId?: string }; user: { id: string } } | null,
  isMember: boolean,
): AppDeps["auth"] {
  return {
    handler: async () => new Response("auth", { status: 200 }),
    api: { getSession: async () => session },
    $context: Promise.resolve({
      adapter: { findOne: async () => (isMember ? { id: "member-1" } : null) },
    }),
  } as unknown as AppDeps["auth"];
}

async function replay(
  app: ReturnType<typeof createApp>,
  name: string,
  headers: Record<string, string>,
) {
  const fx = fixture(name);
  const response = await app.request(fx.request.path, {
    method: fx.request.method,
    headers,
  });
  expect(response.status, name).toBe(fx.response.status);
  expect(await response.json(), name).toEqual(fx.response.body);
  expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  return response;
}

describe("fixture conformance — auth errors", () => {
  it("401 missing_api_key without Authorization (fixture 01), no ratelimit headers", async () => {
    const response = await replay(createApp(makeDeps()), "01-401-missing-api-key.json", {});
    expect(response.headers.get("ratelimit-limit")).toBeNull();
  });

  it("400 validation_error for an invalid key (fixture 02)", async () => {
    await replay(createApp(makeDeps()), "02-401-or-403-invalid-api-key.json", {
      Authorization: "Bearer re_invalid_1234",
    });
  });

  it("401 restricted_api_key on a non-send route (fixture 37), no ratelimit headers", async () => {
    const response = await replay(createApp(makeDeps()), "37-401-restricted-api-key.json", {
      Authorization: `Bearer ${RESTRICTED_TOKEN}`,
    });
    expect(response.headers.get("ratelimit-limit")).toBeNull();
  });
});

describe("fixture conformance — 405 and rate limiting", () => {
  it("405 method_not_allowed body for a known path with wrong method (fixture 04 message shape)", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/api-keys", {
      method: "PUT",
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      statusCode: 405,
      message: "Method PUT is not allowed for the requested path.",
      name: "method_not_allowed",
    });
    expect(response.headers.get("ratelimit-limit")).toBe("10");
  });

  it("429 with fixture-30 verbatim body and exact headers on the 11th request", async () => {
    const app = createApp(makeDeps());
    const headers = { Authorization: `Bearer ${VALID_TOKEN}` };
    for (let i = 0; i < 10; i++) {
      const ok = await app.request("/api-keys", { headers });
      expect(ok.status).toBe(200);
    }
    const fx = fixture("30-429-rate-limit-burst.json");
    const limited = await app.request("/api-keys", { headers });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual(fx.response.body);
    expect(limited.headers.get("ratelimit-limit")).toBe("10");
    expect(limited.headers.get("ratelimit-remaining")).toBe("0");
    expect(limited.headers.get("ratelimit-reset")).toBe("1");
    expect(limited.headers.get("ratelimit-policy")).toBe("10;w=1");
    expect(limited.headers.get("retry-after")).toBe("1");
  });

  it("ratelimit headers ride successful responses too (fixture 03/04 pattern)", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/api-keys", {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("ratelimit-policy")).toBe("10;w=1");
    expect(response.headers.get("ratelimit-remaining")).toBe("9");
  });
});

describe("api-keys surface", () => {
  const authHeaders = {
    Authorization: `Bearer ${VALID_TOKEN}`,
    "content-type": "application/json",
  };

  it("creates a key with the fixture-14 shape", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/api-keys", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "prod" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: "1acb43ac-f352-443c-b652-f35749321594",
      object: "api_key",
      token: "re_NewToken00000000000000000000000",
    });
  });

  it("lists keys in the fixture-12 shape with wire timestamps", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/api-keys", { headers: authHeaders });
    expect(await response.json()).toEqual({
      object: "list",
      has_more: false,
      data: [
        {
          id: "1acb43ac-f352-443c-b652-f35749321594",
          name: "prod",
          created_at: "2026-08-08 17:51:40.073000+00",
          last_used_at: "2026-08-08 17:56:13.378000+00",
        },
      ],
    });
  });

  it("deletes with the fixture-15 shape and 404s on unknown ids", async () => {
    const app = createApp(makeDeps());
    const del = await app.request("/api-keys/1acb43ac-f352-443c-b652-f35749321594", {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(await del.json()).toEqual({
      object: "api_key",
      id: "1acb43ac-f352-443c-b652-f35749321594",
      deleted: true,
    });

    const missing = await app.request("/api-keys/00000000-0000-0000-0000-000000000000", {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(missing.status).toBe(404);

    const badId = await app.request("/api-keys/not-a-uuid", {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(badId.status).toBe(422);
    expect(((await badId.json()) as { name: string }).name).toBe("invalid_parameter");
  });

  it("rejects a bad permission value with invalid_access", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/api-keys", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "x", permission: "root_access" }),
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { name: string }).name).toBe("invalid_access");
  });
});

describe("domains surface", () => {
  const authHeaders = {
    Authorization: `Bearer ${VALID_TOKEN}`,
    "content-type": "application/json",
  };

  it("GET /domains/:id matches fixture-31 shape (object, records, tracking flags)", async () => {
    const app = createApp(makeDeps());
    const response = await app.request(`/domains/${FIXTURE_DOMAIN.domainId}`, {
      headers: authHeaders,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      object: "domain",
      id: FIXTURE_DOMAIN.domainId,
      name: "example.net",
      created_at: "2025-12-05 15:28:00.278000+00",
      status: "verified",
      capabilities: { sending: "enabled", receiving: "disabled" },
      region: "us-east-1",
      open_tracking: false,
      click_tracking: false,
    });
    expect(Array.isArray(body.records)).toBe(true);
  });

  it("POST /domains returns the created domain without an object key", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/domains", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "Example.COM" }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.object).toBeUndefined();
    expect(body).toMatchObject({ name: "example.com", status: "not_started" });
  });

  it("rejects unknown regions with invalid_region", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/domains", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "x.com", region: "mars-1" }),
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { name: string }).name).toBe("invalid_region");
  });

  it("verify, patch, and delete return the documented envelopes", async () => {
    const app = createApp(makeDeps());
    const id = FIXTURE_DOMAIN.domainId;
    const verify = await app.request(`/domains/${id}/verify`, {
      method: "POST",
      headers: authHeaders,
    });
    expect(await verify.json()).toEqual({ object: "domain", id });

    const patch = await app.request(`/domains/${id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ click_tracking: true }),
    });
    expect(await patch.json()).toEqual({ object: "domain", id });

    const del = await app.request(`/domains/${id}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(await del.json()).toEqual({ object: "domain", id, deleted: true });

    const missing = await app.request("/domains/00000000-0000-0000-0000-000000000000", {
      headers: authHeaders,
    });
    expect(missing.status).toBe(404);
  });

  it("GET /domains lists summaries without records", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/domains", { headers: authHeaders });
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).not.toHaveProperty("records");
    expect(body.data[0]).toMatchObject({ id: FIXTURE_DOMAIN.domainId, status: "verified" });
  });
});

describe("emails surface — validation fixtures 05-10 verbatim", () => {
  const authHeaders = {
    Authorization: `Bearer ${VALID_TOKEN}`,
    "content-type": "application/json",
  };

  async function post(app: ReturnType<typeof createApp>, body: string, headers = {}) {
    return app.request("/emails", {
      method: "POST",
      headers: { ...authHeaders, ...headers },
      body,
    });
  }

  it("replays fixtures 05-09 bodies exactly", async () => {
    const app = createApp(makeDeps());
    for (const fixtureName of [
      "05-validation-emails-empty-body.json",
      "06-validation-emails-missing-from.json",
      "07-validation-emails-invalid-from.json",
      "08-validation-emails-missing-content.json",
      "09-validation-emails-to-wrong-type.json",
    ]) {
      const fx = fixture(fixtureName) as unknown as {
        request: { body: unknown };
        response: { status: number; body: unknown };
      };
      const response = await post(app, JSON.stringify(fx.request.body));
      expect(response.status, fixtureName).toBe(fx.response.status);
      expect(await response.json(), fixtureName).toEqual(fx.response.body);
    }
  });

  it("replays fixture 10: malformed JSON is 400", async () => {
    const app = createApp(makeDeps());
    const response = await post(app, "{not json");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      statusCode: 400,
      name: "validation_error",
      message: "Request body must be valid JSON.",
    });
  });

  it("carries x-resend quota headers on POST /emails errors too (fixture 26-28 pattern)", async () => {
    const app = createApp(makeDeps());
    const response = await post(app, JSON.stringify({}));
    expect(response.headers.get("x-resend-daily-quota")).toBe("3");
    expect(response.headers.get("x-resend-monthly-quota")).toBe("9");
  });

  it("sends successfully with 200 { id } and quota headers", async () => {
    const app = createApp(makeDeps());
    const response = await post(
      app,
      JSON.stringify({ from: "a@d.co", to: ["x@y.co"], subject: "s", html: "<p>h</p>" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: SENT_EMAIL.emailId });
    expect(response.headers.get("x-resend-daily-quota")).toBe("4");
  });
});

describe("emails surface — idempotency (fixtures 33/35/36)", () => {
  const authHeaders = {
    Authorization: `Bearer ${VALID_TOKEN}`,
    "content-type": "application/json",
  };
  const sendBody = JSON.stringify({
    from: "a@d.co",
    to: ["x@y.co"],
    subject: "s",
    html: "<p>h</p>",
  });

  it("first send false, replay true with byte-identical body, mutation 409", async () => {
    const app = createApp(makeDeps());
    const headers = { ...authHeaders, "Idempotency-Key": "fixture-idem2" };

    const first = await app.request("/emails", { method: "POST", headers, body: sendBody });
    expect(first.status).toBe(200);
    expect(first.headers.get("idempotent-replayed")).toBe("false");
    const firstBody = await first.text();

    const replay = await app.request("/emails", { method: "POST", headers, body: sendBody });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(await replay.text()).toBe(firstBody);

    const mutated = await app.request("/emails", {
      method: "POST",
      headers,
      body: JSON.stringify({
        from: "a@d.co",
        to: ["x@y.co"],
        subject: "MUTATED",
        html: "<p>h</p>",
      }),
    });
    expect(mutated.status).toBe(409);
    const conflict = (await mutated.json()) as { name: string; message: string };
    expect(conflict.name).toBe("invalid_idempotent_request");
    expect(conflict.message).toBe(
      "This idempotency key has been used with this HTTP method and endpoint within the last 24 hours, but the request body was modified and doesn't match the original request.",
    );
    expect(mutated.headers.get("idempotent-replayed")).toBeNull();
  });

  it("errors do not consume the key (fixtures 25-27)", async () => {
    const app = createApp(makeDeps());
    const headers = { ...authHeaders, "Idempotency-Key": "error-then-success" };
    const bad = await app.request("/emails", {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(422);
    expect(bad.headers.get("idempotent-replayed")).toBe("false");

    const good = await app.request("/emails", { method: "POST", headers, body: sendBody });
    expect(good.status).toBe(200);
    expect(good.headers.get("idempotent-replayed")).toBe("false");
  });
});

describe("emails surface — batch (fixtures 28/29)", () => {
  const authHeaders = {
    Authorization: `Bearer ${VALID_TOKEN}`,
    "content-type": "application/json",
  };
  const valid = { from: "a@d.co", to: ["x@y.co"], subject: "s", html: "<p>h</p>" };
  const invalid = { to: ["x@y.co"], subject: "s", html: "<p>h</p>" };

  it("strict: one invalid item fails the whole batch with the first error (fixture 28)", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/emails/batch", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify([valid, invalid]),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      statusCode: 422,
      name: "validation_error",
      message: "Missing `from` field.",
    });
  });

  it("permissive: 202 with data + errors[{index, message}] (fixture 29)", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/emails/batch", {
      method: "POST",
      headers: { ...authHeaders, "x-batch-validation": "permissive" },
      body: JSON.stringify([valid, invalid]),
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { data: unknown[]; errors: unknown[] };
    expect(body.data).toHaveLength(1);
    expect(body.errors).toEqual([{ index: 1, message: "Missing `from` field." }]);
  });

  it("rejects attachments in batch items", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/emails/batch", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify([{ ...valid, attachments: [{ filename: "a.txt", content: "aGk=" }] }]),
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { message: string }).message).toBe(
      "Attachments are not supported for batch emails.",
    );
  });
});

describe("emails surface — retrieval (fixture 34)", () => {
  const authHeaders = { Authorization: `Bearer ${VALID_TOKEN}` };

  it("GET /emails/:id matches fixture 34 exactly", async () => {
    const app = createApp(makeDeps());
    const fx = fixture("34-get-email-after-send.json");
    const response = await app.request(`/emails/${SENT_EMAIL.emailId}`, { headers: authHeaders });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(fx.response.body);
  });

  it("GET /emails pages by after/before email id and validates the cursor", async () => {
    const app = createApp(makeDeps());
    const first = await app.request("/emails?limit=2", { headers: authHeaders });
    expect(((await first.json()) as { data: Array<{ id: string }> }).data[0]?.id).toBe(
      SENT_EMAIL.emailId,
    );

    const next = await app.request(`/emails?limit=2&after=${SENT_EMAIL.emailId}`, {
      headers: authHeaders,
    });
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual({ object: "list", has_more: false, data: [] });

    const both = await app.request(
      `/emails?after=${SENT_EMAIL.emailId}&before=${SENT_EMAIL.emailId}`,
      { headers: authHeaders },
    );
    expect(both.status).toBe(422);
    const malformed = await app.request("/emails?after=nope", { headers: authHeaders });
    expect(malformed.status).toBe(422);
    const unknown = await app.request("/emails?after=99999999-0000-4000-8000-000000000000", {
      headers: authHeaders,
    });
    expect(unknown.status).toBe(404);
  });

  it("sending_access keys can POST /emails but not GET (fixture 37 semantics)", async () => {
    const app = createApp(makeDeps());
    const post = await app.request("/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESTRICTED_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: "a@d.co", to: ["x@y.co"], subject: "s", html: "<p>h</p>" }),
    });
    expect(post.status).toBe(200);

    const get = await app.request(`/emails/${SENT_EMAIL.emailId}`, {
      headers: { Authorization: `Bearer ${RESTRICTED_TOKEN}` },
    });
    expect(get.status).toBe(401);
    expect(((await get.json()) as { name: string }).name).toBe("restricted_api_key");
  });
});

describe("webhooks surface (§5.13 shapes)", () => {
  const authHeaders = {
    Authorization: `Bearer ${VALID_TOKEN}`,
    "content-type": "application/json",
  };

  it("creates with 201 {object,id,signing_secret} and hides the secret in lists", async () => {
    const app = createApp(makeDeps());
    const created = await app.request("/webhooks", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ endpoint: "https://example.com/hooks", events: ["email.sent"] }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as Record<string, unknown>;
    expect(body.object).toBe("webhook");
    expect(String(body.signing_secret)).toMatch(/^whsec_/);

    const list = await app.request("/webhooks", { headers: authHeaders });
    const listBody = (await list.json()) as { data: Array<Record<string, unknown>> };
    expect(listBody.data[0]).not.toHaveProperty("signing_secret");
    expect(listBody.data[0]).toMatchObject({
      endpoint: "https://example.com/hooks",
      status: "enabled",
    });
  });

  it("get includes the retrievable signing_secret; patch/delete return envelopes", async () => {
    const app = createApp(makeDeps());
    const id = WEBHOOK_ENDPOINT.endpointId;
    const got = await app.request(`/webhooks/${id}`, { headers: authHeaders });
    expect(((await got.json()) as { signing_secret: string }).signing_secret).toMatch(/^whsec_/);

    const patched = await app.request(`/webhooks/${id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ status: "disabled" }),
    });
    expect(await patched.json()).toEqual({ object: "webhook", id });

    const deleted = await app.request(`/webhooks/${id}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(await deleted.json()).toEqual({ object: "webhook", id, deleted: true });
  });

  it("rejects unknown event types", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/webhooks", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ endpoint: "https://example.com/h", events: ["email.exploded"] }),
    });
    expect(response.status).toBe(422);
  });
});

describe("session principal", () => {
  const activeSession = {
    session: { activeOrganizationId: "team-1" },
    user: { id: "user-1" },
  };

  it("accepts a session whose active organization membership still exists", async () => {
    const app = createApp(makeDeps({ auth: fakeAuth(activeSession, true) }));
    const response = await app.request("/api-keys");
    expect(response.status).toBe(200);
  });

  it("rejects a session whose membership was removed (stale activeOrganizationId)", async () => {
    const app = createApp(makeDeps({ auth: fakeAuth(activeSession, false) }));
    const response = await app.request("/api-keys");
    expect(response.status).toBe(401);
    expect(((await response.json()) as { name: string }).name).toBe("missing_api_key");
  });
});

describe("OAuth bearer principals", () => {
  // Stub verifier: the real JWT verification is covered by the core
  // integration flow test; here we pin the middleware's routing of a
  // JWT-shaped bearer into a Principal.
  const SEND_JWT = "eyJzdHViIjoxfQ.send.sig";
  const FULL_JWT = "eyJzdHViIjoxfQ.full.sig";
  const oauthTokens = async (token: string) => {
    if (token === SEND_JWT) return { teamId: "team-1", permission: "sending_access" as const };
    if (token === FULL_JWT) return { teamId: "team-1", permission: "full_access" as const };
    return null;
  };

  it("an emails:send-scoped JWT can send but not read (fixture 37 semantics)", async () => {
    const app = createApp(makeDeps({ oauthTokens }));
    const post = await app.request("/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${SEND_JWT}`, "content-type": "application/json" },
      body: JSON.stringify({ from: "a@d.co", to: ["x@y.co"], subject: "s", html: "<p>h</p>" }),
    });
    expect(post.status).toBe(200);

    const get = await app.request(`/emails/${SENT_EMAIL.emailId}`, {
      headers: { Authorization: `Bearer ${SEND_JWT}` },
    });
    expect(get.status).toBe(401);
    expect(((await get.json()) as { name: string }).name).toBe("restricted_api_key");
  });

  it("a full_access-scoped JWT reaches admin routes", async () => {
    const app = createApp(makeDeps({ oauthTokens }));
    const response = await app.request("/domains", {
      headers: { Authorization: `Bearer ${FULL_JWT}` },
    });
    expect(response.status).toBe(200);
  });

  it("an unverifiable JWT is the same 400 as a bad key", async () => {
    const app = createApp(makeDeps({ oauthTokens }));
    const response = await app.request("/domains", {
      headers: { Authorization: "Bearer eyJhbGciOiJub25lIn0.forged.token" },
    });
    expect(response.status).toBe(400);
  });

  it("JWT-shaped bearers fall through to key verification when OAuth is not wired", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/domains", {
      headers: { Authorization: `Bearer ${FULL_JWT}` },
    });
    expect(response.status).toBe(400);
  });
});

describe("OAuth discovery + MCP handshake", () => {
  it("serves protected-resource metadata with wildcard CORS", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/.well-known/oauth-protected-resource");
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.resource).toBe("http://localhost");
    expect(body.authorization_servers).toEqual(["http://localhost/auth"]);
    expect(body.scopes_supported).toContain("emails:send");
  });

  it("forwards the RFC 8414 root alias to the auth handler", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/.well-known/oauth-authorization-server/auth");
    expect(response.status).toBe(200);
    // fakeAuth's handler marker: proves the request reached better-auth.
    expect(await response.text()).toBe("auth");
  });

  it("advertises resource metadata on unauthenticated /mcp calls", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/mcp", { method: "POST" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="http://localhost/.well-known/oauth-protected-resource"',
    );
  });
});

describe("OAuth grants surface (x-internal)", () => {
  const activeSession = {
    session: { activeOrganizationId: "team-1" },
    user: { id: "user-1" },
  };

  it("lists grants for the session user's active team", async () => {
    const app = createApp(makeDeps({ auth: fakeAuth(activeSession, true) }));
    const response = await app.request("/internal/oauth-grants");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      object: string;
      data: Array<Record<string, unknown>>;
    };
    expect(body.object).toBe("list");
    expect(body.data[0]).toMatchObject({
      id: "consent-1",
      client_id: "client-1",
      client_name: "Test App",
      scopes: ["emails:send"],
    });
  });

  it("rejects API-key principals — grants are user-scoped", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/internal/oauth-grants", {
      headers: { Authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(response.status).toBe(401);
  });

  it("revokes a grant and 404s on unknown ids", async () => {
    const app = createApp(makeDeps({ auth: fakeAuth(activeSession, true) }));
    const ok = await app.request("/internal/oauth-grants/consent-1/revoke", { method: "POST" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: "consent-1", revoked: true });

    const missing = await app.request("/internal/oauth-grants/nope/revoke", { method: "POST" });
    expect(missing.status).toBe(404);
  });
});

describe("bootstrap surface", () => {
  it("reports status and creates the first admin through the service", async () => {
    const app = createApp(makeDeps());
    const status = await app.request("/internal/bootstrap");
    expect(await status.json()).toEqual({ needs_bootstrap: true });

    const created = await app.request("/internal/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: "t",
        email: "a@b.co",
        password: "password123",
        name: "Admin",
      }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ user_id: "user-1" });
  });

  it("rejects missing fields with 422", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/internal/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "t" }),
    });
    expect(response.status).toBe(422);
  });
});

describe("audiences + contacts surface — fixtures 13, 16-23", () => {
  const authHeaders = {
    Authorization: `Bearer ${VALID_TOKEN}`,
    "content-type": "application/json",
  };

  async function replayMarketing(app: ReturnType<typeof createApp>, name: string, body?: unknown) {
    const fx = fixture(name);
    const init: RequestInit = { method: fx.request.method, headers: authHeaders };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await app.request(fx.request.path, init);
    expect(response.status, name).toBe(fx.response.status);
    expect(normalizeTimestamps(await response.json()), name).toEqual(
      normalizeTimestamps(fx.response.body),
    );
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    return response;
  }

  it("replays the full capture sequence with byte-exact bodies", async () => {
    const mkt = fakeMarketing();
    const app = createApp(makeDeps(marketingDeps(mkt)));

    // 13 list (only General exists yet) -> object:"list", one summary item.
    await replayMarketing(app, "13-list-audiences.json");
    // 16 create audience -> 201 {object:"audience", id, name} (no created_at).
    await replayMarketing(app, "16-create-audience.json", { name: "fixture-temp-audience" });
    // 17 get audience -> full detail incl. created_at.
    await replayMarketing(app, "17-get-audience.json");
    // 18 create contact -> 201 {object:"contact", id}.
    await replayMarketing(app, "18-create-contact.json", {
      email: "fixture-contact@example.com",
      first_name: "Fixture",
      last_name: "Contact",
      unsubscribed: false,
    });
    // 19 get contact -> detail with properties:{}.
    await replayMarketing(app, "19-get-contact.json");
    // 20 list contacts -> list items carry NO object and NO properties.
    await replayMarketing(app, "20-list-contacts.json");
    // 21 patch contact -> 200 {object:"contact", id}.
    await replayMarketing(app, "21-update-contact.json", { first_name: "FixtureUpdated" });
    // 22 delete contact -> the `contact` field quirk.
    await replayMarketing(app, "22-delete-contact.json");
    // 23 delete audience -> {object:"audience", id, deleted:true}.
    await replayMarketing(app, "23-delete-audience.json");
  });

  it('segments surface serves the SAME record with object:"segment"', async () => {
    const mkt = fakeMarketing();
    const app = createApp(makeDeps(marketingDeps(mkt)));
    const response = await app.request(`/segments/${AUDIENCE_GENERAL.segmentId}`, {
      headers: authHeaders,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: "segment",
      id: AUDIENCE_GENERAL.segmentId,
      name: "General",
      created_at: "2025-12-05 13:23:51.056000+00",
    });
  });

  it("resolves a contact by email as well as by id", async () => {
    const mkt = fakeMarketing();
    mkt.state.segments.set(TEMP_AUDIENCE_ID, {
      segmentId: TEMP_AUDIENCE_ID,
      teamId: "team-1",
      name: "fixture-temp-audience",
      createdAt: TEMP_AUDIENCE_CREATED,
    });
    mkt.state.contacts.set(FIXTURE_CONTACT_ID, {
      contactId: FIXTURE_CONTACT_ID,
      teamId: "team-1",
      segmentId: TEMP_AUDIENCE_ID,
      email: "fixture-contact@example.com",
      firstName: "Fixture",
      lastName: "Contact",
      unsubscribed: false,
      createdAt: FIXTURE_CONTACT_CREATED,
    });
    const app = createApp(makeDeps(marketingDeps(mkt)));
    const byEmail = await app.request(
      `/audiences/${TEMP_AUDIENCE_ID}/contacts/fixture-contact@example.com`,
      { headers: authHeaders },
    );
    expect(byEmail.status).toBe(200);
    expect((await byEmail.json()) as { id: string }).toMatchObject({ id: FIXTURE_CONTACT_ID });
  });
});

describe("broadcasts surface", () => {
  const authHeaders = {
    Authorization: `Bearer ${VALID_TOKEN}`,
    "content-type": "application/json",
  };

  it("creates (audience_id alias), gets, lists, patches, sends, deletes", async () => {
    const mkt = fakeMarketing();
    const app = createApp(makeDeps(marketingDeps(mkt)));

    const created = await app.request("/broadcasts", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        audience_id: AUDIENCE_GENERAL.segmentId,
        from: "news@example.net",
        subject: "Launch",
        html: "<p>hi</p>",
      }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { object: string; id: string };
    expect(id).toBeTruthy();

    const got = await app.request(`/broadcasts/${id}`, { headers: authHeaders });
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({
      object: "broadcast",
      id,
      audience_id: AUDIENCE_GENERAL.segmentId,
      from: "news@example.net",
      subject: "Launch",
      status: "draft",
      reply_to: null,
      sent_at: null,
    });

    const list = await app.request("/broadcasts", { headers: authHeaders });
    const listBody = (await list.json()) as { object: string; data: Array<{ id: string }> };
    expect(listBody.object).toBe("list");
    expect(listBody.data[0]?.id).toBe(id);

    const patched = await app.request(`/broadcasts/${id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ subject: "Launch v2" }),
    });
    expect(await patched.json()).toEqual({ object: "broadcast", id });

    const sent = await app.request(`/broadcasts/${id}/send`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    expect(await sent.json()).toEqual({ object: "broadcast", id });
    expect(mkt.state.sends).toEqual([{ broadcastId: id, teamId: "team-1" }]);
    expect(mkt.state.broadcasts.get(id)?.status).toBe("sending");

    const del = await app.request(`/broadcasts/${id}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(await del.json()).toEqual({ object: "broadcast", id, deleted: true });
  });

  it("schedules a send and records the resolved instant", async () => {
    const mkt = fakeMarketing();
    const app = createApp(makeDeps(marketingDeps(mkt)));
    const created = await app.request("/broadcasts", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        segment_id: AUDIENCE_GENERAL.segmentId,
        from: "news@example.net",
        subject: "Later",
      }),
    });
    const { id } = (await created.json()) as { id: string };
    const sent = await app.request(`/broadcasts/${id}/send`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ scheduled_at: "2026-08-09T18:00:00.000Z" }),
    });
    expect(sent.status).toBe(200);
    expect(mkt.state.broadcasts.get(id)?.status).toBe("scheduled");
    expect(mkt.state.sends[0]).toMatchObject({
      broadcastId: id,
      scheduledAt: "2026-08-09T18:00:00.000Z",
    });
  });

  it("rejects a broadcast create without an audience", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/broadcasts", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ from: "a@b.co", subject: "x" }),
    });
    expect(response.status).toBe(422);
  });

  it("rejects a broadcast targeting an audience the team does not own", async () => {
    const app = createApp(makeDeps(marketingDeps(fakeMarketing())));
    const response = await app.request("/broadcasts", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        // A well-formed UUID that is not in this team's segment set.
        audience_id: "99999999-9999-4999-8999-999999999999",
        from: "news@example.net",
        subject: "Cross-tenant attempt",
      }),
    });
    expect(response.status).toBe(404);
  });
});

describe("public unsubscribe surface (RFC 8058)", () => {
  function seedContact(mkt: MarketingFake, unsubscribed = false) {
    mkt.state.contacts.set(FIXTURE_CONTACT_ID, {
      contactId: FIXTURE_CONTACT_ID,
      teamId: "team-1",
      segmentId: AUDIENCE_GENERAL.segmentId,
      email: "fixture-contact@example.com",
      unsubscribed,
      createdAt: FIXTURE_CONTACT_CREATED,
    });
  }

  it("POST /:token one-click unsubscribes with NO auth and is idempotent", async () => {
    const mkt = fakeMarketing();
    seedContact(mkt);
    const app = createApp(makeDeps(marketingDeps(mkt)));
    const token = signUnsubscribeToken(
      {
        contactId: FIXTURE_CONTACT_ID,
        segmentId: AUDIENCE_GENERAL.segmentId,
        broadcastId: "f0000000-0000-4000-8000-000000000001",
      },
      UNSUBSCRIBE_SECRET,
    );

    const post = await app.request(`/unsubscribe/${token}`, {
      method: "POST",
      body: "List-Unsubscribe=One-Click",
    });
    expect(post.status).toBe(204);
    expect(mkt.state.contacts.get(FIXTURE_CONTACT_ID)?.unsubscribed).toBe(true);

    // Idempotent: a second click still succeeds.
    const again = await app.request(`/unsubscribe/${token}`, { method: "POST" });
    expect(again.status).toBe(204);
  });

  it("GET /:token renders an HTML landing and marks unsubscribed", async () => {
    const mkt = fakeMarketing();
    seedContact(mkt);
    const app = createApp(makeDeps(marketingDeps(mkt)));
    const token = signUnsubscribeToken(
      {
        contactId: FIXTURE_CONTACT_ID,
        segmentId: AUDIENCE_GENERAL.segmentId,
        broadcastId: "f0000000-0000-4000-8000-000000000001",
      },
      UNSUBSCRIBE_SECRET,
    );
    const response = await app.request(`/unsubscribe/${token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain("unsubscribed");
    expect(mkt.state.contacts.get(FIXTURE_CONTACT_ID)?.unsubscribed).toBe(true);
  });

  it("rejects an invalid token via the error seam", async () => {
    const mkt = fakeMarketing();
    seedContact(mkt);
    const app = createApp(makeDeps(marketingDeps(mkt)));
    const response = await app.request("/unsubscribe/not-a-valid-token");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { name: string }).name).toBe("not_found");
  });
});

describe("skeleton surface", () => {
  it("still serves the public spec and health", async () => {
    const app = createApp(makeDeps());
    const spec = await app.request("/openapi.json");
    expect(spec.status).toBe(200);
    const health = await app.request("/health");
    expect(await health.json()).toEqual({ status: "ok" });
  });
});
