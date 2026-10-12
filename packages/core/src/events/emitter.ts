import type { EmailEventEntity } from "../adapters/dynamo-entities.js";
import type { Clock, IdGenerator, QueuePublisher } from "../ports.js";
import type { WebhookEndpoint, WebhooksService } from "../webhooks/webhooks.js";

/**
 * Domain event emission (SPEC §8.2): persists the per-email timeline row and
 * fans one webhook-delivery message out per subscribed enabled endpoint.
 * Envelope `{ type, created_at, data }`; webhook timestamps are ISO 8601
 * (docs examples), unlike REST's Postgres style.
 */

export interface DomainEvent {
  type: string;
  data: Record<string, unknown>;
  /** Present for email.* events — keys the timeline row. */
  emailId?: string;
  /** Deterministic id makes redelivered source events emit exactly once. */
  eventId?: string;
}

export interface EventsServiceDeps {
  events: EmailEventEntity;
  webhooks: Pick<WebhooksService, "listEndpoints">;
  deliveries: QueuePublisher;
  clock: Clock;
  idGenerator: IdGenerator;
}

/** How long a team's cached endpoint list is trusted before refetching. */
const ENDPOINTS_CACHE_TTL_MS = 30_000;

interface EndpointsCacheEntry {
  endpoints: WebhookEndpoint[];
  expiresAt: number;
}

export class EventsService {
  // Container-scoped memo of each team's full endpoint list, keyed by teamId.
  // Endpoint edits (create/update/delete) may take up to ENDPOINTS_CACHE_TTL_MS
  // to be reflected here — accepted staleness in exchange for avoiding a
  // fresh byTeam query on every single emitted event.
  private readonly endpointsCache = new Map<string, EndpointsCacheEntry>();

  constructor(private readonly deps: EventsServiceDeps) {}

  private async subscribedEndpoints(teamId: string, eventType: string): Promise<WebhookEndpoint[]> {
    const now = this.deps.clock().getTime();
    const cached = this.endpointsCache.get(teamId);
    const endpoints =
      cached && cached.expiresAt > now
        ? cached.endpoints
        : await this.refreshEndpointsCache(teamId, now);
    return endpoints.filter(
      (endpoint) => endpoint.status === "enabled" && endpoint.events.includes(eventType),
    );
  }

  private async refreshEndpointsCache(teamId: string, now: number): Promise<WebhookEndpoint[]> {
    const endpoints = await this.deps.webhooks.listEndpoints(teamId);
    // Only cache a NON-EMPTY list. Caching "no endpoints" would hide a team's
    // first endpoint for the whole TTL: any event emitted before it is created
    // (a domain event, an earlier send) would populate an empty entry, and the
    // endpoint created moments later would miss events until the entry expired.
    // Teams that actually generate event storms have endpoints, so they still
    // hit the cache; zero-endpoint teams simply re-query (a cheap empty read).
    if (endpoints.length > 0) {
      this.endpointsCache.set(teamId, { endpoints, expiresAt: now + ENDPOINTS_CACHE_TTL_MS });
    }
    return endpoints;
  }

  /** Returns false when a deterministic event was already emitted. */
  async emit(teamId: string, event: DomainEvent): Promise<boolean> {
    const occurredAt = this.deps.clock().toISOString();
    const eventId = event.eventId ?? this.deps.idGenerator();

    if (event.emailId) {
      try {
        await this.deps.events
          .create({
            emailId: event.emailId,
            eventId,
            type: event.type,
            occurredAt,
            payload: event.data,
          })
          .go();
      } catch (error) {
        // create() is conditional on the key; a collision means this exact
        // event was already processed — do not fan out twice.
        if (event.eventId) return false;
        throw error;
      }
    }

    const endpoints = await this.subscribedEndpoints(teamId, event.type);
    if (endpoints.length === 0) return true;

    const body = JSON.stringify({ type: event.type, created_at: occurredAt, data: event.data });
    for (const endpoint of endpoints) {
      await this.deps.deliveries.enqueue({
        endpointId: endpoint.endpointId,
        // svix-id is stable across retries of the same message (R02 §4).
        svixId: `msg_${eventId}_${endpoint.endpointId}`,
        type: event.type,
        body,
      });
    }
    return true;
  }
}
