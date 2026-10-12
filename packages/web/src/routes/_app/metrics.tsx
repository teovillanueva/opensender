import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BarChart3 } from "lucide-react";
import type { ReactNode } from "react";
import { RateBarChart, SERIES_COLORS, TimeSeriesChart } from "@/components/charts";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { domainsQuery, metricsQuery } from "@/lib/queries";

const RANGES = [7, 15, 30] as const;
type RangeDays = (typeof RANGES)[number];

// SES account-health thresholds: bounce reviews start at 5% (risk from ~4%),
// complaints at 0.1%.
const BOUNCE_RISK = 0.04;
const COMPLAINT_RISK = 0.001;

interface MetricsWire {
  days: number;
  totals: {
    sent: number;
    attempted: number;
    delivered: number;
    bounced: number;
    complained: number;
    failed: number;
    received: number;
  };
  rates: { deliverability: number | null; bounce: number | null; complaint: number | null };
  daily: {
    date: string;
    sent: number;
    delivered: number;
    bounced: number;
    complained: number;
    failed: number;
    received: number;
  }[];
  domains: {
    domain: string;
    sent: number;
    delivered: number;
    bounced: number;
    complained: number;
    received: number;
  }[];
}

export interface MetricsSearch {
  range: RangeDays;
  domain?: string;
}

export const Route = createFileRoute("/_app/metrics")({
  validateSearch: (search: Record<string, unknown>): MetricsSearch => ({
    range: RANGES.includes(Number(search.range) as RangeDays)
      ? (Number(search.range) as RangeDays)
      : 15,
    ...(typeof search.domain === "string" && search.domain.length > 0
      ? { domain: search.domain }
      : {}),
  }),
  loaderDeps: ({ search }) => ({ range: search.range, domain: search.domain }),
  loader: ({ context, deps }) => {
    context.queryClient.prefetchQuery(metricsQuery(deps.range, deps.domain));
    context.queryClient.prefetchQuery(domainsQuery);
  },
  component: MetricsScreen,
});

function formatPct(ratio: number | null | undefined, digits = 2): string {
  if (ratio === null || ratio === undefined) return "—";
  return `${(ratio * 100).toLocaleString(undefined, { maximumFractionDigits: digits })}%`;
}

function MetricsScreen() {
  const { range, domain } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const query = useQuery({
    ...metricsQuery(range, domain),
    select: (data) => data as unknown as MetricsWire,
  });
  const domains = useQuery(domainsQuery);
  const domainOptions = ((domains.data?.data ?? []) as { name?: string }[])
    .map((d) => d.name)
    .filter((name): name is string => Boolean(name));

  const metrics = query.data;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Metrics"
        description="Outbound volume, deliverability and account health."
        actions={
          <>
            <Select
              value={domain ?? "all"}
              onValueChange={(value) =>
                navigate({
                  search: { range, ...(value === "all" ? {} : { domain: value }) },
                  replace: true,
                })
              }
            >
              <SelectTrigger className="w-44" aria-label="Filter by domain">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All domains</SelectItem>
                {domainOptions.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={String(range)}
              onValueChange={(value) =>
                navigate({
                  search: { range: Number(value) as RangeDays, ...(domain ? { domain } : {}) },
                  replace: true,
                })
              }
            >
              <SelectTrigger className="w-36" aria-label="Time range">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGES.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    Last {days} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        }
      />

      {query.isLoading ? (
        <div className="flex flex-col gap-6">
          <Skeleton className="h-96 w-full rounded-xl" />
          <div className="grid gap-6 lg:grid-cols-2">
            <Skeleton className="h-80 w-full rounded-xl" />
            <Skeleton className="h-80 w-full rounded-xl" />
          </div>
        </div>
      ) : query.isError || !metrics ? (
        <EmptyState
          icon={BarChart3}
          title="Failed to load metrics"
          description="We couldn't aggregate your sending data. Try refreshing the page."
        />
      ) : metrics.totals.sent === 0 && metrics.totals.received === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="No activity in this window"
          description="Metrics appear once this team starts sending or receiving email."
        />
      ) : (
        <MetricsBody metrics={metrics} />
      )}
    </div>
  );
}

