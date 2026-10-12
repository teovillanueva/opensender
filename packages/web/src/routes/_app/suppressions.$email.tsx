import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { suppressionQuery } from "@/lib/queries";
import { ReasonBadge, type SuppressionRow } from "./suppressions.index";

interface SuppressionDetail extends SuppressionRow {
  source_event?: unknown;
}

export const Route = createFileRoute("/_app/suppressions/$email")({
  loader: ({ context, params }) => {
    context.queryClient.prefetchQuery(suppressionQuery(params.email));
  },
  component: SuppressionDetailScreen,
});

/**
 * Pull a human-readable diagnostic out of the SES bounce/complaint payload:
 * the per-recipient SMTP diagnostic code when present, otherwise the payload
 * itself pretty-printed so nothing is hidden.
 */
function extractDiagnostic(sourceEvent: unknown): string | null {
  if (!sourceEvent || typeof sourceEvent !== "object") return null;
  const payload = sourceEvent as {
    bounce?: { bouncedRecipients?: { diagnosticCode?: string }[]; bounceType?: string };
    complaint?: { complaintFeedbackType?: string };
  };
  const diagnostic = payload.bounce?.bouncedRecipients?.find(
    (recipient) => recipient.diagnosticCode,
  )?.diagnosticCode;
  if (diagnostic) return diagnostic;
  if (payload.complaint?.complaintFeedbackType) {
    return `Complaint feedback type: ${payload.complaint.complaintFeedbackType}`;
  }
  return JSON.stringify(sourceEvent, null, 2);
}

function initial(value: string): string {
  return value.trim().charAt(0).toUpperCase() || "@";
}

function SuppressionDetailScreen() {
  const { email } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmRemove, setConfirmRemove] = useState(false);

  const query = useQuery({
    ...suppressionQuery(email),
    select: (data) => data as unknown as SuppressionDetail,
  });

  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await api.DELETE("/internal/suppressions/{email}", {
        params: { path: { email } },
      });
      if (error) throw new Error("Could not remove the suppression.");
    },
    onSuccess: () => {
      toast.success("Address removed from the suppression list");
      queryClient.invalidateQueries({ queryKey: ["suppressions"] });
      navigate({ to: "/suppressions" });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-4">
          <Skeleton className="size-14 rounded-full" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-7 w-72" />
          </div>
        </div>
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }
  const suppression = query.data;
  if (query.isError || !suppression) {
    return <p className="text-sm text-destructive">Failed to load suppression.</p>;
  }

  const diagnostic = extractDiagnostic(suppression.source_event);

  return (
    <div className="content-reveal flex flex-col gap-6">
      <Link
        to="/suppressions"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Suppressions
      </Link>

      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-full border bg-muted text-lg font-semibold">
            {initial(suppression.email)}
          </div>
          <div className="min-w-0">
            <div className="text-sm text-muted-foreground">Suppression</div>
            <h1 className="truncate text-2xl font-semibold tracking-tight">{suppression.email}</h1>
          </div>
        </div>
        <Button variant="destructive" onClick={() => setConfirmRemove(true)}>
          <Trash2 />
          Remove
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-4">
        <Meta label="Origin">
          <ReasonBadge reason={suppression.reason} />
        </Meta>
        <Meta label="Recipient">{suppression.email}</Meta>
        <Meta label="Added">{formatDateTime(suppression.created_at)}</Meta>
        {suppression.source_email_id && (
          <Meta label="Source Email">
            <Link
              to="/emails/$id"
              params={{ id: suppression.source_email_id }}
              className="text-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground"
            >
              View email
            </Link>
          </Meta>
        )}
      </div>

      {diagnostic && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Details
          </p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl border bg-muted/40 p-4 font-mono text-xs leading-relaxed">
            {diagnostic}
          </pre>
        </div>
      )}

      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove suppression?</DialogTitle>
            <DialogDescription>
              Emails to <span className="font-medium text-foreground">{suppression.email}</span>{" "}
              will be delivered again. If the address hard-bounced, sending to it again can hurt
              your reputation.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmRemove(false)}
              disabled={remove.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              {remove.isPending ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 truncate text-sm">{children}</div>
    </div>
  );
}
