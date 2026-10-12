import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/list-skeleton";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { audiencesQuery } from "@/lib/queries";

/** List-item shape from `GET /audiences` (see segments.ts `segmentSummary`). */
interface AudienceRow {
  id?: string;
  name?: string;
  created_at?: string;
}

export const Route = createFileRoute("/_app/audiences/")({
  loader: ({ context }) => {
    context.queryClient.prefetchQuery(audiencesQuery);
  },
  component: AudiencesScreen,
});

function AudiencesScreen() {
  const query = useQuery(audiencesQuery);

  const audiences = (query.data?.data ?? []) as AudienceRow[];
  const [deleteTarget, setDeleteTarget] = useState<AudienceRow | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audiences"
        description="Group contacts into audiences to target broadcasts."
        actions={<CreateAudienceDialog />}
      />

      {query.isLoading ? (
        <ListSkeleton rows={5} />
      ) : query.isError ? (
        <p className="text-sm text-destructive">Failed to load audiences.</p>
      ) : audiences.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No audiences yet"
          description="Create an audience to start collecting contacts."
        />
      ) : (
        <div className="content-reveal overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="border-border/60 hover:bg-transparent">
                <TableHead className="w-0 pl-4" aria-hidden="true" />
                <TableHead>Audience</TableHead>
                <TableHead className="text-right">Created</TableHead>
                <TableHead className="w-0 pr-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {audiences.map((audience) => (
                <TableRow
                  key={audience.id ?? audience.name}
                  className="group relative border-border/60"
                >
                  <TableCell className="w-0 py-3 pl-4 pr-0">
                    <div className="flex size-8 items-center justify-center rounded-lg border bg-card text-muted-foreground">
                      <Users className="size-4" aria-hidden="true" />
                    </div>
                  </TableCell>
                  <TableCell className="py-3 font-medium">
                    {audience.id ? (
                      <Link
                        to="/audiences/$id"
                        params={{ id: audience.id }}
                        className="block truncate after:absolute after:inset-0"
                      >
                        {audience.name ?? "Untitled"}
                      </Link>
                    ) : (
                      (audience.name ?? "Untitled")
                    )}
                  </TableCell>
                  <TableCell className="w-0 whitespace-nowrap py-3 text-right text-sm tabular-nums text-muted-foreground">
                    {formatRelative(audience.created_at)}
                  </TableCell>
                  <TableCell className="w-0 py-3 pr-4">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="relative text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteTarget(audience)}
                      aria-label={`Delete ${audience.name ?? "audience"}`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <DeleteAudienceDialog target={deleteTarget} onOpenChange={() => setDeleteTarget(null)} />
    </div>
  );
}

function CreateAudienceDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  const mutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/audiences", { body: { name: name.trim() } });
      if (error) {
        throw new Error(errorMessage(error, "Failed to create audience"));
      }
      return data;
    },
    onSuccess: () => {
      toast.success("Audience created");
      queryClient.invalidateQueries({ queryKey: ["audiences"] });
      setName("");
      setOpen(false);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus />
          Create audience
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create audience</DialogTitle>
          <DialogDescription>Give the audience a recognisable name.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim().length > 0) mutation.mutate();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="audience-name">Name</FieldLabel>
              <Input
                id="audience-name"
                placeholder="Registered users"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-6">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={name.trim().length === 0 || mutation.isPending}>
              {mutation.isPending ? "Creating…" : "Create audience"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteAudienceDialog({
  target,
  onOpenChange,
}: {
  target: AudienceRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE("/audiences/{id}", { params: { path: { id } } });
      if (error) {
        throw new Error(errorMessage(error, "Failed to delete audience"));
      }
    },
    onSuccess: () => {
      toast.success("Audience deleted");
      queryClient.invalidateQueries({ queryKey: ["audiences"] });
      onOpenChange(false);
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete audience</DialogTitle>
          <DialogDescription>
            Delete{" "}
            <span className="font-medium text-foreground">{target?.name ?? "this audience"}</span>{" "}
            and all of its contacts? This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-2">
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => target?.id && mutation.mutate(target.id)}
          >
            {mutation.isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Extract a human message from an openapi-fetch error body (a Resend error). */
function errorMessage(error: unknown, fallback: string): string {
  return typeof error === "object" && error && "message" in error
    ? String((error as { message: unknown }).message)
    : fallback;
}
