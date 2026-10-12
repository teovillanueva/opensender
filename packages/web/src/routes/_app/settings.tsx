import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { PageHeader } from "@/components/page-header";

const TABS: { to: string; label: string; exact?: boolean }[] = [
  { to: "/settings", label: "General", exact: true },
  { to: "/settings/members", label: "Members" },
  { to: "/settings/usage", label: "Usage" },
  { to: "/settings/account", label: "Account" },
];

/**
 * Settings shell: team-scoped tabs (General, Members, Usage) plus the
 * signed-in user's Account tab. Each tab is a child route so sections are
 * deep-linkable and the router treats tab moves as lateral transitions.
 */
export const Route = createFileRoute("/_app/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Settings" description="Manage your team, members and account." />

      <nav aria-label="Settings sections" className="flex gap-1 border-b">
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            activeOptions={{ exact: tab.exact ?? false }}
            // Styled off Link's data-status attribute — activeProps classes
            // would collide with the base border-transparent utility.
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground data-[status=active]:border-primary data-[status=active]:text-foreground"
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {/* Named in CSS during nav-settings transitions so only the tab panel
          animates while the header and tab bar stay put. */}
      <div data-settings-content>
        <Outlet />
      </div>
    </div>
  );
}
