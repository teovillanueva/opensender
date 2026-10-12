import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Globe, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { RegionLabel } from "@/components/region-label";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { domainQuery } from "@/lib/queries";

type DomainStatus =
  | "pending"
  | "verified"
  | "failed"
  | "not_started"
  | "partially_verified"
  | "partially_failed";

type RecordStatus = "pending" | "verified" | "failed" | "temporary_failure" | "not_started";

interface DomainRecord {
  record?: string;
  name?: string;
  type?: string;
  ttl?: string;
  status?: RecordStatus;
  value?: string;
  priority?: number;
}

interface DomainDetail {
  id?: string;
  name?: string;
  status?: DomainStatus;
  created_at?: string;
  region?: string;
  open_tracking?: boolean;
  click_tracking?: boolean;
  capabilities?: { sending?: string; receiving?: string };
  records?: DomainRecord[];
}

/** PATCH body: `inbound_enabled` is an opensender extension not in the base contract type. */
interface DomainPatch {
  open_tracking?: boolean;
  click_tracking?: boolean;
  tls: "opportunistic" | "enforced";
  inbound_enabled?: boolean;
}

export const Route = createFileRoute("/_app/domains/$id")({
  loader: ({ context, params }) => {
    context.queryClient.prefetchQuery(domainQuery(params.id));
  },
  component: DomainDetailScreen,
});

