import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Globe, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/list-skeleton";
import { PageHeader } from "@/components/page-header";
import { RegionLabel } from "@/components/region-label";
import { StatusBadge } from "@/components/status-badge";
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
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/format";
import { domainsQuery } from "@/lib/queries";

type DomainStatus =
  | "pending"
  | "verified"
  | "failed"
  | "not_started"
  | "partially_verified"
  | "partially_failed";

interface DomainListItem {
  id?: string;
  name?: string;
  status?: DomainStatus;
  created_at?: string;
  region?: string;
  capabilities?: { sending?: string; receiving?: string };
}

const REGIONS = ["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"] as const;

export const Route = createFileRoute("/_app/domains/")({
  loader: ({ context }) => {
    context.queryClient.prefetchQuery(domainsQuery);
  },
  component: DomainsScreen,
});

function DomainsScreen() {
  const query = useQuery(domainsQuery);

  const domains = (query.data?.data ?? []) as DomainListItem[];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Domains"
        description="Verify sending domains and manage their DNS records."
        actions={<AddDomainDialog />}
      />

      {query.isLoading ? (
        <ListSkeleton rows={5} />
      ) : query.isError ? (
        <p className="text-sm text-destructive">Failed to load domains.</p>
      ) : domains.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No domains yet"
          description="Add a domain to start sending authenticated email."
        >
          <AddDomainDialog />
        </EmptyState>
      ) : (
        <div className="content-reveal overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="border-border/60 hover:bg-transparent">
                <TableHead className="w-0 pl-4" aria-hidden="true" />
                <TableHead>Domain</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Region</TableHead>
                <TableHead className="pr-4 text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {domains.map((domain) => (
                <TableRow
                  key={domain.id ?? domain.name}
                  className="group relative border-border/60"
                >
                  <TableCell className="w-0 py-3 pl-4 pr-0">
                    <div className="flex size-8 items-center justify-center rounded-lg border bg-card text-muted-foreground">
                      <Globe className="size-4" aria-hidden="true" />
                    </div>
                  </TableCell>
                  <TableCell className="py-3 font-medium">
                    {domain.id ? (
                      <Link
                        to="/domains/$id"
                        params={{ id: domain.id }}
                        className="block truncate after:absolute after:inset-0"
                      >
                        {domain.name ?? "—"}
                      </Link>
                    ) : (
                      (domain.name ?? "—")
                    )}
                  </TableCell>
                  <TableCell className="w-0 py-3">
                    <StatusBadge status={domain.status ?? "unknown"} />
                  </TableCell>
                  <TableCell className="py-3 text-muted-foreground">
                    <RegionLabel region={domain.region} />
                  </TableCell>
                  <TableCell className="w-0 whitespace-nowrap py-3 pr-4 text-right text-sm tabular-nums text-muted-foreground">
                    {formatRelative(domain.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function AddDomainDialog() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [region, setRegion] = useState<(typeof REGIONS)[number]>("us-east-1");

  const mutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/domains", {
        body: { name: name.trim(), region, tls: "opportunistic" },
      });
      if (error) {
        const message =
          typeof error === "object" && error && "message" in error
            ? String((error as { message: unknown }).message)
            : "Failed to create domain";
        throw new Error(message);
      }
      return data;
    },
    onSuccess: (data) => {
      toast.success("Domain created");
      queryClient.invalidateQueries({ queryKey: ["domains"] });
      setName("");
      setRegion("us-east-1");
      setOpen(false);
      // Open the domain's detail page so the DNS records are shown immediately.
      const id = (data as { id?: string } | undefined)?.id;
      if (id) navigate({ to: "/domains/$id", params: { id } });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus />
          Add domain
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add domain</DialogTitle>
          <DialogDescription>
            Register a domain, then add the generated DNS records to verify it.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim().length > 0) mutation.mutate();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="domain-name">Name</FieldLabel>
              <Input
                id="domain-name"
                placeholder="example.com"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="domain-region">Region</FieldLabel>
              <Select
                value={region}
                onValueChange={(value) => setRegion(value as (typeof REGIONS)[number])}
              >
                <SelectTrigger id="domain-region">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REGIONS.map((value) => (
                    <SelectItem key={value} value={value}>
                      <RegionLabel region={value} />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-6">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={name.trim().length === 0 || mutation.isPending}>
              {mutation.isPending ? "Creating…" : "Create domain"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
