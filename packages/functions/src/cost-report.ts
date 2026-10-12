import { createDomainEntity } from "@opensender/core";
import { instanceConfig } from "../../../instance.config.js";
import { createAlertPublisher, createEmailsService, dynamo, table } from "./context.js";
import { type CostBreakdown, costByService } from "./cost-query.js";
import { logger, withObservability } from "./observability.js";
import { withSentry } from "./sentry.js";

/**
 * Weekly cost report (SPEC §15): a cron queries Cost Explorer for the trailing
 * 7 days grouped by service and mails the per-service summary to the operator
 * **through the platform itself** (dogfooding) — sent from the instance's own
 * verified domain via the ordinary EmailsService pipeline. If no verified
 * domain exists yet (fresh instance) or the send is rejected, it falls back to
 * the OpsAlerts SNS topic so the operator still receives the report.
 *
 * Scope: the query (`cost-query.ts`) is filtered to `app=opensender` (the global
 * cost-allocation tag on every resource) so the summary reflects ONLY this
 * instance's spend, never the rest of the account. The tag must be activated as
 * a cost-allocation tag in Billing first (one-time, ~24h) — until then the tag
 * filter matches no records and the report is empty.
 */

/** Trailing-7-day unblended cost per AWS service. */
async function weeklyCostBreakdown(): Promise<CostBreakdown | undefined> {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86_400_000);
  return costByService(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
}

function renderReport(b: CostBreakdown): { subject: string; text: string; html: string } {
  const money = (n: number) => `$${n.toFixed(2)}`;
  const rows = b.services.slice(0, 15);
  const subject = `opensender weekly cost: ${money(b.total)} (${b.start} – ${b.end})`;
  const text = [
    `AWS cost for ${b.start} to ${b.end}`,
    `Total: ${money(b.total)}`,
    "",
    ...rows.map((s) => `  ${s.service}: ${money(s.amount)}`),
  ].join("\n");
  const html = [
    `<h2>opensender weekly cost</h2>`,
    `<p>${b.start} – ${b.end} &middot; <strong>${money(b.total)}</strong> total</p>`,
    "<table cellpadding='4'>",
    ...rows.map((s) => `<tr><td>${s.service}</td><td align='right'>${money(s.amount)}</td></tr>`),
    "</table>",
  ].join("");
  return { subject, text, html };
}

/** Dogfood: send from the instance's own verified domain via EmailsService. */
async function sendThroughPlatform(report: {
  subject: string;
  text: string;
  html: string;
}): Promise<boolean> {
  // Send only from an OPERATOR-owned domain (the instance domain or a subdomain
  // of it) — never a random customer tenant's domain, which would send from
  // their identity and pollute their quota/reputation counters. If none is
  // verified yet, fall back to SNS.
  const scan = await createDomainEntity({ client: dynamo, table }).scan.go({ pages: "all" });
  const owned = (d: { name: string }) =>
    d.name === instanceConfig.domain || d.name.endsWith(`.${instanceConfig.domain}`);
  const verified = (scan.data as Array<{ teamId: string; name: string; status: string }>).find(
    (d) => d.status === "verified" && owned(d),
  );
  if (!verified) return false;
  await createEmailsService().send(
    verified.teamId,
    {
      from: `noreply@${verified.name}`,
      to: [instanceConfig.alertEmail],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: report.subject,
      html: report.html,
      text: report.text,
      headers: {},
      tags: [{ name: "type", value: "cost-report" }],
      attachments: [],
    },
    { enforceSync: true },
  );
  return true;
}

async function handlerImpl(): Promise<void> {
  const breakdown = await weeklyCostBreakdown();
  if (!breakdown) return;
  if (breakdown.services.length === 0) {
    // No tagged spend — most likely the `app` cost-allocation tag isn't
    // activated in Billing yet (one-time, ~24h). Skip the empty report.
    logger.info("no app=opensender cost data yet (activate the cost-allocation tag)");
    return;
  }
  const report = renderReport(breakdown);

  const sent = await sendThroughPlatform(report).catch((error) => {
    logger.error("failed to send cost report via platform", { error });
    return false;
  });
  if (sent) {
    logger.info("cost report sent through the platform", { total: breakdown.total });
    return;
  }
  // Fallback: no verified domain yet, or the send was rejected.
  await createAlertPublisher().publish(report.subject, report.text);
  logger.warn("cost report delivered via SNS fallback");
}

export const handler = withSentry(withObservability(handlerImpl));
