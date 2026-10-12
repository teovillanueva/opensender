import {
  createEmailEntity,
  createSuppressionEntity,
  EventProcessorService,
  type SesEventDetail,
} from "@opensender/core";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import {
  clock,
  createBroadcastsService,
  createEventsService,
  createReputationService,
  dynamo,
  table,
} from "./context.js";
import { logger, recordMetric, withObservability } from "./observability.js";
import { withSentry } from "./sentry.js";

/** SES delivery-side event types worth a dedicated EMF counter (SPEC §15). */
const METRIC_BY_SES_EVENT: Record<string, string> = {
  Delivery: "deliveries",
  Bounce: "bounces",
  Complaint: "complaints",
};

const processor = new EventProcessorService({
  emails: createEmailEntity({ client: dynamo, table }),
  suppressions: createSuppressionEntity({ client: dynamo, table }),
  emitter: createEventsService(),
  // Delivery events roll up into broadcast stats when the email is a broadcast.
  broadcasts: createBroadcastsService(),
  // Bounces/complaints feed the reputation auto-freeze (SPEC §12).
  reputation: createReputationService(),
  clock,
});

/** SQS consumer for the SES EventBridge rule (SPEC §8.1). */
async function handlerImpl(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: Array<{ itemIdentifier: string }> = [];
  for (const record of event.Records) {
    try {
      const envelope = JSON.parse(record.body) as { detail?: SesEventDetail };
      if (!envelope.detail?.eventType || !envelope.detail.mail) {
        logger.warn("skipping non-SES message");
        continue;
      }
      const { eventType, mail } = envelope.detail;
      // Compact event log: type + SES message id only (avoid CloudWatch ingest cost of full payloads).
      logger.info("ses event", { eventType, messageId: mail.messageId });
      const metricName = METRIC_BY_SES_EVENT[eventType];
      if (metricName) recordMetric(metricName);
      await processor.processSesEvent(envelope.detail);
    } catch (error) {
      logger.error("event-processor failure", { error });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}

export const handler = withSentry(withObservability(handlerImpl));
