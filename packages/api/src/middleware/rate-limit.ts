import type { RateLimiterPort, Team, TeamsPort } from "@opensender/core";
import type { MiddlewareHandler } from "hono";
import { errors, sendError } from "../errors.js";

/**
 * getTeam is read on every authenticated request just to derive the plan's
 * rate limit. Memoizing it for a short TTL, scoped to this container's
 * lifetime, skips that DynamoDB read for repeated requests from the same
 * team in a warm Lambda without going stale for long.
 */
const TEAM_CACHE_TTL_MS = 30_000;
const teamCache = new Map<string, { team: Team | undefined; expiresAt: number }>();

async function getTeamCached(teams: TeamsPort, teamId: string): Promise<Team | undefined> {
  const cached = teamCache.get(teamId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.team;
  }

  const team = await teams.getTeam(teamId);
  teamCache.set(teamId, { team, expiresAt: now + TEAM_CACHE_TTL_MS });
  return team;
}

/**
 * 10 req/s per team, shared across all the team's keys (SPEC §5.2). The
 * ratelimit-* headers ride on every authenticated response — fixtures show
 * them on 200s, 404s, 405s and the 429 itself, but not on auth failures.
 */
export function rateLimit(deps: {
  rateLimiter: RateLimiterPort;
  teams: TeamsPort;
}): MiddlewareHandler {
  return async (c, next) => {
    const principal = c.get("principal");
    const team = await getTeamCached(deps.teams, principal.teamId);
    const limit = team ? deps.teams.quotasFor(team).apiRateLimitPerSecond : 10;

    const decision = await deps.rateLimiter.consume(principal.teamId, limit);

    const apply = (headers: Headers) => {
      headers.set("ratelimit-limit", String(decision.limit));
      headers.set("ratelimit-remaining", String(decision.remaining));
      headers.set("ratelimit-reset", String(decision.resetSeconds));
      headers.set("ratelimit-policy", `${decision.limit};w=1`);
    };

    if (!decision.allowed) {
      const response = sendError(c, errors.rateLimitExceeded());
      apply(response.headers);
      response.headers.set("retry-after", String(decision.resetSeconds));
      return response;
    }

    await next();
    apply(c.res.headers);
  };
}
