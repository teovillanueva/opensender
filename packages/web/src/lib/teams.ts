import { authClient } from "@/lib/auth";

/**
 * Teams are Better-auth organizations (SPEC §13). The API derives the acting
 * team from the session's `activeOrganizationId`, so the dashboard must keep an
 * active organization selected at all times — otherwise every authed request
 * fails with `missing_api_key`. These helpers centralize that contract.
 */

export interface Team {
  id: string;
  name: string;
  slug: string;
  logo?: string | null | undefined;
}

/** A URL-safe, collision-resistant slug derived from a team name. */
function toTeamSlug(name: string): string {
  const base =
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "team";
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Create a team, wait for its SES tenant/Team record (server hook), and make
 * it the active organization so the API immediately scopes to it. */
export async function createTeam(name: string): Promise<Team> {
  const created = await authClient.organization.create({ name, slug: toTeamSlug(name) });
  if (created.error || !created.data) {
    throw new Error(created.error?.message ?? "Could not create the team.");
  }
  const team = created.data as Team;
  await authClient.organization.setActive({ organizationId: team.id });
  return team;
}

export async function switchTeam(organizationId: string): Promise<void> {
  const result = await authClient.organization.setActive({ organizationId });
  if (result.error) throw new Error(result.error.message ?? "Could not switch teams.");
}

export type SessionGuard =
  | { status: "unauthenticated" }
  | { status: "no-team" }
  | { status: "ready"; teamId: string };

let guardPromise: Promise<SessionGuard> | null = null;

async function resolveGuard(): Promise<SessionGuard> {
  const session = await authClient.getSession();
  if (!session.data) return { status: "unauthenticated" };

  const active = session.data.session.activeOrganizationId;
  if (active) return { status: "ready", teamId: active };

  const orgs = await authClient.organization.list();
  const first = (orgs.data as Team[] | undefined)?.[0];
  if (!first) return { status: "no-team" };
  await authClient.organization.setActive({ organizationId: first.id });
  return { status: "ready", teamId: first.id };
}

/**
 * Guarantee the session has an active team. Called by the app shell's
 * `beforeLoad` on every navigation, so the resolved guard is cached for the
 * lifetime of the page: sign-in, sign-out, team switch and team creation all
 * happen through full page loads (`window.location`), which resets the module
 * cache — intra-app navigation never re-fetches the session. Only a "ready"
 * result is cached; unauthenticated/no-team re-check on the next navigation.
 */
export function ensureSessionGuard(): Promise<SessionGuard> {
  if (!guardPromise) {
    guardPromise = resolveGuard()
      .then((guard) => {
        if (guard.status !== "ready") guardPromise = null;
        return guard;
      })
      .catch((error) => {
        guardPromise = null;
        throw error;
      });
  }
  return guardPromise;
}
