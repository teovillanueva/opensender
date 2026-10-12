import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
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
import { config } from "@/config";
import { api, unwrap } from "@/lib/api";
import { formatRelative, humanize } from "@/lib/format";
import { apiKeysQuery } from "@/lib/queries";

type Permission = "full_access" | "sending_access";

/**
 * API key list row. The list endpoint returns `id/name/created_at/last_used_at`;
 * `permission` is accepted defensively in case the surface starts returning it.
 */
interface ApiKeyRow {
  id: string;
  name: string;
  created_at?: string;
  last_used_at?: string | null;
  permission?: Permission;
}

const QUERY_KEY = ["api-keys"] as const;

export const Route = createFileRoute("/_app/api-keys")({
  loader: ({ context }) => {
    context.queryClient.prefetchQuery(apiKeysQuery);
  },
  component: ApiKeysScreen,
});

function ApiKeysScreen() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [permission, setPermission] = useState<Permission>("full_access");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);

  const query = useQuery(apiKeysQuery);

  const createMutation = useMutation({
    mutationFn: async () => {
      const result = await api.POST("/api-keys", {
        body: { name: name.trim(), permission },
      });
      return unwrap(result);
    },
    onSuccess: (data) => {
      setCreateOpen(false);
      setName("");
      setPermission("full_access");
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      if (data.token) {
        setCreatedToken(data.token);
      } else {
        toast.success("API key created.");
      }
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (id: string) => {
      const result = await api.DELETE("/api-keys/{api_key_id}", {
        params: { path: { api_key_id: id } },
      });
      return unwrap(result);
    },
    onSuccess: () => {
      toast.success("API key revoked.");
      setRevokeTarget(null);
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const rows = (query.data?.data ?? []) as ApiKeyRow[];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="API Keys"
        description={`Authenticate requests to the ${config.instanceName} API.`}
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            Create API key
          </Button>
        }
      />

      {query.isLoading ? (
        <ListSkeleton rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No API keys"
          description="Create an API key to start sending email through the API."
        >
          <Button onClick={() => setCreateOpen(true)}>
            <Plus />
            Create API key
          </Button>
        </EmptyState>
      ) : (
        <div className="content-reveal overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="border-border/60 hover:bg-transparent">
                <TableHead className="pl-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Name
                </TableHead>
                <TableHead className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Permission
                </TableHead>
                <TableHead className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Created
                </TableHead>
                <TableHead className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Last used
                </TableHead>
                <TableHead className="w-0 pr-4 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Actions
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((key) => (
                <TableRow key={key.id} className="group border-border/60">
                  <TableCell className="py-3 pl-4 font-medium">{key.name}</TableCell>
                  <TableCell className="py-3">
                    {key.permission ? (
                      <Badge variant="secondary">{humanize(key.permission)}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="py-3 tabular-nums text-muted-foreground">
                    {formatRelative(key.created_at)}
                  </TableCell>
                  <TableCell className="py-3 tabular-nums text-muted-foreground">
                    {formatRelative(key.last_used_at)}
                  </TableCell>
                  <TableCell className="py-3 pr-4 text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Revoke ${key.name}`}
                      onClick={() => setRevokeTarget(key)}
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateDialog
        open={createOpen}
        onOpenChange={(next) => {
          if (!createMutation.isPending) setCreateOpen(next);
        }}
        name={name}
        onNameChange={setName}
        permission={permission}
        onPermissionChange={setPermission}
        pending={createMutation.isPending}
        onSubmit={() => createMutation.mutate()}
      />

      <TokenDialog token={createdToken} onClose={() => setCreatedToken(null)} />

      <RevokeDialog
        target={revokeTarget}
        pending={revokeMutation.isPending}
        onOpenChange={(next) => {
          if (!next && !revokeMutation.isPending) setRevokeTarget(null);
        }}
        onConfirm={() => {
          if (revokeTarget) revokeMutation.mutate(revokeTarget.id);
        }}
      />
    </div>
  );
}

function CreateDialog({
  open,
  onOpenChange,
  name,
  onNameChange,
  permission,
  onPermissionChange,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onNameChange: (value: string) => void;
  permission: Permission;
  onPermissionChange: (value: Permission) => void;
  pending: boolean;
  onSubmit: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim().length > 0 && !pending) onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              Give the key a name and choose what it is allowed to do.
            </DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="api-key-name">Name</FieldLabel>
              <Input
                id="api-key-name"
                value={name}
                autoFocus
                placeholder="Production"
                onChange={(event) => onNameChange(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="api-key-permission">Permission</FieldLabel>
              <Select
                value={permission}
                onValueChange={(value) => onPermissionChange(value as Permission)}
              >
                <SelectTrigger id="api-key-permission" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="full_access">Full access</SelectItem>
                  <SelectItem value="sending_access">Sending access</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || name.trim().length === 0}>
              {pending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TokenDialog({ token, onClose }: { token: string | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (!token) return;
    navigator.clipboard
      .writeText(token)
      .then(() => {
        setCopied(true);
        toast.success("Copied to clipboard.");
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch((error: unknown) => {
        console.error(error);
        toast.error("Could not copy to clipboard.");
      });
  };

  return (
    <Dialog
      open={token !== null}
      onOpenChange={(next) => {
        if (!next) {
          setCopied(false);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>API key created</DialogTitle>
          <DialogDescription>
            Copy your key now. For security reasons, you won&apos;t be able to see it again.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-md border bg-muted p-2">
          <code className="flex-1 overflow-x-auto whitespace-nowrap px-1 font-mono text-sm">
            {token}
          </code>
          <Button variant="outline" size="icon" aria-label="Copy API key" onClick={copy}>
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>

        <DialogFooter>
          <Button
            onClick={() => {
              setCopied(false);
              onClose();
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevokeDialog({
  target,
  pending,
  onOpenChange,
  onConfirm,
}: {
  target: ApiKeyRow | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke API key</DialogTitle>
          <DialogDescription>
            {target
              ? `Revoke "${target.name}"? Any request using this key will immediately stop working. This cannot be undone.`
              : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending ? "Revoking…" : "Revoke"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
