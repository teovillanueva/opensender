import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Mail, Plug, Plus, Trash2, UserRound, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/list-skeleton";
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
import { api, unwrap } from "@/lib/api";
import { authClient } from "@/lib/auth";
import { formatRelative, humanize } from "@/lib/format";
import { activeMemberQuery, fullOrganizationQuery } from "@/lib/queries";

type AssignableRole = "member" | "admin";

interface MemberRow {
  id: string;
  role: string;
  createdAt?: string;
  user: { id?: string; name?: string; email?: string; image?: string | null };
}

interface InvitationRow {
  id: string;
  email: string;
  role?: string;
  status: string;
  expiresAt?: string;
}

export const Route = createFileRoute("/_app/settings/members")({
  loader: ({ context }) => {
    context.queryClient.prefetchQuery(fullOrganizationQuery);
    context.queryClient.prefetchQuery(activeMemberQuery);
  },
  component: MembersScreen,
});

function initial(value: string): string {
  return value.trim().charAt(0).toUpperCase() || "U";
}

function MembersScreen() {
  const queryClient = useQueryClient();
  const orgQuery = useQuery(fullOrganizationQuery);
  const meQuery = useQuery(activeMemberQuery);
  const { data: session } = authClient.useSession();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<MemberRow | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["organization"] });

  const members = ((orgQuery.data?.members ?? []) as unknown as MemberRow[]).slice().sort(
    // Owners first, then admins, then members; stable by join date within a role.
    (a, b) => roleRank(a.role) - roleRank(b.role),
  );
  const invitations = ((orgQuery.data?.invitations ?? []) as unknown as InvitationRow[]).filter(
    (invitation) => invitation.status === "pending",
  );

  const myRole = meQuery.data?.role ?? "member";
  const canManage = myRole === "owner" || myRole === "admin";

  const changeRole = useMutation({
    mutationFn: async ({ memberId, role }: { memberId: string; role: AssignableRole }) => {
      const result = await authClient.organization.updateMemberRole({ memberId, role });
      if (result.error) throw new Error(result.error.message ?? "Could not change the role.");
    },
    onSuccess: () => {
      toast.success("Role updated");
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: async (member: MemberRow) => {
      const result = await authClient.organization.removeMember({
        memberIdOrEmail: member.id,
      });
      if (result.error) throw new Error(result.error.message ?? "Could not remove the member.");
    },
    onSuccess: () => {
      toast.success("Member removed");
      setRemoveTarget(null);
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const cancelInvitation = useMutation({
    mutationFn: async (invitationId: string) => {
      const result = await authClient.organization.cancelInvitation({ invitationId });
      if (result.error) {
        throw new Error(result.error.message ?? "Could not cancel the invitation.");
      }
    },
    onSuccess: () => {
      toast.success("Invitation canceled");
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (orgQuery.isLoading) {
    return <ListSkeleton rows={4} />;
  }
  if (orgQuery.isError) {
    return <p className="text-sm text-destructive">Failed to load members.</p>;
  }

  return (
    <div className="content-reveal flex flex-col gap-8">
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold tracking-tight">Members</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {members.length} {members.length === 1 ? "person" : "people"} in this team.
            </p>
          </div>
          {canManage && (
            <Button onClick={() => setInviteOpen(true)}>
              <Plus />
              Invite member
            </Button>
          )}
        </div>

        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="border-border/60 hover:bg-transparent">
                <TableHead className="pl-4">Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="text-right">Joined</TableHead>
                {canManage && (
                  <TableHead className="w-0 pr-4">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((member) => {
                const isSelf = member.user.id === session?.user.id;
                const isOwner = member.role === "owner";
                const displayName = member.user.name || member.user.email || "Unknown";
                return (
                  <TableRow key={member.id} className="border-border/60">
                    <TableCell className="py-3 pl-4">
                      <div className="flex items-center gap-3">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                          {initial(displayName)}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 font-medium">
                            <span className="truncate">{displayName}</span>
                            {isSelf && <Badge variant="secondary">You</Badge>}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {member.user.email ?? "—"}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="w-0 py-3">
                      {canManage && !isOwner && !isSelf ? (
                        <Select
                          value={member.role}
                          onValueChange={(role) =>
                            changeRole.mutate({ memberId: member.id, role: role as AssignableRole })
                          }
                          disabled={changeRole.isPending}
                        >
                          <SelectTrigger
                            size="sm"
                            className="w-28"
                            aria-label={`Role for ${displayName}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="member">Member</SelectItem>
                            <SelectItem value="admin">Admin</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant="secondary">{humanize(member.role)}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="w-0 whitespace-nowrap py-3 text-right text-sm tabular-nums text-muted-foreground">
                      {formatRelative(member.createdAt)}
                    </TableCell>
                    {canManage && (
                      <TableCell className="w-0 py-3 pr-4">
                        {!isOwner && !isSelf && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground hover:text-destructive"
                            aria-label={`Remove ${displayName}`}
                            onClick={() => setRemoveTarget(member)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <h2 className="font-semibold tracking-tight">Pending Invitations</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Invitees see their invitation in the team switcher when they sign in with the invited
            email.
          </p>
        </div>

        {invitations.length === 0 ? (
          <EmptyState icon={Mail} title="No pending invitations" />
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow className="border-border/60 hover:bg-transparent">
                  <TableHead className="pl-4">Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="text-right">Expires</TableHead>
                  {canManage && (
                    <TableHead className="w-0 pr-4">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {invitations.map((invitation) => (
                  <TableRow key={invitation.id} className="border-border/60">
                    <TableCell className="py-3 pl-4 font-medium">{invitation.email}</TableCell>
                    <TableCell className="w-0 py-3">
                      <Badge variant="secondary">{humanize(invitation.role ?? "member")}</Badge>
                    </TableCell>
                    <TableCell className="w-0 whitespace-nowrap py-3 text-right text-sm tabular-nums text-muted-foreground">
                      {formatRelative(invitation.expiresAt)}
                    </TableCell>
                    {canManage && (
                      <TableCell className="w-0 py-3 pr-4">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={`Cancel invitation for ${invitation.email}`}
                          onClick={() => cancelInvitation.mutate(invitation.id)}
                          disabled={cancelInvitation.isPending}
                        >
                          <X className="size-4" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <ConnectedAppsSection />

      <InviteMemberDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onInvited={() => {
          setInviteOpen(false);
          invalidate();
        }}
      />

      <Dialog open={removeTarget !== null} onOpenChange={(next) => !next && setRemoveTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove member?</DialogTitle>
            <DialogDescription>
              Remove{" "}
              <span className="font-medium text-foreground">
                {removeTarget?.user.email ?? removeTarget?.user.name}
              </span>{" "}
              from this team? They immediately lose access to its data.
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
              onClick={() => removeTarget && remove.mutate(removeTarget)}
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

function roleRank(role: string): number {
  if (role === "owner") return 0;
  if (role === "admin") return 1;
  return 2;
}

interface GrantRow {
  id: string;
  client_id: string;
  client_name?: string | null;
  scopes: string[];
  created_at?: string | null;
  last_used_at?: string | null;
  domain_ids?: string[] | null;
}

const GRANTS_QUERY_KEY = ["oauth-grants"] as const;

const grantsQuery = {
  queryKey: GRANTS_QUERY_KEY,
  queryFn: async () => unwrap(await api.GET("/internal/oauth-grants")),
};

/**
 * OAuth grants: apps the signed-in user consented
 * to on this team. Revoking deletes the consent AND kills its refresh tokens
 * server-side; outstanding access tokens die within 15 minutes.
 */
function ConnectedAppsSection() {
  const queryClient = useQueryClient();
  const [revokeTarget, setRevokeTarget] = useState<GrantRow | null>(null);
  const query = useQuery(grantsQuery);

  const revoke = useMutation({
    mutationFn: async (id: string) =>
      unwrap(await api.POST("/internal/oauth-grants/{id}/revoke", { params: { path: { id } } })),
    onSuccess: () => {
      toast.success("Access revoked.");
      setRevokeTarget(null);
      queryClient.invalidateQueries({ queryKey: GRANTS_QUERY_KEY });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const rows = (query.data?.data ?? []) as GrantRow[];

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="font-semibold tracking-tight">Connected apps</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Apps you granted access to this team through OAuth.
        </p>
      </div>

      {query.isLoading ? (
        <ListSkeleton rows={2} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No connected apps"
          description="When you authorize an app (a CLI, an integration, an MCP host) it will show up here."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow className="border-border/60 hover:bg-transparent">
                <TableHead className="pl-4">App</TableHead>
                <TableHead>Permission</TableHead>
                <TableHead className="text-right">Granted</TableHead>
                <TableHead className="text-right">Last used</TableHead>
                <TableHead className="w-0 pr-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((grant) => (
                <TableRow key={grant.id} className="border-border/60">
                  <TableCell className="py-3 pl-4 font-medium">
                    {grant.client_name ?? grant.client_id}
                  </TableCell>
                  <TableCell className="w-0 whitespace-nowrap py-3">
                    <Badge variant="secondary">
                      {grant.scopes.includes("full_access") ? "Full access" : "Sending access"}
                      {grant.domain_ids && grant.domain_ids.length > 0
                        ? ` · ${grant.domain_ids.length} ${grant.domain_ids.length === 1 ? "domain" : "domains"}`
                        : ""}
                    </Badge>
                  </TableCell>
                  <TableCell className="w-0 whitespace-nowrap py-3 text-right text-sm tabular-nums text-muted-foreground">
                    {formatRelative(grant.created_at ?? undefined)}
                  </TableCell>
                  <TableCell className="w-0 whitespace-nowrap py-3 text-right text-sm tabular-nums text-muted-foreground">
                    {formatRelative(grant.last_used_at ?? undefined)}
                  </TableCell>
                  <TableCell className="w-0 py-3 pr-4">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Revoke ${grant.client_name ?? grant.client_id}`}
                      onClick={() => setRevokeTarget(grant)}
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

      <Dialog open={revokeTarget !== null} onOpenChange={(next) => !next && setRevokeTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Revoke access?</DialogTitle>
            <DialogDescription>
              Disconnect{" "}
              <span className="font-medium text-foreground">
                {revokeTarget?.client_name ?? revokeTarget?.client_id}
              </span>
              ? Its refresh tokens are revoked immediately; any unexpired access token stops working
              within 15 minutes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRevokeTarget(null)}
              disabled={revoke.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => revokeTarget && revoke.mutate(revokeTarget.id)}
              disabled={revoke.isPending}
            >
              {revoke.isPending ? "Revoking…" : "Revoke"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function InviteMemberDialog({
  open,
  onOpenChange,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvited: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("member");

  const invite = useMutation({
    mutationFn: async () => {
      const result = await authClient.organization.inviteMember({ email: email.trim(), role });
      if (result.error) throw new Error(result.error.message ?? "Could not send the invitation.");
    },
    onSuccess: () => {
      toast.success(`Invitation created for ${email.trim()}`);
      setEmail("");
      setRole("member");
      onInvited();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const canSubmit = email.includes("@") && !invite.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite member</DialogTitle>
          <DialogDescription>
            No email is sent — the invitee sees the invitation in their team switcher when they sign
            in with this address.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) invite.mutate();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="invite-email">Email</FieldLabel>
              <Input
                id="invite-email"
                type="email"
                autoComplete="off"
                spellCheck={false}
                placeholder="teammate@company.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="invite-role">Role</FieldLabel>
              <Select value={role} onValueChange={(value) => setRole(value as AssignableRole)}>
                <SelectTrigger id="invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={invite.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              <UserRound />
              {invite.isPending ? "Inviting…" : "Invite"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
