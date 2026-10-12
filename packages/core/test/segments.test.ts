import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSegmentEntity } from "../src/adapters/dynamo-entities.js";
import { SegmentsService } from "../src/segments/segments.js";
import { type LocalDynamo, startLocalDynamo } from "./helpers/ddb-local.js";

let dynamo: LocalDynamo;

beforeAll(async () => {
  dynamo = await startLocalDynamo();
}, 120_000);

afterAll(async () => {
  await dynamo.stop();
});

let clockSeq = 0;
function makeService() {
  return new SegmentsService({
    segments: createSegmentEntity({ client: dynamo.client, table: dynamo.table }),
    emitter: { emit: async () => true },
    // Monotonic clock so createdAt ordering is deterministic.
    clock: () => new Date(Date.UTC(2026, 7, 9, 10, 0, ++clockSeq)),
    idGenerator: () => randomUUID(),
  });
}

describe("segments service (DynamoDB-Local)", () => {
  it("creates, gets team-scoped, and lists newest-first", async () => {
    const service = makeService();
    const first = await service.create({ teamId: "team-seg", name: "First" });
    const second = await service.create({ teamId: "team-seg", name: "Second" });

    expect(await service.get("team-seg", first.segmentId)).toMatchObject({ name: "First" });
    // A different team cannot read the segment.
    expect(await service.get("other-team", first.segmentId)).toBeUndefined();

    const listed = await service.list("team-seg");
    expect(listed.map((s) => s.segmentId)).toEqual([second.segmentId, first.segmentId]);
  });

  it("renames and deletes", async () => {
    const service = makeService();
    const segment = await service.create({ teamId: "team-seg2", name: "Old" });

    const renamed = await service.updateName(segment, "New");
    expect(renamed.name).toBe("New");
    expect(await service.get("team-seg2", segment.segmentId)).toMatchObject({ name: "New" });

    await service.delete(segment.segmentId);
    expect(await service.get("team-seg2", segment.segmentId)).toBeUndefined();
  });
});
