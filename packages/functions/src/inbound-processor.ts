import { createEmailEntity, InboundService } from "@opensender/core";
import {
  clock,
  createAttachmentsBlobStore,
  createDomainsService,
  createEventsService,
  createInboundBlobStore,
  dynamo,
  table,
} from "./context.js";
import { logger, recordMetric, withObservability } from "./observability.js";
import { withSentry } from "./sentry.js";

/** SES receipt-rule Lambda action event (R03 §6.4). */
interface SesReceiptEvent {
  Records: Array<{
    ses: {
      mail: { messageId: string; destination: string[] };
      receipt: {
        recipients: string[];
        action: { bucketName?: string; objectKey?: string };
        spamVerdict?: { status: string };
        virusVerdict?: { status: string };
        spfVerdict?: { status: string };
        dkimVerdict?: { status: string };
        dmarcVerdict?: { status: string };
      };
    };
  }>;
}

const inbound = new InboundService({
  emails: createEmailEntity({ client: dynamo, table }),
  // Attachment bodies go to the AttachmentsBucket (where the receiving route
  // presigns download URLs); only the raw MIME stays in the InboundBucket.
  blobs: createAttachmentsBlobStore(),
  domains: createDomainsService(),
  emitter: createEventsService(),
  clock,
  idGenerator: () => crypto.randomUUID(),
});

/** Reads the raw MIME from inbound-raw (the body is never in the event). */
async function handlerImpl(event: SesReceiptEvent): Promise<void> {
  const blobs = createInboundBlobStore();
  for (const record of event.Records) {
    const { mail, receipt } = record.ses;
    const objectKey = receipt.action.objectKey ?? mail.messageId;
    const rawMime = await blobs.get(objectKey);
    if (!rawMime) {
      logger.error("no S3 object for inbound message", { objectKey });
      continue;
    }
    const stored = await inbound.process({
      messageId: mail.messageId,
      recipients: receipt.recipients ?? mail.destination ?? [],
      rawMime,
      verdicts: Object.fromEntries(
        Object.entries({
          spamVerdict: receipt.spamVerdict?.status,
          virusVerdict: receipt.virusVerdict?.status,
          spfVerdict: receipt.spfVerdict?.status,
          dkimVerdict: receipt.dkimVerdict?.status,
          dmarcVerdict: receipt.dmarcVerdict?.status,
        }).filter(([, v]) => v !== undefined),
      ),
    });
    if (stored) {
      recordMetric("inbound_received");
      logger.info("stored inbound email", { emailId: stored.emailId });
    } else {
      logger.info("dropped inbound message (no inbound-enabled recipient)", {
        messageId: mail.messageId,
      });
    }
  }
}

export const handler = withSentry(withObservability(handlerImpl));
