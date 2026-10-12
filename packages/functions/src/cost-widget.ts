import { type CostBreakdown, costByService } from "./cost-query.js";
import { withObservability } from "./observability.js";
import { withSentry } from "./sentry.js";

/**
 * CloudWatch custom-widget backend (SPEC §15): renders THIS instance's spend
 * (tag-filtered `app=opensender`) as an HTML table on the ops dashboard — the
 * opensender-only counterpart to the account-wide native "Estimated charges"
 * widget, which CloudWatch cannot tag-filter. Reuses the exact Cost Explorer
 * query the weekly cost report uses (`cost-query.ts`) so the two never drift.
 *
 * Shows month-to-date so the figure is meaningful regardless of the dashboard's
 * time picker (Cost Explorer granularity is daily, not sub-day). Requires the
 * `app` cost-allocation tag activated in Billing (one-time, ~24h); until then
 * the query returns no rows and the widget says so.
 *
 * Custom widgets are invoked by the CloudWatch console with the viewer's own
 * IAM credentials and must return an HTML string; when `event.describe` is set,
 * they return Markdown documentation instead.
 */

interface WidgetEvent {
  describe?: boolean;
}

const DESCRIPTION = [
  "## opensender cost (month-to-date)",
  "Instance-only AWS spend, filtered by the `app=opensender` cost-allocation tag",
  "via Cost Explorer. Unlike the native billing widget this excludes every other",
  "resource in the account. Requires the `app` tag activated in Billing.",
].join("\n");

const money = (n: number): string => `$${n.toFixed(2)}`;

function renderHtml(b: CostBreakdown | undefined): string {
  if (!b) {
    return "<p>Cost Explorer is not enabled yet — enable it once in Billing; data appears ~24h later.</p>";
  }
  if (b.services.length === 0) {
    return "<p>No <code>app=opensender</code> cost data yet — activate the <code>app</code> cost-allocation tag in Billing (one-time, ~24h).</p>";
  }
  const rows = b.services
    .slice(0, 15)
    .map(
      (s) =>
        `<tr><td style="padding:2px 16px 2px 0">${s.service}</td>` +
        `<td style="text-align:right">${money(s.amount)}</td></tr>`,
    )
    .join("");
  return [
    `<h1 style="margin:0 0 2px;font-size:24px">${money(b.total)}</h1>`,
    `<p style="margin:0 0 10px;color:#888;font-size:12px">opensender only · ${b.start} – ${b.end} (month-to-date)</p>`,
    `<table style="border-collapse:collapse;font-size:13px">${rows}</table>`,
  ].join("");
}

async function handlerImpl(event: WidgetEvent): Promise<string> {
  if (event?.describe) return DESCRIPTION;
  const now = new Date();
  // Month-to-date. Cost Explorer's End is exclusive, so extend one day past
  // today to include the current day's partial spend.
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
  const end = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  try {
    return renderHtml(await costByService(start, end));
  } catch {
    return "<p>Failed to load cost data.</p>";
  }
}

export const handler = withSentry(withObservability<WidgetEvent, string>(handlerImpl));
