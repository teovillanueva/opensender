import { humanize } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Dot colour per status token (Resend-style). Unknown tokens fall back to muted. */
const DOT: Record<string, string> = {
  delivered: "bg-emerald-500",
  sent: "bg-sky-500",
  received: "bg-sky-500",
  scheduled: "bg-amber-500",
  sending: "bg-amber-500",
  queued: "bg-amber-500",
  draft: "bg-muted-foreground",
  delivery_delayed: "bg-amber-500",
  bounced: "bg-red-500",
  complained: "bg-red-500",
  failed: "bg-red-500",
  canceled: "bg-muted-foreground",
  verified: "bg-emerald-500",
  pending: "bg-amber-500",
  active: "bg-emerald-500",
  disabled: "bg-muted-foreground",
  temporary_failure: "bg-red-500",
};

/** A compact status pill: a coloured dot plus the humanized token. */
export function StatusBadge({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-2 py-0.5 text-xs font-medium text-foreground/90">
      <span className={cn("size-1.5 rounded-full", DOT[status] ?? "bg-muted-foreground")} />
      {humanize(status)}
    </span>
  );
}
