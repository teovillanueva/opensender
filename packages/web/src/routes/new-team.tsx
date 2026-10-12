import { createFileRoute, redirect } from "@tanstack/react-router";
import { Hash } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PendingInvitationList, usePendingInvitations } from "@/components/pending-invitations";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth";
import { createTeam } from "@/lib/teams";

/**
 * Create-team screen (SPEC §13). Shown when a signed-in user has no team yet —
 * a fresh CLI-created user, or the first admin. Creating a team provisions its
 * SES tenant + Team record server-side (the org-creation hook) and makes it the
 * active organization, after which the dashboard's authed calls resolve.
 */
export const Route = createFileRoute("/new-team")({
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (!session.data) throw redirect({ to: "/login", search: {} });
  },
  component: NewTeamScreen,
});

function NewTeamScreen() {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const invitations = usePendingInvitations();

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setPending(true);
    try {
      await createTeam(name.trim());
      window.location.href = "/welcome";
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the team.");
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <div className="flex flex-1 items-center justify-center p-6">
        <form onSubmit={onSubmit} className="w-full max-w-sm text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Create new team</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Continue to start sending emails and inviting members.
          </p>

          {invitations.length > 0 && (
            <div className="mt-6 rounded-xl border p-3 text-left">
              <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                You've been invited
              </p>
              <PendingInvitationList invitations={invitations} />
            </div>
          )}

          <div className="mt-8 flex flex-col items-center gap-2">
            <div className="flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-700 to-emerald-900 text-white">
              <Hash className="size-7" />
            </div>
          </div>

          <FieldGroup className="mt-8 text-left">
            <Field>
              <FieldLabel htmlFor="team-name">Team name</FieldLabel>
              <Input
                id="team-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme"
                autoFocus
                required
              />
            </Field>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending && <Spinner />}
              Continue
            </Button>
          </FieldGroup>
        </form>
      </div>
    </div>
  );
}
