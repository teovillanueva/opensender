import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { MailX, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/list-skeleton";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { suppressionsQuery } from "@/lib/queries";

export interface SuppressionRow {
  email: string;
  reason: "hard_bounce" | "complaint" | "manual";
  source_email_id?: string | null;
  created_at?: string;
}

export const REASON_LABEL: Record<SuppressionRow["reason"], string> = {
  hard_bounce: "Bounce",
  complaint: "Complaint",
  manual: "Manual",
};

export function ReasonBadge({ reason }: { reason: SuppressionRow["reason"] }) {
  return (
    <Badge
      variant="secondary"
      className={
        reason === "manual"
          ? undefined
          : "bg-destructive/10 text-destructive dark:bg-destructive/20"
      }
    >
      {REASON_LABEL[reason] ?? reason}
    </Badge>
  );
}

export const Route = createFileRoute("/_app/suppressions/")({
  loader: ({ context }) => {
    context.queryClient.prefetchInfiniteQuery(suppressionsQuery);
  },
  component: SuppressionsScreen,
});

function initial(value: string): string {
  return value.trim().charAt(0).toUpperCase() || "@";
}

function SuppressionsScreen() {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery(suppressionsQuery);
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<SuppressionRow | null>(null);

  const rows = (query.data?.pages.flatMap((page) => page.data) ??
    []) as unknown as SuppressionRow[];
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return term ? rows.filter((row) => row.email.includes(term)) : rows;
  }, [rows, search]);

  const remove = useMutation({
    mutationFn: async (email: string) => {
      const { error } = await api.DELETE("/internal/suppressions/{email}", {
        params: { path: { email } },
      });
      if (error) throw new Error("Could not remove the suppression.");
    },
    onSuccess: () => {
      toast.success("Address removed from the suppression list");
      setRemoveTarget(null);
      queryClient.invalidateQueries({ queryKey: ["suppressions"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Suppressions"
        description="Addresses this team will never send to — bounced, complained, or manually blocked."
        actions={
          <Button onClick={() => setAddOpen(true)}>
            <Plus />
            Add email address
          </Button>
        }
      />

      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search by email…"
        aria-label="Search suppressions"
        spellCheck={false}
        className="max-w-md"
      />

      {query.isLoading ? (
        <ListSkeleton rows={5} />
      ) : query.isError ? (
        <p className="text-sm text-destructive">Failed to load suppressions.</p>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={MailX}
          title={search ? "No matches" : "No suppressed addresses"}
          description={
            search
              ? "No suppressed address matches that search."
              : "Hard bounces and complaints land here automatically."
          }
        />
      ) : (
        <div className="content-reveal overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="border-border/60 hover:bg-transparent">
                <TableHead className="pl-4">Email</TableHead>
                <TableHead>Origin</TableHead>
                <TableHead className="text-right">Added</TableHead>
                <TableHead className="w-0 pr-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((row) => (
                <TableRow key={row.email} className="group relative border-border/60">
                  <TableCell className="py-3 pl-4">
                    <div className="flex items-center gap-3">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                        {initial(row.email)}
                      </div>
                      <Link
                        to="/suppressions/$email"
                        params={{ email: row.email }}
                        className="truncate font-medium after:absolute after:inset-0"
                      >
                        {row.email}
                      </Link>
                    </div>
                  </TableCell>
                  <TableCell className="w-0 py-3">
                    <ReasonBadge reason={row.reason} />
                  </TableCell>
                  <TableCell className="w-0 whitespace-nowrap py-3 text-right text-sm tabular-nums text-muted-foreground">
                    {formatRelative(row.created_at)}
                  </TableCell>
                  <TableCell className="w-0 py-3 pr-4">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="relative text-muted-foreground hover:text-destructive"
                      aria-label={`Remove ${row.email} from suppressions`}
                      onClick={() => setRemoveTarget(row)}
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

      <AddSuppressionDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={() => {
          setAddOpen(false);
          queryClient.invalidateQueries({ queryKey: ["suppressions"] });
        }}
      />

      <Dialog open={removeTarget !== null} onOpenChange={(next) => !next && setRemoveTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove suppression?</DialogTitle>
            <DialogDescription>
              Emails to <span className="font-medium text-foreground">{removeTarget?.email}</span>{" "}
              will be delivered again. If the address hard-bounced, sending to it again can hurt
              your reputation.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRemoveTarget(null)}
              disabled={remove.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => removeTarget && remove.mutate(removeTarget.email)}
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

function AddSuppressionDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const [email, setEmail] = useState("");

  const add = useMutation({
    mutationFn: async () => {
      const result = await api.POST("/internal/suppressions", {
        body: { email: email.trim() },
      });
      if (result.error) {
        const message =
          typeof result.error === "object" && result.error && "message" in result.error
            ? String((result.error as { message: unknown }).message)
            : "Could not suppress the address.";
        throw new Error(message);
      }
    },
    onSuccess: () => {
      toast.success(`${email.trim()} suppressed`);
      setEmail("");
      onAdded();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const canSubmit = email.includes("@") && !add.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Suppress an address</DialogTitle>
          <DialogDescription>
            The API will reject any send to this address until it's removed from the list.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) add.mutate();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="suppress-email">Email</FieldLabel>
              <Input
                id="suppress-email"
                type="email"
                autoComplete="off"
                spellCheck={false}
                placeholder="person@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoFocus
              />
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={add.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {add.isPending ? "Adding…" : "Suppress"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
