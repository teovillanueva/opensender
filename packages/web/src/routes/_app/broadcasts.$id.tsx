import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api, unwrap } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { audiencesQuery, broadcastQuery } from "@/lib/queries";

/** Aggregate counters rolled up from delivery events (SPEC §8.1/§11). */
type BroadcastStats = Partial<Record<string, number>>;

interface BroadcastDetail {
  id?: string;
  name?: string | null;
  segment_id?: string | null;
  audience_id?: string | null;
  from?: string;
  subject?: string;
  status?: string;
  html?: string | null;
  text?: string | null;
  created_at?: string | null;
  scheduled_at?: string | null;
  sent_at?: string | null;
  stats?: BroadcastStats;
}

interface AudienceOption {
  id?: string;
  name?: string;
}

/** Supported Resend-compatible merge tags the composer can insert (SPEC §11). */
const MERGE_TAGS: { tag: string; label: string; hint: string }[] = [
  {
    tag: "{{{contact.first_name|there}}}",
    label: "First name",
    hint: "Contact first name, falling back to “there”.",
  },
  {
    tag: "{{{RESEND_UNSUBSCRIBE_URL}}}",
    label: "Unsubscribe URL",
    hint: "One-click unsubscribe link (required for compliance).",
  },
];

const STAT_KEYS: { key: string; label: string }[] = [
  { key: "sent", label: "Sent" },
  { key: "delivered", label: "Delivered" },
  { key: "opened", label: "Opened" },
  { key: "clicked", label: "Clicked" },
  { key: "bounced", label: "Bounced" },
  { key: "complained", label: "Complained" },
];

export const Route = createFileRoute("/_app/broadcasts/$id")({
  loader: ({ context, params }) => {
    context.queryClient.prefetchQuery(broadcastQuery(params.id));
    context.queryClient.prefetchQuery(audiencesQuery);
  },
  component: BroadcastDetailScreen,
});

