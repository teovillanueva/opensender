import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Copy, RefreshCw, Trash2, Webhook } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
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
import { api } from "@/lib/api";
import { formatDateTime, formatRelative } from "@/lib/format";
import { webhookDeliveriesQuery, webhookQuery } from "@/lib/queries";

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

interface Delivery {
  id: string;
  svix_id?: string;
  type?: string;
  attempt?: number;
  outcome?: string;
  status_code?: number;
  duration_ms?: number;
  error?: string;
  created_at?: string;
}

async function copyToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  } catch {
    toast.error("Failed to copy to clipboard");
  }
}

export const Route = createFileRoute("/_app/webhooks/$id")({
  loader: ({ context, params }) => {
    context.queryClient.prefetchQuery(webhookQuery(params.id));
    context.queryClient.prefetchInfiniteQuery(webhookDeliveriesQuery(params.id));
  },
  component: WebhookDetailScreen,
});

function WebhookDetailScreen() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [enabled, setEnabled] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const query = useQuery(webhookQuery(id));

  const webhook = query.data;

  useEffect(() => {
    if (webhook) {
      setSelected(new Set(webhook.events ?? []));
      setEnabled((webhook.status ?? "enabled") === "enabled");
    }
  }, [webhook]);

  const updateMutation = useMutation({
    mutationFn: async () => {
      const result = await api.PATCH("/webhooks/{webhook_id}", {
        params: { path: { webhook_id: id } },
        body: {
          events: Array.from(selected),
          status: enabled ? "enabled" : "disabled",
        },
      });
      if (result.error) {
        throw new Error(errorMessage(result.error, "Failed to update webhook"));
      }
      return result.data;
    },
    onSuccess: () => {
      toast.success("Webhook updated");
      queryClient.invalidateQueries({ queryKey: ["webhook", id] });
      queryClient.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const result = await api.DELETE("/webhooks/{webhook_id}", {
        params: { path: { webhook_id: id } },
      });
      if (result.error) {
        throw new Error(errorMessage(result.error, "Failed to delete webhook"));
      }
      return result.data;
    },
    onSuccess: () => {
      toast.success("Webhook deleted");
      queryClient.invalidateQueries({ queryKey: ["webhooks"] });
      navigate({ to: "/webhooks" });
    },
    onError: (error: Error) => toast.error(error.message),
  });

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

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-md" />
          <Skeleton className="h-8 w-96" />
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          <Skeleton className="h-96 w-full rounded-xl md:col-span-2" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </div>
    );
  }
  if (query.isError || !webhook) {
    return <p className="text-sm text-destructive">Failed to load webhook.</p>;
  }

  return (
    <div className="content-reveal flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="icon" asChild>
          <Link to="/webhooks" aria-label="Back to webhooks">
            <ArrowLeft />
          </Link>
        </Button>
        <h1 className="min-w-0 flex-1 truncate text-[26px] font-semibold leading-tight tracking-tight">
          {webhook.endpoint ?? "Webhook"}
        </h1>
        <StatusBadge status={enabled ? "enabled" : "disabled"} />
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Configuration</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground">Endpoint URL</span>
              <span className="break-all font-mono text-xs">{webhook.endpoint ?? "—"}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground">Created</span>
              <span>{formatDateTime(webhook.created_at)}</span>
            </div>

            <Separator />

            <Field orientation="horizontal">
              <FieldLabel htmlFor="webhook-status">Enabled</FieldLabel>
              <Switch id="webhook-status" checked={enabled} onCheckedChange={setEnabled} />
            </Field>

            <div className="flex flex-col gap-2">
              <span className="text-muted-foreground">Subscribed events</span>
              <div className="grid grid-cols-1 gap-2 rounded-lg border p-3 sm:grid-cols-2">
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
            </div>

            <div className="flex justify-end">
              <Button
                onClick={() => updateMutation.mutate()}
                disabled={updateMutation.isPending || selected.size === 0}
              >
                {updateMutation.isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Signing secret</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-sm">
            <p className="text-muted-foreground">Use this secret to verify webhook payloads.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg border bg-muted px-3 py-2 font-mono text-xs">
                {webhook.signing_secret ?? "—"}
              </code>
              <Button
                variant="outline"
                size="icon"
                aria-label="Copy signing secret"
                onClick={() =>
                  webhook.signing_secret &&
                  copyToClipboard(webhook.signing_secret, "Signing secret")
                }
                disabled={!webhook.signing_secret}
              >
                <Copy />
              </Button>
            </div>

            <Separator />

            <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 />
              Delete endpoint
            </Button>
          </CardContent>
        </Card>
      </div>

      <DeliveryLog id={id} />

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete webhook?</DialogTitle>
            <DialogDescription>
              This permanently removes the endpoint. Events will no longer be delivered to this URL.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(false)}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DeliveryLog({ id }: { id: string }) {
  const [replaying, setReplaying] = useState<string | null>(null);

  const query = useInfiniteQuery(webhookDeliveriesQuery(id));

  const rows = (query.data?.pages.flatMap((page) => page.data) ?? []) as unknown as Delivery[];

  const replay = async (deliveryId: string) => {
    setReplaying(deliveryId);
    const result = await api.POST("/internal/webhooks/{id}/deliveries/{deliveryId}/replay", {
      params: { path: { id, deliveryId } },
    });
    setReplaying(null);
    if (result.error) {
      toast.error(errorMessage(result.error, "Failed to replay delivery"));
      return;
    }
    toast.success("Delivery replayed");
    query.refetch();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Delivery log</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {query.isLoading ? (
          <div className="flex flex-col gap-2">
            {["d1", "d2", "d3"].map((key) => (
              <Skeleton key={key} className="h-10 w-full" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={Webhook} title="No deliveries yet" />
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="border-border/60">
                  <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                    Event
                  </TableHead>
                  <TableHead className="text-xs uppercase tracking-wide text-muted-foreground">
                    Outcome
                  </TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">
                    Status
                  </TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">
                    Duration
                  </TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">
                    Attempted
                  </TableHead>
                  <TableHead className="text-right text-xs uppercase tracking-wide text-muted-foreground">
                    Replay
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((delivery) => (
                  <TableRow key={delivery.id} className="border-border/60">
                    <TableCell className="py-3 font-mono text-xs">{delivery.type ?? "—"}</TableCell>
                    <TableCell className="py-3">
                      <StatusBadge status={delivery.outcome ?? "unknown"} />
                    </TableCell>
                    <TableCell className="py-3 text-right text-muted-foreground">
                      {delivery.status_code ?? "—"}
                    </TableCell>
                    <TableCell className="py-3 text-right text-muted-foreground">
                      {delivery.duration_ms === undefined ? "—" : `${delivery.duration_ms} ms`}
                    </TableCell>
                    <TableCell className="py-3 text-right text-muted-foreground">
                      {formatRelative(delivery.created_at)}
                    </TableCell>
                    <TableCell className="py-3 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => replay(delivery.id)}
                        disabled={replaying === delivery.id}
                        aria-label="Replay delivery"
                      >
                        <RefreshCw />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
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
      </CardContent>
    </Card>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return typeof error === "object" && error && "message" in error
    ? String((error as { message: unknown }).message)
    : fallback;
}
