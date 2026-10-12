import { parseTenantStatusEvent } from "@opensender/core";
import type { EventBridgeEvent } from "aws-lambda";
import { createAlertPublisher, createTeamsService } from "./context.js";
import { logger, withObservability } from "./observability.js";
import { withSentry } from "./sentry.js";

/**
 * SES tenant sending-status handler (SPEC §12). EventBridge invokes this
 * directly (not via SQS) on "Sending Status Enabled/Disabled". A DISABLED
 * event freezes the owning team so sends are rejected with a clear error; an
 * ENABLED/REINSTATED event restores it. Every transition alerts the operator.
 */
const teams = createTeamsService();
const alerts = createAlertPublisher();

async function handlerImpl(event: EventBridgeEvent<string, unknown>): Promise<void> {
  const parsed = parseTenantStatusEvent(event);
  if (!parsed) {
    logger.warn("skipping non-tenant or malformed event");
    return;
  }

  const team = await teams.getTeamByTenantName(parsed.tenantName);
  if (!team) {
    // A tenant with no matching Team — alert rather than silently drop, since a
    // real pause we can't act on is exactly what the operator must know about.
    logger.error("no team for tenant", {
      tenantName: parsed.tenantName,
      sesStatus: parsed.sesStatus,
    });
    await alerts.publish(
      `SES tenant ${parsed.tenantName} ${parsed.sesStatus} — no matching team`,
      `SES reported sending status ${parsed.sesStatus} (origin ${parsed.origin}) for tenant ` +
        `${parsed.tenantName}, but no team owns that tenant. Investigate manually.`,
    );
    return;
  }

  if (team.status === parsed.status) {
    logger.info("team already in target status", { teamId: team.teamId, status: parsed.status });
    return;
  }

  await teams.setStatus(team.teamId, parsed.status);
  logger.warn("team status changed by SES", {
    teamId: team.teamId,
    status: parsed.status,
    sesStatus: parsed.sesStatus,
  });
  await alerts.publish(
    `Team ${team.teamId} ${parsed.status === "frozen" ? "frozen" : "restored"} by SES`,
    [
      `Team ${team.teamId} ("${team.name}") is now ${parsed.status}.`,
      `SES sending status: ${parsed.sesStatus} (origin ${parsed.origin}).`,
      parsed.status === "frozen"
        ? "Sends are now rejected. Re-enable the tenant in SES once the issue is resolved."
        : "Sending has been restored.",
    ].join("\n"),
  );
}

export const handler = withSentry(withObservability(handlerImpl));
