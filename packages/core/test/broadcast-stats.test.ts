import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EmailEntity, SuppressionEntity } from "../src/adapters/dynamo-entities.js";
import type { BroadcastStatKey } from "../src/broadcasts/broadcasts.js";
import { EventProcessorService } from "../src/events/processor.js";
import type { SesEventDetail } from "../src/events/ses-mapping.js";

/**
 * Broadcast stats roll up from delivery events (SPEC §11): a delivered SES
 * event for an email tagged with a broadcastId increments that broadcast's
 * `delivered` counter, exactly once (gated on the emitter's dedupe).
 */

const delivery: SesEventDetail = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/ses-events/delivery.json"), "utf8"),
);

function fakeEmails(email: Record<string, unknown>): EmailEntity {
  // outboundEmailEventData needs the wire fields; inject defaults so callers
  // only specify what the test cares about (status, broadcastId).
  const full = {
    from: "broadcast@test.example.com",
    to: ["r@example.com"],
    subject: "Campaign",
    createdAt: "2026-08-09T12:00:00.000Z",
    ...email,
  };
  return {
    query: {
      bySesMessageId: () => ({ go: async () => ({ data: [full] }) }),
    },
    get: () => ({ go: async () => ({ data: full }) }),
    patch: () => ({ set: () => ({ go: async () => ({}) }) }),
  } as unknown as EmailEntity;
}

const noSuppressions = {} as unknown as SuppressionEntity;

describe("broadcast stats roll up from delivery events", () => {
  it("increments the matching broadcast stat once when emitted", async () => {
    const calls: Array<{ broadcastId: string; statKey: BroadcastStatKey }> = [];
    const processor = new EventProcessorService({
      emails: fakeEmails({
        emailId: "e1",
        teamId: "team-1",
        status: "sent",
        direction: "outbound",
        broadcastId: "bc-1",
      }),
      suppressions: noSuppressions,
      emitter: { emit: async () => true },
      broadcasts: {
        incrementStat: async (broadcastId, statKey) => {
          calls.push({ broadcastId, statKey });
        },
      },
      clock: () => new Date("2026-08-10T00:00:00.000Z"),
    });

    const result = await processor.processSesEvent(delivery);
    expect(result).toBe("processed");
    expect(calls).toEqual([{ broadcastId: "bc-1", statKey: "delivered" }]);
  });

  it("does not increment when the emitter dedupes a redelivered event", async () => {
    const calls: Array<{ broadcastId: string; statKey: BroadcastStatKey }> = [];
    const processor = new EventProcessorService({
      emails: fakeEmails({
        emailId: "e1",
        teamId: "team-1",
        status: "delivered",
        direction: "outbound",
        broadcastId: "bc-1",
      }),
      suppressions: noSuppressions,
      // emit returns false => this exact event was already processed.
      emitter: { emit: async () => false },
      broadcasts: {
        incrementStat: async (broadcastId, statKey) => {
          calls.push({ broadcastId, statKey });
        },
      },
      clock: () => new Date("2026-08-10T00:00:00.000Z"),
    });

    await processor.processSesEvent(delivery);
    expect(calls).toEqual([]);
  });

  it("skips the roll-up for a non-broadcast email", async () => {
    const calls: Array<{ broadcastId: string; statKey: BroadcastStatKey }> = [];
    const processor = new EventProcessorService({
      emails: fakeEmails({
        emailId: "e1",
        teamId: "team-1",
        status: "sent",
        direction: "outbound",
      }),
      suppressions: noSuppressions,
      emitter: { emit: async () => true },
      broadcasts: {
        incrementStat: async (broadcastId, statKey) => {
          calls.push({ broadcastId, statKey });
        },
      },
      clock: () => new Date("2026-08-10T00:00:00.000Z"),
    });

    await processor.processSesEvent(delivery);
    expect(calls).toEqual([]);
  });
});
