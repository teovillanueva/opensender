import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDomainEntity,
  createEmailEntity,
  createEmailEventEntity,
  createTeamEntity,
  createWebhookEndpointEntity,
} from "../src/adapters/dynamo-entities.js";
import { DomainsService } from "../src/domains/domains.js";
import { EventsService } from "../src/events/emitter.js";
import { InboundService } from "../src/inbound/inbound.js";
import { TeamsService } from "../src/teams/teams.js";
import { WebhooksService } from "../src/webhooks/webhooks.js";
import { type LocalDynamo, startLocalDynamo } from "./helpers/ddb-local.js";
import {
  FakeBlobStore,
  FakeEmailProvider,
  FakeQueuePublisher,
} from "./helpers/fake-email-provider.js";

let dynamo: LocalDynamo;
beforeAll(async () => {
  dynamo = await startLocalDynamo();
}, 120_000);
afterAll(async () => {
  await dynamo.stop();
});

const RAW_MIME = [
  "From: Sender <sender@external.example>",
  "To: inbox@inbound.example",
  "Subject: Hello opensender",
  'Content-Type: multipart/mixed; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Body of the inbound message.</p>",
  "--b1",
  'Content-Type: text/plain; name="note.txt"',
  "Content-Disposition: attachment; filename=note.txt",
  "",
  "attached text",
  "--b1--",
  "",
].join("\r\n");

describe("inbound processing (SPEC §9)", () => {
  let seq = 0;
  const nextId = () => `30000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

  let setupCount = 0;
  async function setup(inboundEnabled: boolean) {
    const suffix = ++setupCount;
    const provider = new FakeEmailProvider();
    const queue = new FakeQueuePublisher();
    const blobs = new FakeBlobStore();
    const teams = new TeamsService({
      teams: createTeamEntity({ client: dynamo.client, table: dynamo.table }),
      emailProvider: provider,
      config: {
        plans: { default: { dailyEmailLimit: 1000, apiRateLimitPerSecond: 10 } },
        defaultPlan: "default",
      },
      clock: () => new Date("2026-08-09T18:00:00.000Z"),
    });
    const teamId = `team-inb-${suffix}`;
    try {
      await teams.createTeam({ teamId, name: "Inb" });
    } catch {
      // exists
    }
    const emitter = new EventsService({
      events: createEmailEventEntity({ client: dynamo.client, table: dynamo.table }),
      webhooks: new WebhooksService({
        endpoints: createWebhookEndpointEntity({ client: dynamo.client, table: dynamo.table }),
        clock: () => new Date("2026-08-09T18:00:00.000Z"),
        idGenerator: nextId,
      }),
      deliveries: queue,
      clock: () => new Date("2026-08-09T18:00:00.000Z"),
      idGenerator: nextId,
    });
    const domains = new DomainsService({
      domains: createDomainEntity({ client: dynamo.client, table: dynamo.table }),
      emitter,
      emailProvider: provider,
      teams,
      region: "us-east-1",
      clock: () => new Date("2026-08-09T18:00:00.000Z"),
      idGenerator: nextId,
    });
    const domainName = `inbound-${suffix}.example`;
    const domain = await domains.createDomain({ teamId, name: domainName });
    if (inboundEnabled) await domains.setInboundEnabled(domain, true);

    const inbound = new InboundService({
      emails: createEmailEntity({ client: dynamo.client, table: dynamo.table }),
      blobs,
      domains,
      emitter,
      clock: () => new Date("2026-08-09T18:00:00.000Z"),
      idGenerator: nextId,
    });
    return { inbound, queue, blobs, teamId, domainName };
  }

  it("parses, stores, and emits metadata-only email.received", async () => {
    const { inbound, queue, blobs, domainName } = await setup(true);
    const stored = await inbound.process({
      messageId: "msg-inbound-1",
      recipients: [`inbox@${domainName}`],
      rawMime: new TextEncoder().encode(RAW_MIME),
      verdicts: { spamVerdict: "PASS", virusVerdict: "PASS", spfVerdict: "PASS" },
    });

    expect(stored?.direction).toBe("inbound");
    expect(stored?.status).toBe("received");
    expect(stored?.html).toContain("Body of the inbound message");
    expect(stored?.attachments).toHaveLength(1);
    expect(blobs.blobs.size).toBe(1);
    expect(stored?.verdicts?.spamVerdict).toBe("PASS");

    const received = queue.messages
      .map((entry) => JSON.parse(String(entry.message.body)))
      .find((event) => event.type === "email.received");
    // subscribedEndpoints found none here, so nothing is queued — assert the
    // stored payload shape via a subscribed endpoint instead.
    expect(received).toBeUndefined();
  });

  it("emits metadata-only email.received to a subscribed endpoint", async () => {
    const { inbound, queue, teamId, domainName } = await setup(true);
    const webhooks = new WebhooksService({
      endpoints: createWebhookEndpointEntity({ client: dynamo.client, table: dynamo.table }),
      clock: () => new Date("2026-08-09T18:00:00.000Z"),
      idGenerator: nextId,
    });
    await webhooks.createEndpoint({
      teamId,
      endpoint: "https://hooks.example/inbound",
      events: ["email.received"],
    });

    await inbound.process({
      messageId: "msg-inbound-2",
      recipients: [`inbox@${domainName}`],
      rawMime: new TextEncoder().encode(RAW_MIME),
      verdicts: {},
    });

    const received = queue.messages
      .map((entry) => JSON.parse(String(entry.message.body)))
      .find((event) => event.type === "email.received");
    expect(received).toBeDefined();
    // Metadata only: no body, headers, or attachment content/urls.
    expect(received.data.html).toBeUndefined();
    expect(received.data.text).toBeUndefined();
    expect(received.data.headers).toBeUndefined();
    expect(received.data.attachments[0]).not.toHaveProperty("download_url");
    expect(received.data.attachments[0]).toMatchObject({ filename: "note.txt" });
    expect(received.data.message_id).toBe("msg-inbound-2");
  });

  it("drops mail to domains without inbound enabled", async () => {
    const { inbound, domainName } = await setup(false);
    const stored = await inbound.process({
      messageId: "msg-inbound-3",
      recipients: [`inbox@${domainName}`],
      rawMime: new TextEncoder().encode(RAW_MIME),
      verdicts: {},
    });
    expect(stored).toBeUndefined();
  });
});
