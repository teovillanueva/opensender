import { createFileRoute, Link, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { TeamSwitcher } from "@/components/team-switcher";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { UserMenu } from "@/components/user-menu";
import { NAV_ITEMS } from "@/lib/nav";
import { ensureSessionGuard } from "@/lib/teams";

/**
 * The authenticated dashboard shell (SPEC §13): a persistent sidebar (team
 * switcher, nav, account menu) plus a header, wrapping every screen. `beforeLoad`
 * enforces a live session AND an active team — the API derives the acting team
 * from the session's active organization, so a user with no team is routed to
 * team creation instead of a dashboard whose every request would 401. The guard
 * result is cached (see `ensureSessionGuard`), so only the very first load pays
 * a network round trip — subsequent navigations resolve synchronously.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ location }) => {
    const guard = await ensureSessionGuard();
    if (guard.status === "unauthenticated") {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
    if (guard.status === "no-team") {
      throw redirect({ to: "/new-team" });
    }
  },
  component: AppLayout,
});

function AppLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader className="px-3 pt-3">
          <TeamSwitcher />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup className="px-3">
            <SidebarGroupContent>
              <SidebarMenu className="gap-1.5">
                {NAV_ITEMS.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={pathname === item.to || pathname.startsWith(`${item.to}/`)}
                      tooltip={item.label}
                      className="h-9 px-3"
                    >
                      <Link to={item.to}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="px-3 pb-3">
          <UserMenu />
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 px-4">
          <SidebarTrigger className="-ml-1 md:hidden" />
          <div className="ml-auto flex items-center gap-1">
            <a
              href="https://resend.com/docs"
              target="_blank"
              rel="noreferrer"
              className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Docs
            </a>
          </div>
        </header>
        <main className="flex-1 overflow-auto px-6 pb-10 pt-2 [view-transition-name:main-content] md:px-10">
          <div className="mx-auto w-full max-w-6xl">
            <Outlet />
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
