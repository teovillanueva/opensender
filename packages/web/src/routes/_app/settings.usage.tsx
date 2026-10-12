import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BarChart3 } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { humanize } from "@/lib/format";
import { usageQuery } from "@/lib/queries";

export const Route = createFileRoute("/_app/settings/usage")({
  loader: ({ context }) => {
    context.queryClient.prefetchQuery(usageQuery);
  },
  component: UsageScreen,
});

function UsageScreen() {
  const query = useQuery(usageQuery);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-semibold tracking-tight">Usage</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Quota consumption and plan limits for your team.
        </p>
      </div>

      {query.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {["c1", "c2", "c3", "c4"].map((key) => (
            <Skeleton key={key} className="h-36 w-full rounded-xl" />
          ))}
        </div>
      ) : query.isError || !query.data ? (
        <EmptyState
          icon={BarChart3}
          title="Failed to load usage"
          description="We couldn't load your quota and plan limits. Try refreshing the page."
        />
      ) : (
        <UsageCards usage={query.data} />
      )}
    </div>
  );
}

interface Usage {
  team: { id: string; name: string; status: string; plan: string };
  sent: { daily: number; monthly: number };
  limits: { daily_email_limit: number; api_rate_limit_per_second: number };
}

function UsageCards({ usage }: { usage: Usage }) {
  const { team, sent, limits } = usage;
  const dailyLimit = limits.daily_email_limit;
  const ratio = dailyLimit > 0 ? Math.min(sent.daily / dailyLimit, 1) : 0;
  const remaining = Math.max(dailyLimit - sent.daily, 0);

  return (
    <div className="content-reveal flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card/30 px-5 py-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Team</span>
          <span className="text-lg font-semibold tracking-tight">{team.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{team.id}</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex flex-col items-end gap-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Plan</span>
            <span className="text-sm font-medium">{humanize(team.plan)}</span>
          </div>
          <StatusBadge status={team.status} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="Daily sends">
          <div className="flex items-baseline gap-1.5">
            <span className="text-3xl font-semibold tabular-nums tracking-tight">
              {formatCount(sent.daily)}
            </span>
            <span className="text-sm text-muted-foreground">/ {formatCount(dailyLimit)}</span>
          </div>
          <Meter value={ratio} />
          <p className="text-xs text-muted-foreground">
            {formatPercent(ratio)} used · {formatCount(remaining)} remaining today
          </p>
        </StatCard>

        <StatCard label="Monthly sends">
          <span className="text-3xl font-semibold tabular-nums tracking-tight">
            {formatCount(sent.monthly)}
          </span>
          <p className="text-xs text-muted-foreground">Emails sent this billing period.</p>
        </StatCard>

        <StatCard label="API rate limit">
          <div className="flex items-baseline gap-1.5">
            <span className="text-3xl font-semibold tabular-nums tracking-tight">
              {formatCount(limits.api_rate_limit_per_second)}
            </span>
            <span className="text-sm text-muted-foreground">req/s</span>
          </div>
          <p className="text-xs text-muted-foreground">Maximum sustained requests per second.</p>
        </StatCard>
      </div>
    </div>
  );
}

/** A bordered stat tile: an uppercase label followed by a big number and supporting copy. */
function StatCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card/30 p-5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** A minimal accessible meter — no Progress primitive is installed, so compose one. */
function Meter({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const nearLimit = value >= 0.9;
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-secondary"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div
        className={`h-full rounded-full transition-all ${
          nearLimit ? "bg-destructive" : "bg-primary"
        }`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
