import type { BroadcastEntity } from "../adapters/dynamo-entities.js";
import type { EventsService } from "../events/emitter.js";
import type { Clock, IdGenerator } from "../ports.js";

export type BroadcastStatus = "draft" | "scheduled" | "sending" | "sent" | "canceled";

/** Aggregate counter keys incremented as SES events land (SPEC §8.1). */
export type BroadcastStatKey =
  | "sent"
  | "delivered"
  | "delivery_delayed"
  | "bounced"
  | "complained"
  | "failed"
  | "opened"
  | "clicked"
  | "unsubscribed";

const ZERO_STATS: Record<BroadcastStatKey, number> = {
  sent: 0,
  delivered: 0,
  delivery_delayed: 0,
  bounced: 0,
  complained: 0,
  failed: 0,
  opened: 0,
  clicked: 0,
  unsubscribed: 0,
};

/**
 * A broadcast is a segment-targeted campaign (SPEC §11). The html/text template
 * is stored inline — broadcast bodies are small, so there is no S3 blob seam.
 */
export interface Broadcast {
  broadcastId: string;
  teamId: string;
  segmentId: string;
  from: string;
  subject: string;
  replyTo?: string | undefined;
  name?: string | undefined;
  html?: string | undefined;
  text?: string | undefined;
  status: BroadcastStatus;
  scheduledAt?: string | undefined;
  scheduleArn?: string | undefined;
  pendingPages?: number | undefined;
  stats?: Record<string, number> | undefined;
  createdAt: string;
}

export interface BroadcastsServiceDeps {
  broadcasts: BroadcastEntity;
  emitter?: Pick<EventsService, "emit"> | undefined;
  clock: Clock;
  idGenerator: IdGenerator;
}

export class BroadcastsService {
  constructor(private readonly deps: BroadcastsServiceDeps) {}

  async create(input: {
    teamId: string;
    segmentId: string;
    from: string;
    subject: string;
    html?: string | undefined;
    text?: string | undefined;
    name?: string | undefined;
    replyTo?: string | undefined;
  }): Promise<Broadcast> {
    const broadcast: Broadcast = {
      broadcastId: this.deps.idGenerator(),
      teamId: input.teamId,
      segmentId: input.segmentId,
      from: input.from,
      subject: input.subject,
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.html === undefined ? {} : { html: input.html }),
      ...(input.text === undefined ? {} : { text: input.text }),
      status: "draft",
      stats: { ...ZERO_STATS },
      createdAt: this.deps.clock().toISOString(),
    };
    await this.deps.broadcasts
      .create({
        broadcastId: broadcast.broadcastId,
        teamId: broadcast.teamId,
        segmentId: broadcast.segmentId,
        from: broadcast.from,
        subject: broadcast.subject,
        ...(broadcast.replyTo === undefined ? {} : { replyTo: broadcast.replyTo }),
        ...(broadcast.name === undefined ? {} : { name: broadcast.name }),
        ...(broadcast.html === undefined ? {} : { html: broadcast.html }),
        ...(broadcast.text === undefined ? {} : { text: broadcast.text }),
        status: broadcast.status,
        stats: { ...ZERO_STATS },
        createdAt: broadcast.createdAt,
      })
      .go();
    return broadcast;
  }

  async get(teamId: string, broadcastId: string): Promise<Broadcast | undefined> {
    const result = await this.deps.broadcasts.get({ broadcastId }).go();
    const broadcast = result.data ?? undefined;
    return broadcast && broadcast.teamId === teamId ? (broadcast as Broadcast) : undefined;
  }

  async list(teamId: string): Promise<Broadcast[]> {
    const result = await this.deps.broadcasts.query.byTeam({ teamId }).go({ pages: "all" });
    return (result.data as Broadcast[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async update(
    broadcast: Broadcast,
    patch: {
      segmentId?: string | undefined;
      from?: string | undefined;
      subject?: string | undefined;
      replyTo?: string | undefined;
      name?: string | undefined;
      html?: string | undefined;
      text?: string | undefined;
    },
  ): Promise<Broadcast> {
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
    await this.deps.broadcasts
      .patch({ broadcastId: broadcast.broadcastId })
      .set({
        ...(patch.segmentId === undefined ? {} : { segmentId: patch.segmentId }),
        ...(patch.from === undefined ? {} : { from: patch.from }),
        ...(patch.subject === undefined ? {} : { subject: patch.subject }),
        ...(patch.replyTo === undefined ? {} : { replyTo: patch.replyTo }),
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.html === undefined ? {} : { html: patch.html }),
        ...(patch.text === undefined ? {} : { text: patch.text }),
      })
      .go();
    return updated;
  }

  async delete(broadcastId: string): Promise<void> {
    await this.deps.broadcasts.delete({ broadcastId }).go();
  }

  async markStatus(broadcastId: string, status: BroadcastStatus): Promise<void> {
    await this.deps.broadcasts.patch({ broadcastId }).set({ status }).go();
  }

  async setSchedule(broadcastId: string, scheduledAt: string, scheduleArn?: string): Promise<void> {
    await this.deps.broadcasts
      .patch({ broadcastId })
      .set({
        scheduledAt,
        status: "scheduled",
        ...(scheduleArn === undefined ? {} : { scheduleArn }),
      })
      .go();
  }

  /** Record how many fan-out pages are outstanding before the send completes. */
  async setPendingPages(broadcastId: string, pages: number): Promise<void> {
    await this.deps.broadcasts.patch({ broadcastId }).set({ pendingPages: pages }).go();
  }

  /**
   * Atomically decrement the outstanding-page counter and return the new value.
   * The page that drives it to <=0 is responsible for the `sent` transition.
   */
  async completePage(broadcastId: string): Promise<number> {
    const result = await this.deps.broadcasts
      .patch({ broadcastId })
      .data((attr, op) => {
        op.subtract(attr.pendingPages, 1);
      })
      .go({ response: "all_new" });
    return (result.data as { pendingPages?: number }).pendingPages ?? 0;
  }

  /** Atomic increment on a fixed nested counter (initialized to 0 at create). */
  async incrementStat(broadcastId: string, statKey: BroadcastStatKey): Promise<void> {
    await this.deps.broadcasts
      .patch({ broadcastId })
      .data((attr, op) => {
        op.add(attr.stats[statKey], 1);
      })
      .go();
  }
}
