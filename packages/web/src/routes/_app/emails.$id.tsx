import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Download, Mail, Paperclip } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, unwrap } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { emailQuery, receivedEmailQuery } from "@/lib/queries";

interface TimelineEvent {
  type: string;
  occurred_at: string;
}

interface EmailDetail {
  id: string;
  from?: string;
  to?: string[] | string;
  cc?: string[] | null;
  bcc?: string[] | null;
  reply_to?: string[] | null;
  subject?: string;
  message_id?: string | null;
  html?: string | null;
  text?: string | null;
  created_at?: string;
  scheduled_at?: string | null;
  last_event?: string;
  events?: TimelineEvent[];
}

interface ReceivedAttachment {
  id: string;
  filename: string;
  content_type?: string;
  size?: number;
}

interface ReceivedDetail {
  headers?: Record<string, string> | null;
  attachments?: ReceivedAttachment[];
}

export const Route = createFileRoute("/_app/emails/$id")({
  loader: ({ context, params }) => {
    context.queryClient.prefetchQuery(emailQuery(params.id));
  },
  component: EmailDetailScreen,
});

function joinAddresses(value: string[] | string | null | undefined): string {
  if (!value) return "—";
  return Array.isArray(value) ? value.join(", ") : value;
}

function formatBytes(size: number | undefined): string {
  if (size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function EmailDetailScreen() {
  const { id } = Route.useParams();
  const query = useQuery({
    ...emailQuery(id),
    select: (data) => data as unknown as EmailDetail,
  });

  const email = query.data;
  const isInbound = (email?.last_event ?? "") === "received";

  // Inbound emails carry extra detail (headers, attachments) on the
  // Resend-compatible receiving surface.
  const received = useQuery({
    ...receivedEmailQuery(id),
    enabled: isInbound,
    select: (data) => data as unknown as ReceivedDetail,
  });

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-4">
          <Skeleton className="size-14 rounded-2xl" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-7 w-72" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
          {["m1", "m2", "m3", "m4"].map((key) => (
            <Skeleton key={key} className="h-12 w-full" />
          ))}
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          <Skeleton className="h-[32rem] w-full rounded-xl lg:col-span-2" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </div>
    );
  }
  if (query.isError || !email) {
    return <p className="text-sm text-destructive">Failed to load email.</p>;
  }

  const counterparty = isInbound
    ? (email.from ?? "—")
    : joinAddresses(Array.isArray(email.to) ? email.to[0] : email.to);
  const events = email.events ?? [];
  const attachments = received.data?.attachments ?? [];
  const headers = received.data?.headers ?? null;

  return (
    <div className="content-reveal flex flex-col gap-6">
      <Link
        to="/emails"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Emails
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl border bg-gradient-to-b from-emerald-500/15 to-transparent text-emerald-400">
            <Mail className="size-6" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="text-sm text-muted-foreground">
              {isInbound ? "Received email" : "Sent email"}
            </div>
            <h1 className="truncate text-2xl font-semibold tracking-tight">{counterparty}</h1>
          </div>
        </div>
        {email.last_event && <StatusBadge status={email.last_event} />}
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
        <Meta label="From">{email.from ?? "—"}</Meta>
        <Meta label="Subject" title={email.subject ?? undefined}>
          {email.subject ?? "—"}
        </Meta>
        <Meta label="To" title={joinAddresses(email.to)}>
          {joinAddresses(email.to)}
        </Meta>
        <Meta label="ID">
          <span className="flex items-center gap-1">
            <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {email.id}
            </code>
            <CopyButton value={email.id} label="Copy email ID" />
          </span>
        </Meta>
        {email.reply_to && email.reply_to.length > 0 && (
          <Meta label="Reply-To">{joinAddresses(email.reply_to)}</Meta>
        )}
        {email.cc && email.cc.length > 0 && <Meta label="CC">{joinAddresses(email.cc)}</Meta>}
        {email.bcc && email.bcc.length > 0 && <Meta label="BCC">{joinAddresses(email.bcc)}</Meta>}
        {email.scheduled_at && <Meta label="Scheduled">{formatDateTime(email.scheduled_at)}</Meta>}
        <Meta label={isInbound ? "Received" : "Sent"}>{formatDateTime(email.created_at)}</Meta>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <ContentCard email={email} headers={headers} isInbound={isInbound} />

          {attachments.length > 0 && <AttachmentsCard emailId={id} attachments={attachments} />}
        </div>

        <div className="flex h-fit flex-col gap-3 rounded-xl border bg-card/30 p-4">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Timeline
          </h2>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No events recorded.</p>
          ) : (
            events.map((event) => (
              <div
                key={`${event.occurred_at}-${event.type}`}
                className="flex items-center justify-between gap-2"
              >
                <StatusBadge status={event.type} />
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatDateTime(event.occurred_at)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Meta({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 truncate text-sm" title={title}>
        {children}
      </div>
    </div>
  );
}

function ContentCard({
  email,
  headers,
  isInbound,
}: {
  email: EmailDetail;
  headers: Record<string, string> | null;
  isInbound: boolean;
}) {
  const [tab, setTab] = useState(email.html ? "preview" : "text");

  const copyValue =
    tab === "html" || tab === "preview"
      ? (email.html ?? "")
      : tab === "text"
        ? (email.text ?? "")
        : "";

  return (
    <Tabs value={tab} onValueChange={setTab} className="rounded-xl border">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <TabsList>
          <TabsTrigger value="preview" disabled={!email.html}>
            Preview
          </TabsTrigger>
          <TabsTrigger value="text" disabled={!email.text}>
            Plain Text
          </TabsTrigger>
          <TabsTrigger value="html" disabled={!email.html}>
            HTML
          </TabsTrigger>
          {isInbound && headers && Object.keys(headers).length > 0 && (
            <TabsTrigger value="headers">Headers</TabsTrigger>
          )}
        </TabsList>
        {copyValue.length > 0 && <CopyButton value={copyValue} label="Copy email content" />}
      </div>

      <TabsContent value="preview" className="p-3">
        {email.html ? (
          // Sandboxed: no scripts, no same-origin — safe untrusted HTML preview.
          <iframe
            title="Email preview"
            sandbox=""
            srcDoc={email.html}
            className="h-[32rem] w-full rounded-lg border bg-white"
          />
        ) : (
          <p className="p-3 text-sm text-muted-foreground">No HTML body.</p>
        )}
      </TabsContent>

      <TabsContent value="text" className="p-3">
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-4 text-xs leading-relaxed">
          {email.text ?? "No text body."}
        </pre>
      </TabsContent>

      <TabsContent value="html" className="p-3">
        <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/40 p-4 font-mono text-xs leading-relaxed">
          {email.html ?? "No HTML body."}
        </pre>
      </TabsContent>

      {isInbound && headers && (
        <TabsContent value="headers" className="p-3">
          <div className="max-h-[32rem] overflow-auto rounded-lg bg-muted/40 p-4">
            <dl className="flex flex-col gap-2">
              {Object.entries(headers).map(([key, value]) => (
                <div key={key} className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
                  <dt className="shrink-0 font-mono text-xs font-medium sm:w-44 sm:truncate">
                    {key}
                  </dt>
                  <dd className="break-all font-mono text-xs text-muted-foreground">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </TabsContent>
      )}
    </Tabs>
  );
}

function AttachmentsCard({
  emailId,
  attachments,
}: {
  emailId: string;
  attachments: ReceivedAttachment[];
}) {
  const [downloading, setDownloading] = useState<string | null>(null);

  const download = async (attachment: ReceivedAttachment) => {
    setDownloading(attachment.id);
    try {
      const detail = unwrap(
        await api.GET("/emails/receiving/{email_id}/attachments/{attachment_id}", {
          params: { path: { email_id: emailId, attachment_id: attachment.id } },
        }),
      ) as { download_url?: string };
      if (!detail.download_url) throw new Error("No download URL returned");
      window.open(detail.download_url, "_blank", "noopener");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to download attachment");
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="rounded-xl border">
      <div className="border-b px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Paperclip className="size-4 text-muted-foreground" aria-hidden="true" />
          Attachments
          <span className="font-normal text-muted-foreground">({attachments.length})</span>
        </h2>
      </div>
      <div className="flex flex-col divide-y divide-border/60">
        {attachments.map((attachment) => (
          <div key={attachment.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{attachment.filename}</p>
              <p className="text-xs tabular-nums text-muted-foreground">
                {attachment.content_type ?? "application/octet-stream"}
                {attachment.size !== undefined && ` · ${formatBytes(attachment.size)}`}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => download(attachment)}
              disabled={downloading === attachment.id}
            >
              <Download className="size-3.5" />
              {downloading === attachment.id ? "Preparing…" : "Download"}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
