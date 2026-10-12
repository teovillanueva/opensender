import * as Sentry from "@sentry/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { config } from "./config";
import "./index.css";
import { routeTree } from "./routeTree.gen";

// Frontend error reporting (SPEC §15). No DSN (bare local build) ⇒ no-op.
if (config.sentryDsn) {
  Sentry.init({ dsn: config.sentryDsn, environment: "production", tracesSampleRate: 0 });
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

/** Path depth drives the transition direction: deeper = drill-in, shallower =
 * back out, same depth = lateral move between sections. */
function pathDepth(pathname: string): number {
  return pathname.split("/").filter(Boolean).length;
}

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  scrollRestoration: true,
  defaultViewTransition: {
    // Native view transitions (styled in index.css on `main-content`).
    // Unsupported browsers skip them gracefully.
    types: ({ fromLocation, toLocation, pathChanged }) => {
      if (!pathChanged || !fromLocation) return false;
      // Settings tab moves animate only the tab panel (see index.css).
      const inSettings = (p: string) => p === "/settings" || p.startsWith("/settings/");
      if (inSettings(fromLocation.pathname) && inSettings(toLocation.pathname)) {
        return ["nav-settings"];
      }
      // Settings sub-pages count as top-level so leaving them is lateral, not "back".
      const depth = (p: string) => (inSettings(p) ? 1 : pathDepth(p));
      const from = depth(fromLocation.pathname);
      const to = depth(toLocation.pathname);
      if (to > from) return ["nav-forward"];
      if (to < from) return ["nav-back"];
      return ["nav-lateral"];
    },
  },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element #root not found");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
