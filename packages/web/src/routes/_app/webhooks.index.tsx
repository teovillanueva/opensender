import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Copy, Plus, TriangleAlert, Webhook } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/list-skeleton";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { webhooksQuery } from "@/lib/queries";

/** The 19-type event catalog (SPEC §8.2), mirrored from the API route. */
const EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.opened",
  "email.clicked",
  "email.scheduled",
  "email.suppressed",
  "email.received",
  "contact.created",
  "contact.updated",
  "contact.deleted",
  "domain.created",
  "domain.updated",
  "domain.deleted",
  "suppression.added",
  "suppression.removed",
] as const;

async function copyToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  } catch {
    toast.error("Failed to copy to clipboard");
  }
}

export const Route = createFileRoute("/_app/webhooks/")({
  loader: ({ context }) => {
    context.queryClient.prefetchQuery(webhooksQuery);
  },
  component: WebhooksScreen,
});

function WebhooksScreen() {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  const query = useQuery(webhooksQuery);

  const rows = query.data?.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Webhooks"
        description="Endpoints that receive signed event notifications."
        actions={
          <Button onClick={() => setAddOpen(true)}>
            <Plus />
            Add endpoint
          </Button>
        }
      />

      {query.isLoading ? (
        <ListSkeleton rows={4} />
      ) : query.isError ? (
        <p className="text-sm text-destructive">Failed to load webhooks.</p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Webhook}
          title="No webhooks yet"
          description="Add an endpoint to start receiving signed event notifications."
        >
          <Button onClick={() => setAddOpen(true)}>
            <Plus />
            Add endpoint
          </Button>
        </EmptyState>
      ) : (
        <div className="content-reveal overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="border-border/60 hover:bg-transparent">
                <TableHead className="w-0 pl-4" aria-hidden="true" />
                <TableHead>Endpoint</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Events</TableHead>
                <TableHead className="pr-4 text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((webhook) => {
                const status = webhook.status ?? "enabled";
                const eventCount = webhook.events?.length ?? 0;
                return (
                  <TableRow
                    key={webhook.id ?? webhook.endpoint}
                    className="group relative border-border/60"
                  >
                    <TableCell className="w-0 py-3 pl-4 pr-0">
                      <div className="flex size-8 items-center justify-center rounded-lg border bg-card text-muted-foreground">
                        <Webhook className="size-4" aria-hidden="true" />
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[28rem] py-3 font-medium">
                      {webhook.id ? (
                        <Link
                          to="/webhooks/$id"
                          params={{ id: webhook.id }}
                          className="block truncate after:absolute after:inset-0"
                        >
                          {webhook.endpoint ?? "—"}
                        </Link>
                      ) : (
                        <span className="block truncate">{webhook.endpoint ?? "—"}</span>
                      )}
                    </TableCell>
                    <TableCell className="w-0 py-3">
                      <StatusBadge status={status} />
                    </TableCell>
                    <TableCell className="w-0 whitespace-nowrap py-3 text-right tabular-nums text-muted-foreground">
                      {eventCount} {eventCount === 1 ? "event" : "events"}
                    </TableCell>
                    <TableCell className="w-0 whitespace-nowrap py-3 pr-4 text-right text-sm tabular-nums text-muted-foreground">
                      {formatRelative(webhook.created_at)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <AddEndpointDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={(signingSecret) => {
          setAddOpen(false);
          queryClient.invalidateQueries({ queryKey: ["webhooks"] });
          setSecret(signingSecret);
        }}
      />

      <SigningSecretDialog secret={secret} onClose={() => setSecret(null)} />
    </div>
  );
}

function AddEndpointDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (signingSecret: string) => void;
}) {
  const [endpoint, setEndpoint] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const reset = () => {
    setEndpoint("");
    setSelected(new Set());
  };

  const toggle = (event: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(event);
      } else {
        next.delete(event);
      }
      return next;
    });
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const result = await api.POST("/webhooks", {
        body: { endpoint, events: Array.from(selected) },
      });
      if (result.error) {
        const message =
          typeof result.error === "object" && result.error && "message" in result.error
            ? String((result.error as { message: unknown }).message)
            : "Failed to create webhook";
        throw new Error(message);
      }
      return result.data;
    },
    onSuccess: (data) => {
      reset();
      onCreated(data?.signing_secret ?? "");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const canSubmit = /^https?:\/\//.test(endpoint) && selected.size > 0 && !mutation.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add endpoint</DialogTitle>
          <DialogDescription>
            Choose a URL and the events it should receive. The signing secret is shown once after
            creation.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="webhook-endpoint">Endpoint URL</FieldLabel>
            <Input
              id="webhook-endpoint"
              type="url"
              placeholder="https://example.com/webhooks"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel>Events</FieldLabel>
            <div className="grid max-h-64 grid-cols-1 gap-2 overflow-y-auto rounded-lg border p-3 sm:grid-cols-2">
              {EVENT_TYPES.map((event) => (
                <Label
                  key={event}
                  htmlFor={`event-${event}`}
                  className="flex items-center gap-2 font-normal"
                >
                  <Checkbox
                    id={`event-${event}`}
                    checked={selected.has(event)}
                    onCheckedChange={(checked) => toggle(event, checked === true)}
                  />
                  <span className="font-mono text-xs">{event}</span>
                </Label>
              ))}
            </div>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!canSubmit}>
            {mutation.isPending ? "Creating…" : "Create endpoint"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SigningSecretDialog({ secret, onClose }: { secret: string | null; onClose: () => void }) {
  return (
    <Dialog open={secret !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Signing secret</DialogTitle>
          <DialogDescription>Use this secret to verify webhook payloads.</DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span className="text-muted-foreground">Copy this now — it will not be shown again.</span>
        </div>

        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded-lg border bg-muted px-3 py-2 font-mono text-xs">
            {secret}
          </code>
          <Button
            variant="outline"
            size="icon"
            aria-label="Copy signing secret"
            onClick={() => secret && copyToClipboard(secret, "Signing secret")}
          >
            <Copy />
          </Button>
        </div>

        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
