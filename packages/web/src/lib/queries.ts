import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { api, unwrap } from "@/lib/api";
import { authClient } from "@/lib/auth";

/** Narrow a better-auth client result to its data, throwing the error message. */
function unwrapAuth<T>(result: { data: T | null; error: { message?: string } | null }): T {
  if (result.error) throw new Error(result.error.message ?? "Request failed");
  return result.data as T;
}

/**
 * Shared query definitions, used from two places: the screen components
 * (via useQuery/useInfiniteQuery) and the route loaders (via prefetchQuery).
 * Routes prefetch on `defaultPreload: "intent"`, so hovering a link starts the
 * fetch before the click and navigation usually lands on already-cached data.
 */

export interface EmailListFilter {
  /** Trailing-window length in days; undefined = all time. */
  rangeDays?: number | undefined;
  status?: string | undefined;
  apiKeyId?: string | undefined;
}

/** Start of the trailing window, hour-aligned so the query key stays stable. */
function rangeStart(days: number): string {
  const start = new Date(Date.now() - days * 86_400_000);
  start.setMinutes(0, 0, 0);
  return start.toISOString();
}

export const emailsQuery = (direction: "outbound" | "inbound", filter: EmailListFilter = {}) =>
  infiniteQueryOptions({
    queryKey: [
      "emails",
      direction,
      filter.status ?? "all",
      filter.rangeDays ?? "all",
      filter.apiKeyId ?? "all",
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET("/internal/emails", {
          params: {
            query: {
              limit: 25,
              direction,
              cursor: pageParam,
              status: filter.status,
              after: filter.rangeDays ? rangeStart(filter.rangeDays) : undefined,
              api_key_id: filter.apiKeyId,
            },
          },
        }),
      ),
    getNextPageParam: (lastPage) => (lastPage.cursor ?? undefined) as string | undefined,
  });

export const metricsQuery = (days: number, domain?: string) =>
  queryOptions({
    queryKey: ["metrics", days, domain ?? "all"],
    queryFn: async () =>
      unwrap(
        await api.GET("/internal/metrics", {
          params: { query: { days, domain } },
        }),
      ),
    staleTime: 60_000,
  });

export const suppressionsQuery = infiniteQueryOptions({
  queryKey: ["suppressions"],
  initialPageParam: undefined as string | undefined,
  queryFn: async ({ pageParam }) =>
    unwrap(
      await api.GET("/internal/suppressions", {
        params: { query: { limit: 50, cursor: pageParam } },
      }),
    ),
  getNextPageParam: (lastPage) => (lastPage.cursor ?? undefined) as string | undefined,
});

export const suppressionQuery = (email: string) =>
  queryOptions({
    queryKey: ["suppression", email],
    queryFn: async () =>
      unwrap(await api.GET("/internal/suppressions/{email}", { params: { path: { email } } })),
  });

export const emailQuery = (id: string) =>
  queryOptions({
    queryKey: ["email", id],
    queryFn: async () =>
      unwrap(await api.GET("/internal/emails/{id}", { params: { path: { id } } })),
  });

/** Inbound-only enrichment: headers + attachment metadata (SPEC §5.14). */
export const receivedEmailQuery = (id: string) =>
  queryOptions({
    queryKey: ["email", id, "received"],
    queryFn: async () =>
      unwrap(await api.GET("/emails/receiving/{email_id}", { params: { path: { email_id: id } } })),
  });

export const domainsQuery = queryOptions({
  queryKey: ["domains"],
  queryFn: async () => unwrap(await api.GET("/domains", { params: { query: { limit: 100 } } })),
});

export const domainQuery = (id: string) =>
  queryOptions({
    queryKey: ["domain", id],
    queryFn: async () =>
      unwrap(await api.GET("/domains/{domain_id}", { params: { path: { domain_id: id } } })),
  });

export const apiKeysQuery = queryOptions({
  queryKey: ["api-keys"],
  queryFn: async () => unwrap(await api.GET("/api-keys", { params: { query: { limit: 100 } } })),
});

export const webhooksQuery = queryOptions({
  queryKey: ["webhooks"],
  queryFn: async () => unwrap(await api.GET("/webhooks", { params: { query: { limit: 100 } } })),
});

export const webhookQuery = (id: string) =>
  queryOptions({
    queryKey: ["webhook", id],
    queryFn: async () =>
      unwrap(await api.GET("/webhooks/{webhook_id}", { params: { path: { webhook_id: id } } })),
  });

export const webhookDeliveriesQuery = (id: string) =>
  infiniteQueryOptions({
    queryKey: ["webhook", id, "deliveries"],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) =>
      unwrap(
        await api.GET("/internal/webhooks/{id}/deliveries", {
          params: { path: { id }, query: { limit: 25, cursor: pageParam } },
        }),
      ),
    getNextPageParam: (lastPage) => lastPage.cursor ?? undefined,
  });

export const audiencesQuery = queryOptions({
  queryKey: ["audiences"],
  queryFn: async () => unwrap(await api.GET("/audiences", {})),
});

export const audienceQuery = (id: string) =>
  queryOptions({
    queryKey: ["audience", id],
    queryFn: async () => unwrap(await api.GET("/audiences/{id}", { params: { path: { id } } })),
  });

export const contactsQuery = (audienceId: string) =>
  queryOptions({
    queryKey: ["contacts", audienceId],
    queryFn: async () =>
      unwrap(await api.GET("/audiences/{id}/contacts", { params: { path: { id: audienceId } } })),
  });

export const broadcastsQuery = queryOptions({
  queryKey: ["broadcasts"],
  queryFn: async () => unwrap(await api.GET("/broadcasts")),
});

export const broadcastQuery = (id: string) =>
  queryOptions({
    queryKey: ["broadcast", id],
    queryFn: async () => unwrap(await api.GET("/broadcasts/{id}", { params: { path: { id } } })),
  });

export const usageQuery = queryOptions({
  queryKey: ["usage"],
  queryFn: async () => unwrap(await api.GET("/internal/usage", {})),
});

/** The active organization with its members and pending invitations. */
export const fullOrganizationQuery = queryOptions({
  queryKey: ["organization", "full"],
  queryFn: async () => unwrapAuth(await authClient.organization.getFullOrganization()),
});

/** The signed-in user's membership in the active organization (role checks). */
export const activeMemberQuery = queryOptions({
  queryKey: ["organization", "active-member"],
  queryFn: async () => unwrapAuth(await authClient.organization.getActiveMember()),
});

/** Invitations addressed to the signed-in user across all organizations. */
export const userInvitationsQuery = queryOptions({
  queryKey: ["user-invitations"],
  queryFn: async () => unwrapAuth(await authClient.organization.listUserInvitations()),
});

/** The user's active sessions (Account → Security). */
export const sessionsQuery = queryOptions({
  queryKey: ["sessions"],
  queryFn: async () => unwrapAuth(await authClient.listSessions()),
});
