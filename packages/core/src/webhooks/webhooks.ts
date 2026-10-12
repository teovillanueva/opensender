import type { WebhookDeliveryEntity, WebhookEndpointEntity } from "../adapters/dynamo-entities.js";
import type { Clock, IdGenerator } from "../ports.js";
import { generateSigningSecret } from "./signing.js";

export interface WebhookEndpoint {
  endpointId: string;
  teamId: string;
  endpoint: string;
  events: string[];
  signingSecret: string;
  status: "enabled" | "disabled";
  consecutiveFailures: number;
  createdAt: string;
}

/** Consecutive delivery failures before the breaker disables the endpoint. */
const CIRCUIT_BREAKER_THRESHOLD = 20;

/** One row of an endpoint's delivery log (SPEC §5.13, dashboard §13.6). */
export interface WebhookDelivery {
  deliveryId: string;
  svixId: string;
  type: string;
  attempt: number;
  statusCode?: number;
  durationMs?: number;
  outcome: "success" | "failure";
  error?: string;
  payload: string;
  createdAt: string;
}

export interface WebhooksServiceDeps {
  endpoints: WebhookEndpointEntity;
  /** Delivery log store; absent on the dispatcher-only construction that
   * writes deliveries through its own entity (the API construction sets it). */
  deliveries?: WebhookDeliveryEntity;
  clock: Clock;
  idGenerator: IdGenerator;
}

export class WebhooksService {
  constructor(private readonly deps: WebhooksServiceDeps) {}

  async createEndpoint(input: {
    teamId: string;
    endpoint: string;
    events: string[];
  }): Promise<WebhookEndpoint> {
    const record: WebhookEndpoint = {
      endpointId: this.deps.idGenerator(),
      teamId: input.teamId,
      endpoint: input.endpoint,
      events: input.events,
      signingSecret: generateSigningSecret(),
      status: "enabled",
      consecutiveFailures: 0,
      createdAt: this.deps.clock().toISOString(),
    };
    await this.deps.endpoints.create(record).go();
    return record;
  }

  async getEndpoint(teamId: string, endpointId: string): Promise<WebhookEndpoint | undefined> {
    const result = await this.deps.endpoints.get({ endpointId }).go();
    const endpoint = result.data ?? undefined;
    return endpoint && endpoint.teamId === teamId ? endpoint : undefined;
  }

  /** Dispatcher-side lookup: no team scoping, the queue message is trusted. */
  async getEndpointById(endpointId: string): Promise<WebhookEndpoint | undefined> {
    const result = await this.deps.endpoints.get({ endpointId }).go();
    return result.data ?? undefined;
  }

  async listEndpoints(teamId: string): Promise<WebhookEndpoint[]> {
    const result = await this.deps.endpoints.query.byTeam({ teamId }).go({ pages: "all" });
    return result.data.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Enabled endpoints subscribed to the event type — the fan-out set. */
  async subscribedEndpoints(teamId: string, eventType: string): Promise<WebhookEndpoint[]> {
    const all = await this.listEndpoints(teamId);
    return all.filter(
      (endpoint) => endpoint.status === "enabled" && endpoint.events.includes(eventType),
    );
  }

  async updateEndpoint(
    endpoint: WebhookEndpoint,
    patch: { endpoint?: string; events?: string[]; status?: "enabled" | "disabled" },
  ): Promise<void> {
    await this.deps.endpoints
      .patch({ endpointId: endpoint.endpointId })
      .set({
        ...(patch.endpoint === undefined ? {} : { endpoint: patch.endpoint }),
        ...(patch.events === undefined ? {} : { events: patch.events }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        // Re-enabling (or repointing) an endpoint resets the breaker.
        ...(patch.status === "enabled" || patch.endpoint !== undefined
          ? { consecutiveFailures: 0 }
          : {}),
      })
      .go();
  }

  async deleteEndpoint(endpointId: string): Promise<void> {
    await this.deps.endpoints.delete({ endpointId }).go();
  }

  /** Returns true when this failure tripped the breaker (SPEC §8.3). */
  async recordDeliveryFailure(endpointId: string): Promise<boolean> {
    const result = await this.deps.endpoints
      .patch({ endpointId })
      .add({ consecutiveFailures: 1 })
      .go({ response: "all_new" });
    const failures = result.data?.consecutiveFailures ?? 0;
    if (failures >= CIRCUIT_BREAKER_THRESHOLD) {
      await this.deps.endpoints.patch({ endpointId }).set({ status: "disabled" }).go();
      return true;
    }
    return false;
  }

  async recordDeliverySuccess(endpointId: string): Promise<void> {
    const result = await this.deps.endpoints.get({ endpointId }).go();
    if ((result.data?.consecutiveFailures ?? 0) === 0) return;
    await this.deps.endpoints.patch({ endpointId }).set({ consecutiveFailures: 0 }).go();
  }

  /**
   * One page of an endpoint's delivery log, newest-first, with the opaque
   * DynamoDB cursor to page on (SPEC §13.6). Callers must verify endpoint
   * ownership (via getEndpoint) before exposing this — it is endpoint-scoped.
   */
  async listDeliveries(
    endpointId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ deliveries: WebhookDelivery[]; cursor: string | null }> {
    if (!this.deps.deliveries) return { deliveries: [], cursor: null };
    const result = await this.deps.deliveries.query
      .byEndpoint({ endpointId })
      .go({ limit, order: "desc", ...(cursor ? { cursor } : {}) });
    return { deliveries: result.data as WebhookDelivery[], cursor: result.cursor ?? null };
  }

  /** One delivery-log row, scoped to its endpoint (SPEC §13.6, replay). */
  async getDelivery(endpointId: string, deliveryId: string): Promise<WebhookDelivery | undefined> {
    if (!this.deps.deliveries) return undefined;
    const result = await this.deps.deliveries.query.byEndpoint({ endpointId }).go({ pages: "all" });
    return (result.data as WebhookDelivery[]).find((d) => d.deliveryId === deliveryId);
  }
}
