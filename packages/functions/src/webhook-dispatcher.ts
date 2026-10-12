import { ChangeMessageVisibilityCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  createWebhookDeliveryEntity,
  createWebhookEndpointEntity,
  type DeliveryMessage,
  RETRY_DELAY_SECONDS,
  WebhookDispatchService,
  WebhooksService,
} from "@opensender/core";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { clock, dynamo, table } from "./context.js";
import { logger, recordMetric, withObservability } from "./observability.js";
import { withSentry } from "./sentry.js";

const sqs = new SQSClient({});
const webhooks = new WebhooksService({
  endpoints: createWebhookEndpointEntity({ client: dynamo, table }),
  clock,
  idGenerator: () => crypto.randomUUID(),
});
const dispatcher = new WebhookDispatchService({
  webhooks,
  deliveries: createWebhookDeliveryEntity({ client: dynamo, table }),
  clock,
  idGenerator: () => crypto.randomUUID(),
});

/**
 * SQS consumer for webhook deliveries (SPEC §8.3). Failures re-queue with a
 * per-attempt visibility timeout approximating Resend's schedule; after
 * maxReceiveCount the message lands in the DLQ.
 */
async function handlerImpl(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records) {
    const attempt = Number(record.attributes.ApproximateReceiveCount ?? "1");
    let message: DeliveryMessage;
    try {
      message = JSON.parse(record.body) as DeliveryMessage;
    } catch {
      logger.error("malformed message dropped");
      continue;
    }
    const result = await dispatcher.dispatch(message, attempt);
    if (result.outcome !== "failure") {
      recordMetric("webhook_deliveries");
      continue;
    }
    recordMetric("webhook_failures");
    if (result.disabled) {
      logger.warn("circuit breaker disabled endpoint", { endpointId: message.endpointId });
      continue; // do not retry into a disabled endpoint
    }

    const delay = RETRY_DELAY_SECONDS[Math.min(attempt - 1, RETRY_DELAY_SECONDS.length - 1)];
    await sqs
      .send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: process.env.WEBHOOK_QUEUE_URL,
          ReceiptHandle: record.receiptHandle,
          VisibilityTimeout: delay,
        }),
      )
      .catch((error) => logger.error("visibility update failed", { error }));
    failures.push({ itemIdentifier: record.messageId });
  }
  return { batchItemFailures: failures };
}

export const handler = withSentry(withObservability(handlerImpl));
