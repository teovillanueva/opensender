import { useNavigate } from "@tanstack/react-router";
import { LogOut, UserRound } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient, signOut } from "@/lib/auth";

function initial(value: string): string {
  return value.trim().charAt(0).toUpperCase() || "U";
}

/** Sidebar footer account menu: shows the signed-in user and signs out. */
export function UserMenu() {
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const email = session?.user.email ?? "";
  const name = session?.user.name ?? email;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring">
        <div className="flex size-6 items-center justify-center rounded-full bg-muted text-xs font-semibold">
          {initial(name)}
        </div>
        <span className="flex-1 truncate text-sm text-muted-foreground">{email}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel className="truncate">{email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate({ to: "/settings/account" })} className="gap-2">
          <UserRound className="size-4" />
          Account settings
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={async () => {
            await signOut();
            window.location.href = "/login";
          }}
          className="gap-2"
        >
          <LogOut className="size-4" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