function BroadcastDetailScreen() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();

  const query = useQuery({
    ...broadcastQuery(id),
    select: (data) => data as BroadcastDetail,
  });

  const audiences = useQuery(audiencesQuery);

  const [name, setName] = useState("");
  const [from, setFrom] = useState("");
  const [subject, setSubject] = useState("");
  const [segmentId, setSegmentId] = useState("");
  const [html, setHtml] = useState("");
  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const seededId = useRef<string | null>(null);

  const broadcast = query.data;

  // Seed the editor once per broadcast; refetches must not clobber local edits.
  useEffect(() => {
    if (!broadcast || seededId.current === broadcast.id) return;
    seededId.current = broadcast.id ?? null;
    setName(broadcast.name ?? "");
    setFrom(broadcast.from ?? "");
    setSubject(broadcast.subject ?? "");
    setSegmentId(broadcast.segment_id ?? broadcast.audience_id ?? "");
    setHtml(broadcast.html ?? "");
  }, [broadcast]);

  const save = useMutation({
    mutationFn: async () => {
      const result = await api.PATCH("/broadcasts/{id}", {
        params: { path: { id } },
        body: {
          name,
          from,
          subject,
          html,
          ...(segmentId.length > 0 ? { segment_id: segmentId } : {}),
        },
      });
      return unwrap(result);
    },
    onSuccess: async () => {
      toast.success("Broadcast saved");
      await queryClient.invalidateQueries({ queryKey: ["broadcasts"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const send = useMutation({
    mutationFn: async (scheduledAt: string | undefined) => {
      const result = await api.POST("/broadcasts/{id}/send", {
        params: { path: { id } },
        body: scheduledAt ? { scheduled_at: scheduledAt } : {},
      });
      return unwrap(result);
    },
    onSuccess: async (_data, scheduledAt) => {
      toast.success(scheduledAt ? "Broadcast scheduled" : "Broadcast sending");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["broadcast", id] }),
        queryClient.invalidateQueries({ queryKey: ["broadcasts"] }),
      ]);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  function insertTag(tag: string) {
    const el = htmlRef.current;
    if (!el) {
      setHtml((prev) => prev + tag);
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = html.slice(0, start) + tag + html.slice(end);
    setHtml(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + tag.length;
      el.setSelectionRange(caret, caret);
    });
  }

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-8 w-80" />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {["s1", "s2", "s3", "s4", "s5", "s6"].map((key) => (
            <Skeleton key={key} className="h-20 w-full rounded-xl" />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-[32rem] w-full rounded-xl" />
          <Skeleton className="h-[32rem] w-full rounded-xl" />
        </div>
      </div>
    );
  }
  if (query.isError || !broadcast) {
    return <p className="text-sm text-destructive">Failed to load broadcast.</p>;
  }

  const status = broadcast.status ?? "draft";
  const stats = broadcast.stats ?? {};
  const isDraft = status === "draft";

  return (
    <div className="content-reveal flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link
          to="/broadcasts"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Broadcasts
        </Link>
        <PageHeader
          title={name.trim() ? name : "Untitled broadcast"}
          actions={
            <>
              <StatusBadge status={status} />
              <Button variant="outline" onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? "Saving…" : "Save"}
              </Button>
              <SendDialog
                disabled={!isDraft}
                pending={send.isPending}
                onSend={(scheduledAt) => send.mutate(scheduledAt)}
              />
            </>
          }
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {STAT_KEYS.map((stat) => (
          <div key={stat.key} className="rounded-xl border bg-card px-4 py-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {stat.label}
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{stats[stat.key] ?? 0}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Compose</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="broadcast-name">Name</FieldLabel>
                <Input
                  id="broadcast-name"
                  placeholder="November announcements"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="broadcast-audience">Audience</FieldLabel>
                <Select value={segmentId} onValueChange={setSegmentId}>
                  <SelectTrigger id="broadcast-audience">
                    <SelectValue placeholder="Select an audience" />
                  </SelectTrigger>
                  <SelectContent>
                    {(audiences.data?.data ?? []).map((audience: AudienceOption) => (
                      <SelectItem key={audience.id ?? ""} value={audience.id ?? ""}>
                        {audience.name ?? "Untitled"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="broadcast-from">From</FieldLabel>
                <Input
                  id="broadcast-from"
                  placeholder="Acme <hello@acme.com>"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="broadcast-subject">Subject</FieldLabel>
                <Input
                  id="broadcast-subject"
                  placeholder="Monthly announcements"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="broadcast-html">HTML body</FieldLabel>
                <TooltipProvider>
                  <div className="flex flex-wrap items-center gap-2">
                    {MERGE_TAGS.map((merge) => (
                      <Tooltip key={merge.tag}>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => insertTag(merge.tag)}
                          >
                            {merge.label}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="max-w-56">
                            {merge.hint}
                            <br />
                            <code className="text-xs">{merge.tag}</code>
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    ))}
                  </div>
                </TooltipProvider>
                <Textarea
                  id="broadcast-html"
                  ref={htmlRef}
                  className="min-h-64 font-mono text-xs"
                  placeholder="<p>Hello {{{contact.first_name|there}}}!</p>"
                  value={html}
                  onChange={(e) => setHtml(e.target.value)}
                />
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Preview</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {html.trim() ? (
              // Sandboxed: no scripts, no same-origin — safe untrusted HTML preview.
              <iframe
                title="Broadcast preview"
                sandbox=""
                srcDoc={html}
                className="h-[28rem] w-full rounded-md border bg-white"
              />
            ) : (
              <div className="flex h-[28rem] items-center justify-center rounded-md border text-sm text-muted-foreground">
                Nothing to preview yet.
              </div>
            )}
            <Separator />
            <div className="flex flex-col gap-2 text-sm">
              <Detail label="Created" value={formatDateTime(broadcast.created_at)} />
              <Detail label="Scheduled" value={formatDateTime(broadcast.scheduled_at)} />
              <Detail label="Sent" value={formatDateTime(broadcast.sent_at)} />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="break-all">{value}</span>
    </div>
  );
}

function SendDialog({
  disabled,
  pending,
  onSend,
}: {
  disabled: boolean;
  pending: boolean;
  onSend: (scheduledAt: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [scheduledAt, setScheduledAt] = useState("");

  function handleSend() {
    let iso: string | undefined;
    if (scheduledAt.length > 0) {
      const date = new Date(scheduledAt);
      if (Number.isNaN(date.getTime())) {
        toast.error("Invalid schedule time");
        return;
      }
      iso = date.toISOString();
    }
    onSend(iso);
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button disabled={disabled || pending}>
          <Send />
          {pending ? "Sending…" : "Send"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send broadcast</DialogTitle>
          <DialogDescription>
            Send now, or pick a time to schedule the delivery. Leave the time empty to send
            immediately.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="broadcast-schedule">Schedule for (optional)</FieldLabel>
            <Input
              id="broadcast-schedule"
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={pending}>
            {scheduledAt.length > 0 ? "Schedule" : "Send now"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
