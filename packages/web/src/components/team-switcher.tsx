import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { PendingInvitationList, usePendingInvitations } from "@/components/pending-invitations";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth";
import { switchTeam, type Team } from "@/lib/teams";

function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "T";
}

/** Sidebar team (organization) switcher: shows the active team and lets the
 * user switch or create a new one (SPEC §13). */
export function TeamSwitcher() {
  const navigate = useNavigate();
  const { data: teams } = authClient.useListOrganizations();
  const { data: active } = authClient.useActiveOrganization();
  const invitations = usePendingInvitations();
  const list = (teams ?? []) as Team[];
  const activeName = active?.name ?? "Select team";

  async function onSwitch(id: string) {
    if (id === active?.id) return;
    await switchTeam(id);
    window.location.reload();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring">
        <div className="flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-emerald-600 to-emerald-800 text-xs font-semibold text-white">
          {initial(activeName)}
        </div>
        <span className="flex-1 truncate text-sm font-medium">{activeName}</span>
        <ChevronsUpDown className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Teams</DropdownMenuLabel>
        {list.map((team) => (
          <DropdownMenuItem key={team.id} onSelect={() => onSwitch(team.id)} className="gap-2">
            <div className="flex size-5 items-center justify-center rounded bg-gradient-to-br from-emerald-600 to-emerald-800 text-[10px] font-semibold text-white">
              {initial(team.name)}
            </div>
            <span className="flex-1 truncate">{team.name}</span>
            {team.id === active?.id && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate({ to: "/new-team" })} className="gap-2">
          <Plus className="size-4" />
          Create team
        </DropdownMenuItem>
        {invitations.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Invitations
            </DropdownMenuLabel>
            <PendingInvitationList invitations={invitations} />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
