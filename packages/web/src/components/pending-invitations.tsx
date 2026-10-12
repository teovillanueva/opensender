import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Mail } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth";
import { humanize } from "@/lib/format";
import { userInvitationsQuery } from "@/lib/queries";

interface UserInvitation {
  id: string;
  organizationId: string;
  organizationName?: string;
  role?: string;
  status: string;
}

export function usePendingInvitations(): UserInvitation[] {
  const query = useQuery(userInvitationsQuery);
  return ((query.data ?? []) as unknown as UserInvitation[]).filter(
    (invitation) => invitation.status === "pending",
  );
}

/**
 * Invitations addressed to the signed-in user, with one-click accept. The
 * instance sends no invitation emails (SPEC §13 auth is self-contained), so
 * this list — rendered in the team switcher and on the create-team screen —
 * is how an invite actually reaches its recipient.
 */
export function PendingInvitationList({ invitations }: { invitations: UserInvitation[] }) {
  const accept = useMutation({
    mutationFn: async (invitation: UserInvitation) => {
      const accepted = await authClient.organization.acceptInvitation({
        invitationId: invitation.id,
      });
      if (accepted.error) {
        throw new Error(accepted.error.message ?? "Could not accept the invitation.");
      }
      await authClient.organization.setActive({ organizationId: invitation.organizationId });
    },
    onSuccess: () => {
      // Full reload: resets the cached session guard and lands on the new team.
      window.location.href = "/emails";
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="flex flex-col gap-1">
      {invitations.map((invitation) => (
        <div
          key={invitation.id}
          className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5"
        >
          <div className="flex min-w-0 items-center gap-2">
            <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">
                {invitation.organizationName ?? "A team"}
              </p>
              <p className="text-xs text-muted-foreground">
                as {humanize(invitation.role ?? "member")}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => accept.mutate(invitation)}
            disabled={accept.isPending}
          >
            <Check className="size-3.5" />
            {accept.isPending ? "Joining…" : "Accept"}
          </Button>
        </div>
      ))}
    </div>
  );
}
