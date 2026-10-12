import { createFileRoute, redirect } from "@tanstack/react-router";

/** Usage moved into Settings; keep the old URL working. */
export const Route = createFileRoute("/_app/usage")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/usage", replace: true });
  },
});
