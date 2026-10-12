import type { SegmentEntity } from "../adapters/dynamo-entities.js";
import type { EventsService } from "../events/emitter.js";
import type { Clock, IdGenerator } from "../ports.js";

/**
 * Segments are the audience primitive (SPEC §11). `/segments` and the
 * deprecated `/audiences` alias serve the same records; the object label is a
 * wire concern applied by the route, not stored here.
 */
export interface Segment {
  segmentId: string;
  teamId: string;
  name: string;
  createdAt: string;
}

export interface SegmentsServiceDeps {
  segments: SegmentEntity;
  emitter: Pick<EventsService, "emit">;
  clock: Clock;
  idGenerator: IdGenerator;
}

export class SegmentsService {
  constructor(private readonly deps: SegmentsServiceDeps) {}

  async create(input: { teamId: string; name: string }): Promise<Segment> {
    const record: Segment = {
      segmentId: this.deps.idGenerator(),
      teamId: input.teamId,
      name: input.name,
      createdAt: this.deps.clock().toISOString(),
    };
    await this.deps.segments.create(record).go();
    return record;
  }

  async get(teamId: string, segmentId: string): Promise<Segment | undefined> {
    const result = await this.deps.segments.get({ segmentId }).go();
    const segment = result.data ?? undefined;
    return segment && segment.teamId === teamId ? segment : undefined;
  }

  async list(teamId: string): Promise<Segment[]> {
    const result = await this.deps.segments.query.byTeam({ teamId }).go({ pages: "all" });
    return result.data.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async updateName(segment: Segment, name: string): Promise<Segment> {
    await this.deps.segments.patch({ segmentId: segment.segmentId }).set({ name }).go();
    return { ...segment, name };
  }

  async delete(segmentId: string): Promise<void> {
    await this.deps.segments.delete({ segmentId }).go();
  }
}
