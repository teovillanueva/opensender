import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowRight, Check, ChevronsRight } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { config } from "@/config";
import { api, unwrap } from "@/lib/api";
import { authClient } from "@/lib/auth";
import { cn } from "@/lib/utils";

/**
 * OAuth consent screen (SPEC §13), Resend-style:
 * ONE compact screen owning the whole decision — team dropdown, permission
 * radio group, domain restriction for sending grants, slide-to-allow. The
 * server never detours to a separate team picker (postLogin.shouldRedirect
 * is false); picking a team here sets the active organization, which
 * `consentReferenceId` pins the grant to. The domain restriction is stored
 * via `/internal/oauth-grants/domains` BEFORE consent is accepted so the
 * very first token already carries it.
 *
 * The authorize endpoint redirects here with the signed oauth_query in the
 * URL; the auth client forwards it with the consent call and the server
 * answers with the client callback URL (code + state) to navigate to.
 */

interface PublicClient {
  client_id: string;
  client_name?: string;
  logo_uri?: string;
}

interface AuthorizeStep {
  redirect?: boolean;
  url?: string;
}

export const Route = createFileRoute("/consent")({
  validateSearch: (search: Record<string, unknown>): { client_id?: string; scope?: string } => ({
    client_id: typeof search.client_id === "string" ? search.client_id : undefined,
    scope: typeof search.scope === "string" ? search.scope : undefined,
  }),
  component: ConsentScreen,
});

const PERMISSIONS = {
  full_access: {
    label: "Full access",
    description: "Read, create, and delete any resource.",
  },
  "emails:send": {
    label: "Sending access",
    description: "Send emails on your behalf.",
  },
} as const;

type PermissionScope = keyof typeof PERMISSIONS;

const ALL_DOMAINS = "all";

/** Native view transition around a state change; plain update when the API
 * is missing or the user prefers reduced motion. */
function withViewTransition(update: () => void) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || typeof document.startViewTransition !== "function") {
    update();
    return;
  }
  document.startViewTransition(() => {
    flushSync(update);
  });
}

