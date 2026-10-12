import type { WebhookDeliveryEntity } from "../adapters/dynamo-entities.js";
import { SafeFetchError, safeFetch } from "../http/safe-fetch.js";
import type { Clock, IdGenerator } from "../ports.js";
import { signWebhookPayload } from "./signing.js";
import type { WebhooksService } from "./webhooks.js";

/**
 * webhook-dispatcher (SPEC §8.3): Svix-identical headers, 10s timeout,
 * SSRF-guarded POST, per-attempt WebhookDelivery log, circuit breaker via
 * consecutive-failure count on the endpoint. Retry pacing happens in the
 * SQS layer (visibility timeout per receive count).
 */

export interface DeliveryMessage {
  endpointId: string;
  svixId: string;
  type: string;
  body: string;
}

/** Resend-documented schedule: immediately, 5s, 5m, 30m, 2h, 5h, 10h, 10h. */
export const RETRY_DELAY_SECONDS = [5, 300, 1800, 7200, 18_000, 36_000, 36_000];
const DELIVERY_TTL_SECONDS = 90 * 24 * 60 * 60;
const DISPATCH_TIMEOUT_MS = 10_000;

export type DispatchOutcome =
  | { outcome: "success"; statusCode: number }
  | { outcome: "failure"; disabled: boolean }
  | { outcome: "dropped" };

export interface DispatcherDeps {
  webhooks: Pick<
    WebhooksService,
    "getEndpointById" | "recordDeliveryFailure" | "recordDeliverySuccess"
  >;
  deliveries: WebhookDeliveryEntity;
  clock: Clock;
  idGenerator: IdGenerator;
}

export class WebhookDispatchService {
  constructor(private readonly deps: DispatcherDeps) {}

  async dispatch(message: DeliveryMessage, attempt: number): Promise<DispatchOutcome> {
    const endpoint = await this.deps.webhooks.getEndpointById(message.endpointId);
    if (!endpoint || endpoint.status === "disabled") return { outcome: "dropped" };

    const now = this.deps.clock();
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const signature = signWebhookPayload(
      endpoint.signingSecret,
      message.svixId,
      timestampSeconds,
      message.body,
    );

    const startedAt = Date.now();
    let statusCode: number | undefined;
    let errorMessage: string | undefined;
    try {
      const response = await safeFetch(endpoint.endpoint, {
        method: "POST",
        timeoutMs: DISPATCH_TIMEOUT_MS,
        maxBytes: 1024 * 1024,
        headers: {
          "content-type": "application/json",
          "svix-id": message.svixId,
          "svix-timestamp": String(timestampSeconds),
          "svix-signature": signature,
        },
        body: message.body,
      });
      statusCode = response.status ?? 200;
    } catch (error) {
      errorMessage =
        error instanceof SafeFetchError || error instanceof Error
          ? error.message
          : "delivery failed";
    }

    const success = statusCode !== undefined;
    await this.deps.deliveries
      .create({
        endpointId: endpoint.endpointId,
        deliveryId: this.deps.idGenerator(),
        svixId: message.svixId,
        type: message.type,
        attempt,
        ...(statusCode === undefined ? {} : { statusCode }),
        durationMs: Date.now() - startedAt,
        outcome: success ? "success" : "failure",
        ...(errorMessage === undefined ? {} : { error: errorMessage.slice(0, 500) }),
        payload: message.body,
        createdAt: now.toISOString(),
        _ttl: timestampSeconds + DELIVERY_TTL_SECONDS,
      })
      .go();

    if (success) {
      await this.deps.webhooks.recordDeliverySuccess(endpoint.endpointId);
      return { outcome: "success", statusCode: statusCode as number };
    }
    const disabled = await this.deps.webhooks.recordDeliveryFailure(endpoint.endpointId);
    return { outcome: "failure", disabled };
  }

  async listDeliveries(endpointId: string, limit: number) {
    const result = await this.deps.deliveries.query
      .byEndpoint({ endpointId })
      .go({ limit, order: "desc" });
    return result.data;
  }
}
