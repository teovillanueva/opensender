import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Megaphone, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/list-skeleton";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api, unwrap } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { audiencesQuery, broadcastsQuery } from "@/lib/queries";

export const Route = createFileRoute("/_app/broadcasts/")({
  loader: ({ context }) => {
    context.queryClient.prefetchQuery(broadcastsQuery);
    context.queryClient.prefetchQuery(audiencesQuery);
  },
  component: BroadcastsScreen,
});

function BroadcastsScreen() {
  const broadcasts = useQuery(broadcastsQuery);
  const audiences = useQuery(audiencesQuery);

  const rows = broadcasts.data?.data ?? [];
  const audienceOptions = audiences.data?.data ?? [];
  const audienceName = new Map(audienceOptions.map((a) => [a.id ?? "", a.name ?? "Untitled"]));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Broadcasts"
        description="Campaigns sent to an audience."
        actions={<CreateBroadcastDialog audiences={audienceOptions} />}
      />

      {broadcasts.isLoading ? (
        <ListSkeleton rows={5} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="No broadcasts yet"
          description="Create a broadcast to send a campaign to an audience."
        >
          <CreateBroadcastDialog audiences={audienceOptions} />
        </EmptyState>
      ) : (
        <div className="content-reveal overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="border-border/60 hover:bg-transparent">
                <TableHead className="w-0 pl-4" aria-hidden="true" />
                <TableHead>Broadcast</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Audience</TableHead>
                <TableHead className="pr-4 text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((broadcast) => {
                const id = broadcast.id ?? "";
                const status = broadcast.status ?? "draft";
                const audienceId = broadcast.segment_id ?? broadcast.audience_id ?? "";
                return (
                  <TableRow key={id} className="group relative border-border/60">
                    <TableCell className="w-0 py-3 pl-4 pr-0">
                      <div className="flex size-8 items-center justify-center rounded-lg border bg-card text-muted-foreground">
                        <Megaphone className="size-4" aria-hidden="true" />
                      </div>
                    </TableCell>
                    <TableCell className="py-3">
                      <Link
                        to="/broadcasts/$id"
                        params={{ id }}
                        className="block truncate font-medium after:absolute after:inset-0"
                      >
                        {broadcast.name?.trim() ? broadcast.name : "Untitled broadcast"}
                      </Link>
                    </TableCell>
                    <TableCell className="w-0 py-3">
                      <StatusBadge status={status} />
                    </TableCell>
                    <TableCell className="max-w-[16rem] truncate py-3 text-muted-foreground">
                      {audienceName.get(audienceId) ?? (audienceId || "—")}
                    </TableCell>
                    <TableCell className="w-0 whitespace-nowrap py-3 pr-4 text-right text-sm tabular-nums text-muted-foreground">
                      {formatRelative(broadcast.created_at)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

interface AudienceOption {
  id?: string;
  name?: string;
}

function CreateBroadcastDialog({ audiences }: { audiences: AudienceOption[] }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [segmentId, setSegmentId] = useState("");
  const [from, setFrom] = useState("");
  const [subject, setSubject] = useState("");
  const [html, setHtml] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const result = await api.POST("/broadcasts", {
        body: {
          segment_id: segmentId,
          from,
          subject,
          ...(html.length > 0 ? { html } : {}),
        },
      });
      return unwrap(result);
    },
    onSuccess: async (data) => {
      toast.success("Broadcast created");
      await queryClient.invalidateQueries({ queryKey: ["broadcasts"] });
      setOpen(false);
      setSegmentId("");
      setFrom("");
      setSubject("");
      setHtml("");
      if (data.id) {
        navigate({ to: "/broadcasts/$id", params: { id: data.id } });
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const canSubmit = segmentId.length > 0 && from.length > 0 && subject.length > 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus />
          Create broadcast
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create broadcast</DialogTitle>
          <DialogDescription>Pick an audience and compose the message.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="broadcast-audience">Audience</FieldLabel>
            <Select value={segmentId} onValueChange={setSegmentId}>
              <SelectTrigger id="broadcast-audience">
                <SelectValue placeholder="Select an audience" />
              </SelectTrigger>
              <SelectContent>
                {audiences.map((audience) => (
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
            <FieldLabel htmlFor="broadcast-html">HTML</FieldLabel>
            <Textarea
              id="broadcast-html"
              className="min-h-32 font-mono text-xs"
              placeholder="<p>Hello {{{contact.first_name|there}}}!</p>"
              value={html}
              onChange={(e) => setHtml(e.target.value)}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!canSubmit || mutation.isPending}>
            {mutation.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
