import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Mail, MailX, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/list-skeleton";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatRelative, humanize } from "@/lib/format";
import { apiKeysQuery, emailsQuery } from "@/lib/queries";

/** Delivery-log row shape (x-internal `/internal/emails` returns wire emails). */
interface EmailRow {
  id: string;
  to?: string[] | string;
  from?: string;
  subject?: string;
  last_event?: string;
  status?: string;
  created_at?: string;
}

const RANGES = [7, 15, 30] as const;
type RangeDays = (typeof RANGES)[number];

const OUTBOUND_STATUSES = [
  "queued",
  "scheduled",
  "sent",
  "delivered",
  "delivery_delayed",
  "bounced",
  "complained",
  "failed",
  "canceled",
] as const;

export interface EmailsSearch {
  tab?: "inbound";
  range?: RangeDays;
  status?: string;
  key?: string;
}

export const Route = createFileRoute("/_app/emails/")({
  // Tab and filters live in the URL so filtered views are shareable and
  // survive reloads.
  validateSearch: (search: Record<string, unknown>): EmailsSearch => ({
    ...(search.tab === "inbound" ? { tab: "inbound" as const } : {}),
    ...(RANGES.includes(Number(search.range) as RangeDays)
      ? { range: Number(search.range) as RangeDays }
      : {}),
    ...(typeof search.status === "string" &&
    (OUTBOUND_STATUSES as readonly string[]).includes(search.status)
      ? { status: search.status }
      : {}),
    ...(typeof search.key === "string" && search.key.length > 0 ? { key: search.key } : {}),
  }),
  loader: ({ context }) => {
    context.queryClient.prefetchInfiniteQuery(emailsQuery("outbound"));
  },
  component: EmailsScreen,
});

function EmailsScreen() {
  const { tab, range, status, key } = Route.useSearch();
  const direction = tab ?? "outbound";
  const navigate = useNavigate({ from: Route.fullPath });
  const [search, setSearch] = useState("");

  const setSearchParams = (next: Partial<EmailsSearch>) =>
    navigate({
      search: (prev: EmailsSearch) => {
        const merged = { ...prev, ...next };
        return {
          ...(merged.tab === "inbound" ? { tab: "inbound" as const } : {}),
          ...(merged.range ? { range: merged.range } : {}),
          ...(merged.status && merged.tab !== "inbound" ? { status: merged.status } : {}),
          ...(merged.key && merged.tab !== "inbound" ? { key: merged.key } : {}),
        };
      },
      replace: true,
    });

  const apiKeys = useQuery(apiKeysQuery);
  const keyOptions = ((apiKeys.data?.data ?? []) as { id?: string; name?: string }[]).filter(
    (row): row is { id: string; name: string } => Boolean(row.id),
  );

  const query = useInfiniteQuery(
    emailsQuery(direction, {
      rangeDays: range,
      status: direction === "outbound" ? status : undefined,
      apiKeyId: direction === "outbound" ? key : undefined,
    }),
  );

  const rows = (query.data?.pages.flatMap((page) => page.data) ?? []) as unknown as EmailRow[];
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((email) => {
      const to = Array.isArray(email.to) ? email.to.join(" ") : (email.to ?? "");
      return `${to} ${email.subject ?? ""} ${email.from ?? ""}`.toLowerCase().includes(term);
    });
  }, [rows, search]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Emails" />

      <div className="flex items-center justify-between gap-2">
        <Tabs
          value={direction}
          onValueChange={(v) =>
            setSearchParams(v === "inbound" ? { tab: "inbound" } : { tab: undefined })
          }
        >
          <TabsList>
            <TabsTrigger value="outbound">Sending</TabsTrigger>
            <TabsTrigger value="inbound">Receiving</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button variant="outline" asChild>
          <Link to="/suppressions">
            <MailX />
            Suppression list
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-md">
          <Search
            aria-hidden="true"
            className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by recipient or subject…"
            aria-label="Search emails"
            spellCheck={false}
            className="pl-9"
          />
        </div>
        <Select
          value={range ? String(range) : "all"}
          onValueChange={(value) =>
            setSearchParams({ range: value === "all" ? undefined : (Number(value) as RangeDays) })
          }
        >
          <SelectTrigger className="w-36" aria-label="Time range">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All time</SelectItem>
            {RANGES.map((days) => (
              <SelectItem key={days} value={String(days)}>
                Last {days} days
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {direction === "outbound" && (
          <Select
            value={status ?? "all"}
            onValueChange={(value) =>
              setSearchParams({ status: value === "all" ? undefined : value })
            }
          >
            <SelectTrigger className="w-40" aria-label="Status filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {OUTBOUND_STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {humanize(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {direction === "outbound" && keyOptions.length > 0 && (
          <Select
            value={key ?? "all"}
            onValueChange={(value) => setSearchParams({ key: value === "all" ? undefined : value })}
          >
            <SelectTrigger className="w-40" aria-label="API key filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All API keys</SelectItem>
              {keyOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {query.isLoading ? (
        <ListSkeleton rows={6} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Mail}
          title={direction === "outbound" ? "No emails yet" : "No received emails yet"}
          description={
            direction === "outbound"
              ? "Emails you send through the API or broadcasts will appear here."
              : "Emails received on your inbound-enabled domains will appear here."
          }
        />
      ) : (
        <div className="content-reveal overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="border-border/60 hover:bg-transparent">
                <TableHead className="w-0 pl-4" aria-hidden="true" />
                <TableHead>To</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead className="pr-4 text-right">Sent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((email) => {
                const status = email.last_event ?? email.status ?? "sent";
                const to = Array.isArray(email.to) ? email.to[0] : email.to;
                const extra =
                  Array.isArray(email.to) && email.to.length > 1 ? email.to.length - 1 : 0;
                return (
                  <TableRow key={email.id} className="group relative border-border/60">
                    <TableCell className="w-0 py-3 pl-4 pr-0">
                      <div className="flex size-8 items-center justify-center rounded-lg border bg-card text-muted-foreground">
                        <Mail className="size-4" aria-hidden="true" />
                      </div>
                    </TableCell>
                    <TableCell className="py-3">
                      {/* The ::after overlay stretches the link across the row
                          while keeping it a real <a> (Cmd+click, middle-click). */}
                      <Link
                        to="/emails/$id"
                        params={{ id: email.id }}
                        className="flex items-center gap-2 font-medium after:absolute after:inset-0"
                      >
                        <span className="truncate">{to ?? "—"}</span>
                        {extra > 0 && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                            +{extra}
                          </span>
                        )}
                      </Link>
                    </TableCell>
                    <TableCell className="w-0 py-3">
                      <StatusBadge status={status} />
                    </TableCell>
                    <TableCell className="max-w-[28rem] truncate py-3 text-muted-foreground">
                      {email.subject ?? "—"}
                    </TableCell>
                    <TableCell className="w-0 whitespace-nowrap py-3 pr-4 text-right text-sm tabular-nums text-muted-foreground">
                      {formatRelative(email.created_at)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {query.hasNextPage && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