function MetricsBody({ metrics }: { metrics: MetricsWire }) {
  const { totals, rates, daily, domains } = metrics;

  const bounceDaily = daily.map((day) => ({
    date: day.date,
    value: day.sent > 0 ? day.bounced / day.sent : 0,
  }));
  const complaintDaily = daily.map((day) => ({
    date: day.date,
    value: day.sent > 0 ? day.complained / day.sent : 0,
  }));

  return (
    <div className="content-reveal flex flex-col gap-6">
      <section className="rounded-xl border bg-card/30 p-5">
        <div className="flex flex-wrap items-start gap-10">
          <Stat label="Emails" value={totals.sent.toLocaleString()} />
          <Stat label="Deliverability Rate" value={formatPct(rates.deliverability)} />
          <Stat label="Bounced" value={totals.bounced.toLocaleString()} />
          <Stat label="Complaints" value={totals.complained.toLocaleString()} />
        </div>

        <div className="mt-6">
          <TimeSeriesChart
            data={daily}
            series={[
              { key: "sent", label: "Sent", color: SERIES_COLORS.sent },
              { key: "delivered", label: "Delivered", color: SERIES_COLORS.delivered },
              { key: "complained", label: "Complained", color: SERIES_COLORS.complained },
              { key: "bounced", label: "Bounced", color: SERIES_COLORS.bounced },
            ]}
          />
        </div>

        {domains.length > 0 && (
          <div className="mt-6 flex flex-col divide-y divide-border/60 border-t pt-2">
            {domains.map((row) => (
              <div key={row.domain} className="flex items-center justify-between gap-4 py-2.5">
                <p className="min-w-0 truncate text-sm">
                  <span className="font-medium">{row.domain}</span>{" "}
                  <span className="tabular-nums text-muted-foreground">
                    ({(row.sent + row.received).toLocaleString()})
                  </span>
                  {row.received > 0 && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {row.received.toLocaleString()} received
                    </span>
                  )}
                </p>
                <div className="flex shrink-0 items-center gap-4 text-xs tabular-nums">
                  <DomainRate
                    color={SERIES_COLORS.delivered}
                    label="delivered"
                    ratio={row.sent > 0 ? row.delivered / row.sent : null}
                    digits={0}
                  />
                  {row.bounced > 0 && (
                    <DomainRate
                      color={SERIES_COLORS.bounced}
                      label="bounced"
                      ratio={row.bounced / row.sent}
                    />
                  )}
                  {row.complained > 0 && (
                    <DomainRate
                      color={SERIES_COLORS.complained}
                      label="complained"
                      ratio={row.complained / row.sent}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <RateCard
          title="Bounce Rate"
          headline={formatPct(rates.bounce)}
          hint="Hard bounces against attempted sends. SES reviews accounts above 5% — stay under the risk line."
        >
          <RateBarChart
            data={bounceDaily}
            color={SERIES_COLORS.bounced}
            threshold={BOUNCE_RISK}
            yMax={0.1}
          />
          <SummaryRow
            color={SERIES_COLORS.bounced}
            label="Bounced"
            count={totals.bounced}
            ratio={rates.bounce}
          />
        </RateCard>

        <RateCard
          title="Complaint Rate"
          headline={formatPct(rates.complaint)}
          hint="Spam complaints against attempted sends. SES reviews accounts above 0.1%."
        >
          <RateBarChart
            data={complaintDaily}
            color={SERIES_COLORS.complained}
            threshold={COMPLAINT_RISK}
            yMax={0.002}
          />
          <SummaryRow
            color={SERIES_COLORS.complained}
            label="Complained"
            count={totals.complained}
            ratio={rates.complaint}
          />
        </RateCard>
      </div>

      {totals.received > 0 && (
        <section className="rounded-xl border bg-card/30 p-5">
          <div className="mb-6 flex flex-wrap items-start gap-10">
            <Stat label="Received" value={totals.received.toLocaleString()} />
          </div>
          <TimeSeriesChart
            data={daily}
            series={[{ key: "received", label: "Received", color: SERIES_COLORS.received }]}
            height={180}
          />
        </section>
      )}

      <p className="text-xs text-muted-foreground">
        Aggregated from each email's latest delivery state; rates use attempted sends as the
        denominator. Receiving counts inbound emails per recipient domain.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight">{value}</p>
    </div>
  );
}

function DomainRate({
  color,
  label,
  ratio,
  digits = 2,
}: {
  color: string;
  label: string;
  ratio: number | null;
  digits?: number;
}) {
  return (
    <span className="inline-flex items-center gap-1.5" title={label}>
      <span className="size-2 rounded-full" style={{ background: color }} aria-hidden="true" />
      <span className="sr-only">{label}</span>
      {formatPct(ratio, digits)}
    </span>
  );
}

function RateCard({
  title,
  headline,
  hint,
  children,
}: {
  title: string;
  headline: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card/30 p-5">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums tracking-tight">{headline}</p>
        <p className="mt-1 text-pretty text-xs text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  );
}

function SummaryRow({
  color,
  label,
  count,
  ratio,
}: {
  color: string;
  label: string;
  count: number;
  ratio: number | null;
}) {
  return (
    <div className="flex items-center justify-between border-t pt-3 text-sm">
      <span className="inline-flex items-center gap-2">
        <span className="size-2 rounded-full" style={{ background: color }} aria-hidden="true" />
        {label}
      </span>
      <span className="tabular-nums text-muted-foreground">
        {count.toLocaleString()}{" "}
        <span className="ml-2 font-medium text-foreground">{formatPct(ratio)}</span>
      </span>
    </div>
  );
}