function ConsentScreen() {
  const search = Route.useSearch();
  const queryClient = useQueryClient();
  const requestedScopes = (search.scope ?? "").split(" ").filter(Boolean);
  const permissionOptions = (["full_access", "emails:send"] as const).filter((scope) =>
    requestedScopes.includes(scope),
  );
  const [chosen, setChosen] = useState<PermissionScope | undefined>(permissionOptions[0]);
  const [domainId, setDomainId] = useState<string>(ALL_DOMAINS);
  const [pending, setPending] = useState<"allow" | "decline" | null>(null);
  const [switchingTeam, setSwitchingTeam] = useState(false);

  const { data: organizations } = authClient.useListOrganizations();
  const { data: activeTeam } = authClient.useActiveOrganization();
  const teamId = activeTeam?.id ?? organizations?.[0]?.id;

  const clientQuery = useQuery({
    queryKey: ["oauth-public-client", search.client_id],
    enabled: Boolean(search.client_id),
    queryFn: async () => {
      const { data, error } = await authClient.$fetch<PublicClient>(
        `/oauth2/public-client?client_id=${encodeURIComponent(search.client_id ?? "")}`,
      );
      if (error) throw new Error("Could not load the requesting app.");
      return data;
    },
  });

  // /domains is scoped by the session's ACTIVE team, hence the teamId key
  // and the immediate setActive on team change below.
  const showDomains = chosen === "emails:send";
  const domainsQuery = useQuery({
    queryKey: ["consent-domains", teamId],
    enabled: Boolean(teamId) && showDomains,
    queryFn: async () => unwrap(await api.GET("/domains")),
  });
  const domains = (domainsQuery.data?.data ?? []) as Array<{ id: string; name: string }>;

  // The signed authorize query in the page URL carries the callback the
  // browser will return to — shown in the footnote, like Resend does.
  const redirectTarget = useMemo(
    () => new URLSearchParams(window.location.search).get("redirect_uri") ?? undefined,
    [],
  );

  async function switchTeam(organizationId: string) {
    setSwitchingTeam(true);
    try {
      const result = await authClient.organization.setActive({ organizationId });
      if (result.error) {
        toast.error(result.error.message ?? "Could not select the team.");
        return;
      }
      setDomainId(ALL_DOMAINS);
      await queryClient.invalidateQueries({ queryKey: ["consent-domains"] });
    } finally {
      setSwitchingTeam(false);
    }
  }

  async function decide(accept: boolean) {
    setPending(accept ? "allow" : "decline");
    try {
      if (accept && search.client_id) {
        // Store (or clear) the domain restriction BEFORE consenting, so the
        // first token issued from the code exchange already carries it.
        const restricted = chosen === "emails:send" && domainId !== ALL_DOMAINS;
        const stored = await api.POST("/internal/oauth-grants/domains", {
          body: {
            client_id: search.client_id,
            domain_ids: restricted ? [domainId] : null,
          },
        });
        if (stored.error) {
          toast.error("Could not store the domain restriction. Try again.");
          return;
        }
      }
      // Granted scopes: the chosen permission plus the non-permission scopes
      // requested (offline_access) — always a subset of the request.
      const scope = accept
        ? [chosen, ...requestedScopes.filter((s) => !(s in PERMISSIONS))].join(" ")
        : undefined;
      const { data, error } = await authClient.$fetch<AuthorizeStep>("/oauth2/consent", {
        method: "POST",
        body: { accept, ...(scope ? { scope } : {}) },
      });
      if (error || !data?.url) {
        toast.error("The authorization request expired. Retry from the connecting app.");
        return;
      }
      window.location.href = data.url;
    } finally {
      setPending(null);
    }
  }

  const appName = clientQuery.data?.client_name ?? "An application";
  const appInitial = (clientQuery.data?.client_name ?? "?").trim().charAt(0).toUpperCase();
  const canAllow = permissionOptions.length > 0 && Boolean(chosen) && Boolean(teamId);
  const busy = pending !== null || switchingTeam;

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-background p-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-7">
        <div className="flex flex-col items-center gap-4">
          <div className="flex size-12 items-center justify-center rounded-2xl border bg-card text-lg font-semibold shadow-sm">
            {clientQuery.data?.logo_uri ? (
              <img
                src={clientQuery.data.logo_uri}
                alt=""
                className="size-full rounded-2xl object-cover"
              />
            ) : (
              appInitial
            )}
          </div>
          <div className="flex flex-col items-center gap-1.5 text-center">
            <h1 className="text-balance text-xl font-semibold tracking-tight">
              {clientQuery.isLoading ? "Loading request…" : `${appName} wants access`}
            </h1>
            <p className="text-sm text-muted-foreground">Pick which team this app can access.</p>
          </div>
        </div>

        <div className="flex w-full flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Team</span>
          <Select value={teamId} onValueChange={switchTeam} disabled={busy}>
            <SelectTrigger className="h-11 w-full rounded-xl">
              <SelectValue placeholder="Select a team" />
            </SelectTrigger>
            <SelectContent>
              {(organizations ?? []).map((org) => (
                <SelectItem key={org.id} value={org.id}>
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded bg-gradient-to-br from-emerald-600 to-emerald-800 text-[10px] font-semibold text-white">
                      {org.name.trim().charAt(0).toUpperCase()}
                    </span>
                    {org.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {(organizations ?? []).length === 0 && (
            <p className="text-xs text-muted-foreground">
              You don&apos;t belong to any team yet — create one in the {config.instanceName}{" "}
              dashboard, then restart the connection from the app.
            </p>
          )}
        </div>

        <div className="flex w-full flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Permission</span>
          <div role="radiogroup" aria-label="Permission" className="flex flex-col gap-2">
            {permissionOptions.map((scope) => {
              const selected = chosen === scope;
              return (
                // biome-ignore lint/a11y/useSemanticElements: styled ARIA radio inside role="radiogroup"
                <button
                  key={scope}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={busy}
                  onClick={() => withViewTransition(() => setChosen(scope))}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors",
                    selected ? "border-emerald-500/50 bg-emerald-500/[0.06]" : "hover:bg-accent/50",
                  )}
                >
                  <span className="text-sm">
                    <span className="font-medium">{PERMISSIONS[scope].label}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {PERMISSIONS[scope].description}
                    </span>
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                      selected ? "border-emerald-500" : "border-muted-foreground/40",
                    )}
                  >
                    <span
                      className={cn(
                        "size-2 rounded-full bg-emerald-500 transition-transform",
                        selected ? "scale-100" : "scale-0",
                      )}
                    />
                  </span>
                </button>
              );
            })}
            {permissionOptions.length === 0 && (
              <p className="text-sm text-muted-foreground">
                This request carries no recognized permission scope and cannot be granted.
              </p>
            )}
          </div>
        </div>

        {showDomains && (
          <div className="vt-consent-domain flex w-full flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Domain</span>
            <Select value={domainId} onValueChange={setDomainId} disabled={busy}>
              <SelectTrigger className="h-11 w-full rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_DOMAINS}>All domains</SelectItem>
                {domains.map((domain) => (
                  <SelectItem key={domain.id} value={domain.id}>
                    {domain.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="vt-consent-actions flex w-full flex-col gap-4">
          <SlideToAllow
            disabled={!canAllow || switchingTeam}
            pending={pending === "allow"}
            onComplete={() => decide(true)}
          />
          <p className="text-center text-xs text-muted-foreground">
            {redirectTarget ? (
              <>
                Allow access to <span className="text-foreground/80">{redirectTarget}</span>, or{" "}
              </>
            ) : (
              "Or "
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => decide(false)}
              className="underline underline-offset-2 hover:text-foreground"
            >
              decline
            </button>
            .
          </p>
        </div>
      </div>
    </div>
  );
}

const KNOB_SIZE = 44;
const TRACK_PADDING = 4;
const TRACK_HEIGHT = KNOB_SIZE + TRACK_PADDING * 2;

/**
 * Resend's slide-to-allow: drag the knob across the track to confirm. The
 * fill trails the knob, the hint fades as you drag, and completion locks the
 * knob at the end. Keyboard users press Enter/Space on the focused knob.
 */
function SlideToAllow({
  disabled,
  pending,
  onComplete,
}: {
  disabled: boolean;
  pending: boolean;
  onComplete: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [x, setX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [completed, setCompleted] = useState(false);

  const maxX = () => {
    const width = trackRef.current?.getBoundingClientRect().width ?? 0;
    return Math.max(0, width - KNOB_SIZE - TRACK_PADDING * 2);
  };

  const complete = () => {
    setCompleted(true);
    setX(maxX());
    onComplete();
  };

  function onPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (disabled || pending || completed) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }

  function onPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    if (!dragging) return;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = event.clientX - rect.left - TRACK_PADDING - KNOB_SIZE / 2;
    setX(Math.min(Math.max(0, next), maxX()));
  }

  function onPointerUp() {
    if (!dragging) return;
    setDragging(false);
    if (x >= maxX() * 0.92) complete();
    else setX(0);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled || pending || completed) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      complete();
    }
  }

  const progress = maxX() > 0 ? x / maxX() : 0;
  const settled = completed || pending;

  return (
    <div
      ref={trackRef}
      className={cn(
        "relative w-full select-none overflow-hidden rounded-full border bg-secondary/60 shadow-inner transition-opacity",
        disabled && "opacity-50",
      )}
      style={{ height: TRACK_HEIGHT }}
    >
      <div
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 bg-emerald-500/15",
          !dragging && "transition-[width] duration-300 ease-out",
        )}
        style={{ width: settled ? "100%" : x + KNOB_SIZE + TRACK_PADDING * 2 }}
      />
      <span
        aria-hidden
        className="absolute inset-0 flex items-center justify-center gap-1.5 text-sm font-medium text-muted-foreground"
        style={{ opacity: settled ? 1 : Math.max(0, 1 - progress * 1.6) }}
      >
        {pending ? (
          <>
            <Spinner /> Connecting…
          </>
        ) : completed ? (
          "Access allowed"
        ) : (
          <>
            Slide to allow
            <ChevronsRight className="slide-hint size-4" />
          </>
        )}
      </span>
      <button
        type="button"
        aria-label="Slide to allow access"
        disabled={disabled || pending || completed}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        className={cn(
          "absolute flex items-center justify-center rounded-full shadow-md ring-1 ring-black/10 focus-visible:outline-2 focus-visible:outline-ring",
          settled ? "bg-emerald-500 text-white" : "bg-foreground text-background",
          !dragging && "transition-transform duration-300 ease-out",
          disabled || settled ? "cursor-default" : "cursor-grab active:cursor-grabbing",
        )}
        style={{
          top: TRACK_PADDING,
          left: TRACK_PADDING,
          width: KNOB_SIZE,
          height: KNOB_SIZE,
          transform: `translateX(${settled ? maxX() : x}px)`,
          touchAction: "none",
        }}
      >
        {pending ? (
          <Spinner className="text-white" />
        ) : completed ? (
          <Check className="size-5" />
        ) : (
          <ArrowRight className="size-5" />
        )}
      </button>
    </div>
  );
}