function DomainDetailScreen() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();

  const query = useQuery({
    ...domainQuery(id),
    select: (data) => data as DomainDetail,
  });

  // TLS mode is not returned by the API; track it locally (contract default).
  // Every PATCH must carry `tls` (required by the contract).
  const [tls, setTls] = useState<"opportunistic" | "enforced">("opportunistic");
  const [openTracking, setOpenTracking] = useState(false);
  const [clickTracking, setClickTracking] = useState(false);
  const [inbound, setInbound] = useState(false);

  const domain = query.data;

  useEffect(() => {
    if (!domain) return;
    setOpenTracking(domain.open_tracking ?? false);
    setClickTracking(domain.click_tracking ?? false);
    setInbound(domain.capabilities?.receiving === "enabled");
  }, [domain]);

  const patchMutation = useMutation({
    mutationFn: async (patch: DomainPatch) => {
      const { error } = await api.PATCH("/domains/{domain_id}", {
        params: { path: { domain_id: id } },
        body: patch,
      });
      if (error) {
        const message =
          typeof error === "object" && error && "message" in error
            ? String((error as { message: unknown }).message)
            : "Update failed";
        throw new Error(message);
      }
    },
    onSuccess: () => {
      toast.success("Domain updated");
      queryClient.invalidateQueries({ queryKey: ["domain", id] });
      queryClient.invalidateQueries({ queryKey: ["domains"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const verifyMutation = useMutation({
    mutationFn: async () => {
      const { error } = await api.POST("/domains/{domain_id}/verify", {
        params: { path: { domain_id: id } },
      });
      if (error) {
        const message =
          typeof error === "object" && error && "message" in error
            ? String((error as { message: unknown }).message)
            : "Verification failed";
        throw new Error(message);
      }
    },
    onSuccess: () => {
      toast.success("Verification requested");
      queryClient.invalidateQueries({ queryKey: ["domain", id] });
      queryClient.invalidateQueries({ queryKey: ["domains"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const submitToggle = (patch: Omit<DomainPatch, "tls"> & { tls?: DomainPatch["tls"] }) =>
    patchMutation.mutate({ tls, ...patch });

  return (
    <div className="flex flex-col gap-8">
      <Link
        to="/domains"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Domains
      </Link>

      {query.isLoading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-16 w-72" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : query.isError || !domain ? (
        <p className="text-sm text-destructive">Failed to load domain.</p>
      ) : (
        <div className="content-reveal flex flex-col gap-8">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="flex size-14 items-center justify-center rounded-2xl border bg-gradient-to-b from-emerald-500/15 to-transparent text-emerald-400">
                <Globe className="size-6" />
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Domain</div>
                <h1 className="text-2xl font-semibold tracking-tight">{domain.name ?? "—"}</h1>
              </div>
            </div>
            <Button
              variant="outline"
              onClick={() => verifyMutation.mutate()}
              disabled={verifyMutation.isPending}
            >
              <RefreshCw className={verifyMutation.isPending ? "animate-spin" : undefined} />
              {verifyMutation.isPending ? "Verifying…" : "Verify"}
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
            <Stat label="Created" value={formatDateTime(domain.created_at)} />
            <Stat label="Status" value={<StatusBadge status={domain.status ?? "unknown"} />} />
            <Stat label="Provider" value="Amazon Route 53" />
            <Stat label="Region" value={<RegionLabel region={domain.region} />} />
          </div>

          <Tabs defaultValue="records">
            <TabsList>
              <TabsTrigger value="records">Records</TabsTrigger>
              <TabsTrigger value="configuration">Configuration</TabsTrigger>
            </TabsList>

            <TabsContent value="records" className="mt-6 flex flex-col gap-6">
              <RecordsCard records={domain.records ?? []} domainName={domain.name ?? ""} />
              <div className="rounded-xl border">
                <ToggleRow
                  label="Enable receiving"
                  description="Accept incoming email for this domain (adds an MX record). Receiving works even while sending verification is pending."
                  checked={inbound}
                  disabled={patchMutation.isPending}
                  onChange={(value) => {
                    setInbound(value);
                    submitToggle({ inbound_enabled: value });
                  }}
                />
              </div>
            </TabsContent>

            <TabsContent value="configuration" className="mt-6">
              <div className="flex flex-col divide-y divide-border rounded-xl border">
                <ToggleRow
                  label="Open tracking"
                  description="Track the open rate of each email."
                  checked={openTracking}
                  disabled={patchMutation.isPending}
                  onChange={(value) => {
                    setOpenTracking(value);
                    submitToggle({ open_tracking: value });
                  }}
                />
                <ToggleRow
                  label="Click tracking"
                  description="Track clicks within the body of each HTML email."
                  checked={clickTracking}
                  disabled={patchMutation.isPending}
                  onChange={(value) => {
                    setClickTracking(value);
                    submitToggle({ click_tracking: value });
                  }}
                />
                <ToggleRow
                  label="Enforce TLS"
                  description="Require a secure connection or the email is not sent."
                  checked={tls === "enforced"}
                  disabled={patchMutation.isPending}
                  onChange={(value) => {
                    const next = value ? "enforced" : "opportunistic";
                    setTls(next);
                    submitToggle({ tls: next });
                  }}
                />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

function RecordsCard({ records, domainName }: { records: DomainRecord[]; domainName: string }) {
  // Wire record names are relative to the added domain (Resend convention),
  // so the full host is shown too — for a subdomain like inbound.example.com,
  // "send" actually means send.inbound.example.com, and a parent-zone DNS
  // provider needs the qualified name.
  const fqdn = (record: DomainRecord) =>
    record.name ? `${record.name}.${domainName}` : domainName;

  // Grouped by purpose: DKIM + MAIL FROM gate the "verified" status, DMARC is
  // deliverability advice, and the inbound MX only matters for receiving.
  const required = records.filter((r) => r.record !== "DMARC" && r.record !== "MX");
  const recommended = records.filter((r) => r.record === "DMARC");
  const receiving = records.filter((r) => r.record === "MX");

  return (
    <div className="rounded-xl border">
      <div className="border-b px-5 py-4">
        <h2 className="font-semibold tracking-tight">DNS Records</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Add these records at your DNS provider. Names are relative to{" "}
          <span className="font-medium text-foreground">{domainName}</span> — the copy button copies
          the full host.
        </p>
      </div>
      {records.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted-foreground">No records to configure.</p>
      ) : (
        <div className="flex flex-col divide-y divide-border">
          <RecordsSection
            title="Required to send"
            description="DKIM and MAIL FROM records — the domain verifies once these resolve. Skip them if this domain only receives email."
            records={required}
            fqdn={fqdn}
          />
          <RecordsSection
            title="Recommended for sending"
            description="DMARC tells receiving servers what to do with mail that fails authentication. Optional, but improves deliverability."
            records={recommended}
            fqdn={fqdn}
          />
          <RecordsSection
            title="Receiving"
            description="Routes incoming email to this domain. Independent of sending — press Verify and the MX is checked directly against DNS."
            records={receiving}
            fqdn={fqdn}
            emptyHint="Turn on “Enable receiving” below to get the inbound MX record."
          />
        </div>
      )}
    </div>
  );
}

function RecordsSection({
  title,
  description,
  records,
  fqdn,
  emptyHint,
}: {
  title: string;
  description: string;
  records: DomainRecord[];
  fqdn: (record: DomainRecord) => string;
  emptyHint?: string;
}) {
  if (records.length === 0 && !emptyHint) return null;
  // MX records carry a priority the DNS provider will ask for; the column only
  // appears in sections that have one.
  const showPriority = records.some((record) => record.priority !== undefined);
  return (
    <section className="flex flex-col gap-3 px-5 py-4">
      <div>
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        <p className="mt-0.5 text-pretty text-xs text-muted-foreground">{description}</p>
      </div>
      {records.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyHint}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="border-border/60 hover:bg-transparent">
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Content</TableHead>
                {showPriority && <TableHead>Priority</TableHead>}
                <TableHead>TTL</TableHead>
                <TableHead className="pr-4">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((record) => (
                <TableRow
                  key={`${record.record}-${record.type}-${record.name}-${record.value}`}
                  className="border-border/60"
                >
                  <TableCell className="py-3 pl-4">
                    <div className="flex items-center gap-1">
                      <div className="min-w-0">
                        <div className="max-w-[12rem] truncate font-mono text-xs">
                          {record.name || "@"}
                        </div>
                        <div className="max-w-[14rem] truncate font-mono text-[10px] text-muted-foreground">
                          {fqdn(record)}
                        </div>
                      </div>
                      <CopyButton value={fqdn(record)} label="Copy record host" />
                    </div>
                  </TableCell>
                  <TableCell className="py-3 text-sm">{record.type ?? "—"}</TableCell>
                  <TableCell className="py-3">
                    <div className="flex items-center gap-1">
                      <span className="max-w-[18rem] truncate font-mono text-xs">
                        {record.value ?? "—"}
                      </span>
                      {record.value ? (
                        <CopyButton value={record.value} label="Copy record value" />
                      ) : null}
                    </div>
                  </TableCell>
                  {showPriority && (
                    <TableCell className="py-3 text-sm tabular-nums text-muted-foreground">
                      {record.priority ?? "—"}
                    </TableCell>
                  )}
                  <TableCell className="py-3 text-sm text-muted-foreground">
                    {record.ttl ?? "Auto"}
                  </TableCell>
                  <TableCell className="py-3 pr-4">
                    <StatusBadge status={record.status ?? "unknown"} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}
