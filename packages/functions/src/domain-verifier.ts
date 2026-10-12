import { createDomainsService } from "./context.js";
import { logger, recordMetric, withObservability } from "./observability.js";
import { withSentry } from "./sentry.js";

/** 10-minute cron: re-check every non-terminal domain (SPEC §7). */
async function handlerImpl(): Promise<void> {
  const refreshed = await createDomainsService().refreshAllPending();
  if (refreshed > 0) {
    recordMetric("domains_verified", refreshed);
    logger.info("refreshed domains", { refreshed });
  }
}

export const handler = withSentry(withObservability(handlerImpl));
