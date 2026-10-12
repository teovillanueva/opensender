import type { Broadcast, Contact, Segment, StoredEmail } from "@opensender/core";
import { describe, expect, it } from "vitest";
import type { AppDeps } from "../src/index.js";
import { createApp } from "../src/index.js";

/**
 * MCP server conformance (SPEC §14). Drives the Streamable HTTP endpoint with
 * raw JSON-RPC over `app.request()` — stateless mode needs no `initialize`
 * handshake, so a `tools/list` / `tools/call` POST is answered directly.
 */

const VALID_TOKEN = "re_validvalidvalidvalidvalidvalid1";
const RESTRICTED_TOKEN = "re_restrictedrestrictedrestricted1";
const SEGMENT_ID = "b3412b39-6587-4d5f-8e5f-6205044d7b72";
const DOMAIN_ID = "db88ac50-bb8c-4970-96e0-9e869ba8a150";

function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const emails = new Map<string, StoredEmail>();
  const events = new Map<string, Array<{ type: string; occurredAt: string }>>();
  const segments = new Map<string, Segment>([
    [
      SEGMENT_ID,
      {
        segmentId: SEGMENT_ID,
        teamId: "team-1",
        name: "General",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  ]);
  const contacts = new Map<string, Contact>();
  const broadcasts = new Map<string, Broadcast>();
  const sends: Array<{ broadcastId: string; scheduledAt?: string }> = [];
  let usage = { daily: 3, monthly: 9 };
  let sendCounter = 0;
  let rateCounter = 0;
  const notImplemented = () => {
    throw new Error("not under test");
  };

  return {
    apiKeys: {
      verifyToken: async (token: string) => {
        if (token === VALID_TOKEN)
          return { keyId: "k1", teamId: "team-1", permission: "full_access" as const };
        if (token === RESTRICTED_TOKEN)
          return { keyId: "k2", teamId: "team-1", permission: "sending_access" as const };
        return undefined;
      },
      createKey: notImplemented,
      listKeys: async () => [],
      deleteKey: async () => false,
    },
    teams: {
      createTeam: notImplemented,
      getTeam: async (teamId) => ({
        teamId,
        name: "Team",
        sesTenantName: `team-${teamId}`,
        plan: "default",
        status: "active" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      quotasFor: () => ({ dailyEmailLimit: 1_000, apiRateLimitPerSecond: 10 }),
    },
    rateLimiter: {
      consume: async (_teamId, limit) => {
        rateCounter += 1;
        return {
          allowed: rateCounter <= limit,
          limit,
          remaining: Math.max(0, limit - rateCounter),
          resetSeconds: 1,
        };
      },
    },
    domains: {
      createDomain: async (input) => {
        const domain = {
          domainId: DOMAIN_ID,
          teamId: input.teamId,
          name: input.name.toLowerCase(),
          region: "us-east-1",
          status: "not_started" as const,
          clickTracking: input.clickTracking ?? false,
          openTracking: input.openTracking ?? false,
          tls: "opportunistic" as const,
          inboundEnabled: false,
          dkimTokens: ["t1"],
          signingHostedZone: "dkim.amazonses.com",
          configurationSetName: "domain-x",
          dkimStatus: "NOT_STARTED",
          mailFromStatus: "NOT_STARTED",
          createdAt: "2026-01-01T00:00:00.000Z",
        };
        return domain;
      },
      getDomain: async (teamId, id) =>
        id === DOMAIN_ID
          ? {
              domainId: DOMAIN_ID,
              teamId,
              name: "acme.com",
              region: "us-east-1",
              status: "pending" as const,
              clickTracking: false,
              openTracking: false,
              tls: "opportunistic" as const,
              inboundEnabled: false,
              dkimTokens: ["t1"],
              signingHostedZone: "dkim.amazonses.com",
              configurationSetName: "domain-x",
              dkimStatus: "PENDING",
              mailFromStatus: "PENDING",
              createdAt: "2026-01-01T00:00:00.000Z",
            }
          : undefined,
      listDomains: async (teamId) => [
        {
          domainId: DOMAIN_ID,
          teamId,
          name: "acme.com",
          region: "us-east-1",
          status: "verified" as const,
          clickTracking: false,
          openTracking: false,
          tls: "opportunistic" as const,
          inboundEnabled: false,
          dkimTokens: ["t1"],
          signingHostedZone: "dkim.amazonses.com",
          configurationSetName: "domain-x",
          dkimStatus: "SUCCESS",
          mailFromStatus: "SUCCESS",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      recordsFor: () => [
        {
          record: "DKIM",
          name: "t1._domainkey",
          type: "CNAME",
          ttl: "Auto",
          status: "not_started",
          value: "t1.dkim.amazonses.com",
        },
      ],
      requestVerification: async (domain) => ({ ...domain, status: "pending" as const }),
      refreshVerification: async (domain) => domain,
      updateDomain: async (domain) => domain,
      setInboundEnabled: async (domain) => domain,
      deleteDomain: async () => {},
    },
    emails: {
      send: async (teamId, request) => {
        sendCounter += 1;
        const emailId = `00000000-0000-4000-8000-${String(sendCounter).padStart(12, "0")}`;
        const status = request.scheduledAt ? ("scheduled" as const) : ("sent" as const);
        const email: StoredEmail = {
          emailId,
          teamId,
          direction: "outbound",
          from: request.from,
          to: request.to,
          subject: request.subject,
          ...(request.html === undefined ? {} : { html: request.html }),
          status,
          createdAt: "2026-08-08T17:58:15.369Z",
        };
        emails.set(emailId, email);
        events.set(emailId, [
          { type: "email.queued", occurredAt: "2026-08-08T17:58:15.369Z" },
          { type: "email.sent", occurredAt: "2026-08-08T17:58:16.000Z" },
        ]);
        usage = { daily: usage.daily + 1, monthly: usage.monthly + 1 };
        return { email, usage };
      },
      getEmail: async (_teamId, id) => emails.get(id),
      getInboundEmail: async () => undefined,
      listEmails: async () => ({ emails: [...emails.values()], cursor: null }),
      listEmailsByCursor: async () => ({ emails: [...emails.values()], hasMore: false }),
      listEvents: async (_teamId, id) => events.get(id) ?? [],
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
    segments: {
      create: notImplemented,
      get: async (teamId, id) => {
        const record = segments.get(id);
        return record && record.teamId === teamId ? record : undefined;
      },
      list: async (teamId) => [...segments.values()].filter((s) => s.teamId === teamId),
      updateName: notImplemented,
      delete: notImplemented,
    },
    contacts: {
      create: async (input) => {
        const record: Contact = {
          contactId: "e46e5d30-2fba-402f-881e-0b49a7d5f9cb",
          teamId: input.teamId,
          segmentId: input.segmentId,
          email: input.email.toLowerCase(),
          ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
          ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
          unsubscribed: input.unsubscribed ?? false,
          createdAt: "2026-01-01T00:00:00.000Z",
        };
        contacts.set(record.contactId, record);
        return record;
      },
      getByIdOrEmail: async (teamId, segmentId, idOrEmail) => {
        const needle = idOrEmail.toLowerCase();
        return [...contacts.values()].find(
          (c) =>
            c.teamId === teamId &&
            c.segmentId === segmentId &&
            (c.contactId === idOrEmail || c.email === needle),
        );
      },
      list: async (segmentId) => [...contacts.values()].filter((c) => c.segmentId === segmentId),
      listSendable: async (segmentId) =>
        [...contacts.values()].filter((c) => c.segmentId === segmentId && !c.unsubscribed),
      update: notImplemented,
      setUnsubscribed: async (contact, unsubscribed) => {
        const updated = { ...contact, unsubscribed };
        contacts.set(contact.contactId, updated);
        return updated;
      },
      delete: notImplemented,
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
          createdAt: "2026-01-01T00:00:00.000Z",
        };
        broadcasts.set(record.broadcastId, record);
        return record;
      },
      get: async (teamId, id) => {
        const record = broadcasts.get(id);
        return record && record.teamId === teamId ? record : undefined;
      },
      list: async (teamId) => [...broadcasts.values()].filter((b) => b.teamId === teamId),
      update: notImplemented,
      delete: notImplemented,
      markStatus: async (id, status) => {
        const record = broadcasts.get(id);
        if (record) broadcasts.set(id, { ...record, status });
      },
      setSchedule: async (id, scheduledAt) => {
        const record = broadcasts.get(id);
        if (record) broadcasts.set(id, { ...record, scheduledAt, status: "scheduled" });
      },
      setPendingPages: async () => {},
      completePage: async () => 0,
      incrementStat: async () => {},
    },
    broadcastSender: {
      send: async (broadcastId, _teamId, scheduledAt) => {
        sends.push({ broadcastId, ...(scheduledAt === undefined ? {} : { scheduledAt }) });
      },
    },
    unsubscribeContacts: {
      getById: async () => undefined,
      setUnsubscribed: async (contact, unsubscribed) => ({ ...contact, unsubscribed }),
    },
    unsubscribeSecret: "unsub-test-secret",
    webhookReplay: { enqueue: async () => {} },
    webhooks: {
      createEndpoint: notImplemented,
      getEndpoint: async () => undefined,
      listEndpoints: async () => [],
      updateEndpoint: async () => {},
      deleteEndpoint: async () => {},
      listDeliveries: async () => ({ deliveries: [], cursor: null }),
      getDelivery: async () => undefined,
    },
    idempotency: {
      claim: async () => ({ kind: "claimed" as const }),
      complete: async () => {},
      release: async () => {},
    },
    quotaUsage: async () => usage,
    now: () => new Date("2026-08-08T17:58:15.369Z"),
    auth: {
      handler: async () => new Response("auth", { status: 200 }),
      api: { getSession: async () => null },
      $context: Promise.resolve({ adapter: { findOne: async () => null } }),
    } as unknown as AppDeps["auth"],
    oauthGrants: {
      listGrants: async () => [],
      revokeGrant: async () => false,
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

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ text: string }>;
    isError?: boolean;
    resources?: Array<{ name: string }>;
  };
  error?: { code: number; message: string };
}

async function rpc(
  app: ReturnType<typeof createApp>,
  method: string,
  params: unknown,
  token = VALID_TOKEN,
  id = 1,
): Promise<Response> {
  return app.request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

async function body(response: Response): Promise<JsonRpcResponse> {
  const parsed = await response.json();
  return (Array.isArray(parsed) ? parsed[0] : parsed) as JsonRpcResponse;
}

async function callTool(
  app: ReturnType<typeof createApp>,
  name: string,
  args: unknown,
  token = VALID_TOKEN,
): Promise<JsonRpcResponse> {
  return body(await rpc(app, "tools/call", { name, arguments: args }, token));
}

describe("MCP server", () => {
  it("lists every tool for a full-access key", async () => {
    const app = createApp(makeDeps());
    const result = await body(await rpc(app, "tools/list", {}));
    const names = (result.result?.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "add_contact",
        "create_broadcast",
        "create_domain",
        "get_email",
        "get_usage_stats",
        "list_domains",
        "list_emails",
        "list_segments",
        "send_broadcast",
        "send_email",
        "unsubscribe_contact",
        "verify_domain",
      ].sort(),
    );
  });

  it("sends an email then shows its timeline via get_email", async () => {
    const app = createApp(makeDeps());
    const sent = await callTool(app, "send_email", {
      from: "hi@acme.com",
      to: "user@example.com",
      subject: "Hello",
      html: "<p>Hi</p>",
    });
    expect(sent.result?.isError).toBeFalsy();
    const text = sent.result?.content?.[0]?.text ?? "";
    const id = text.match(/id=([0-9a-f-]+)/)?.[1];
    expect(id).toBeTruthy();

    const got = await callTool(app, "get_email", { id });
    const summary = JSON.parse(got.result?.content?.[0]?.text ?? "{}");
    expect(summary.id).toBe(id);
    expect(summary.status).toBe("sent");
    expect(summary.timeline.map((e: { type: string }) => e.type)).toContain("email.sent");
  });

  it("exposes the openapi.json resource to every key", async () => {
    const app = createApp(makeDeps());
    const full = await body(await rpc(app, "resources/list", {}));
    expect((full.result?.resources ?? []).map((r) => r.name)).toContain("openapi");
    const restricted = await body(await rpc(app, "resources/list", {}, RESTRICTED_TOKEN));
    expect((restricted.result?.resources ?? []).map((r) => r.name)).toContain("openapi");
  });

  it("create_domain returns DNS records for the agent", async () => {
    const app = createApp(makeDeps());
    const created = await callTool(app, "create_domain", { name: "acme.com" });
    const payload = JSON.parse(created.result?.content?.[0]?.text ?? "{}");
    expect(payload.id).toBe(DOMAIN_ID);
    expect(payload.records[0].value).toContain("dkim.amazonses.com");
  });

  it("restricts a sending_access key to send_email only", async () => {
    const app = createApp(makeDeps());
    const result = await body(await rpc(app, "tools/list", {}, RESTRICTED_TOKEN));
    const names = (result.result?.tools ?? []).map((t) => t.name);
    expect(names).toEqual(["send_email"]);
  });

  it("rejects an admin tool called directly by a sending_access key", async () => {
    const app = createApp(makeDeps());
    const result = await callTool(app, "list_domains", {}, RESTRICTED_TOKEN);
    // Unknown tool for this principal → JSON-RPC error, not a successful result.
    expect(result.error ?? result.result?.isError).toBeTruthy();
  });

  it("still lets a sending_access key send_email", async () => {
    const app = createApp(makeDeps());
    const result = await callTool(
      app,
      "send_email",
      {
        from: "hi@acme.com",
        to: "user@example.com",
        subject: "Hello",
        text: "Hi",
      },
      RESTRICTED_TOKEN,
    );
    expect(result.result?.isError).toBeFalsy();
    expect(result.result?.content?.[0]?.text).toContain("id=");
  });

  it("returns 405 on GET /mcp", async () => {
    const app = createApp(makeDeps());
    const response = await app.request("/mcp", { method: "GET" });
    expect(response.status).toBe(405);
  });

  it("rate limits MCP calls per team", async () => {
    const app = createApp(
      makeDeps({
        teams: {
          ...makeDeps().teams,
          quotasFor: () => ({ dailyEmailLimit: 1_000, apiRateLimitPerSecond: 2 }),
        },
      }),
    );
    const first = await rpc(app, "tools/list", {});
    const second = await rpc(app, "tools/list", {});
    const third = await rpc(app, "tools/list", {});
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });
});
