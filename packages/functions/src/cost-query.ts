import {
  CostExplorerClient,
  type Expression,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer";
import { logger } from "./observability.js";

/**
 * Shared Cost Explorer query for the instance's own spend (SPEC §15). Both the
 * weekly cost report (`cost-report.ts`, email) and the live dashboard cost
 * widget (`cost-widget.ts`) call this, so the two views never drift: identical
 * `app=opensender` tag filter, identical per-service grouping.
 *
 * Cost Explorer must be enabled once per account and its data appears ~24h
 * later [R09]; until then the query throws and callers log + skip.
 */

const ce = new CostExplorerClient({});

/** Restrict every cost query to THIS instance's resources via the global tag. */
const OPENSENDER_TAG_FILTER: Expression = {
  Tags: { Key: "app", Values: ["opensender"], MatchOptions: ["EQUALS"] },
};

export interface CostBreakdown {
  services: Array<{ service: string; amount: number }>;
  total: number;
  start: string;
  end: string;
}

/**
 * Unblended cost per AWS service for the half-open range [startStr, endStr)
 * (dates `YYYY-MM-DD`; Cost Explorer's `End` is exclusive). Returns `undefined`
 * when Cost Explorer is unavailable; an empty `services` array means the query
 * ran but no `app=opensender`-tagged spend exists yet.
 */
export async function costByService(
  startStr: string,
  endStr: string,
): Promise<CostBreakdown | undefined> {
  try {
    const res = await ce.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: startStr, End: endStr },
        Granularity: "DAILY",
        Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        Filter: OPENSENDER_TAG_FILTER,
      }),
    );
    const totals = new Map<string, number>();
    for (const period of res.ResultsByTime ?? []) {
      for (const group of period.Groups ?? []) {
        const service = group.Keys?.[0] ?? "Unknown";
        const amount = Number(group.Metrics?.UnblendedCost?.Amount ?? "0");
        totals.set(service, (totals.get(service) ?? 0) + amount);
      }
    }
    const services = [...totals.entries()]
      .map(([service, amount]) => ({ service, amount }))
      .filter((s) => s.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    return {
      services,
      total: services.reduce((sum, s) => sum + s.amount, 0),
      start: startStr,
      end: endStr,
    };
  } catch (error) {
    logger.warn("cost explorer unavailable (enable it once in Billing)", { error });
    return undefined;
  }
}
