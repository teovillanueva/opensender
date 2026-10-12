import { createEmailsService } from "./context.js";
import { logger, withObservability } from "./observability.js";
import { withSentry } from "./sentry.js";

const emails = createEmailsService();

/** EventBridge Scheduler target (SPEC §10): one invocation per due email. */
async function handlerImpl(event: { emailId?: string }): Promise<void> {
  if (!event.emailId) {
    logger.error("missing emailId in payload");
    return;
  }
  const outcome = await emails.sendScheduled(event.emailId);
  logger.info("scheduled send", { emailId: event.emailId, outcome });
}

export const handler = withSentry(withObservability(handlerImpl));
