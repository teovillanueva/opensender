/**
 * Build-time instance configuration. The StaticSite injects these via Vite
 * env (SST `environment`); the fallbacks match `instance.config.ts` so a bare
 * `vite build` / `vite dev` still points at the production API (SPEC §13/§20).
 */
export const config = {
  instanceName: import.meta.env.VITE_INSTANCE_NAME ?? "opensender",
  apiUrl: import.meta.env.VITE_API_URL ?? "https://api.mailing.example.com",
  signupOpen: (import.meta.env.VITE_SIGNUP_OPEN ?? "false") === "true",
  // Frontend Sentry DSN (SPEC §15); empty in a bare local build ⇒ Sentry off.
  sentryDsn: import.meta.env.VITE_SENTRY_DSN ?? "",
} as const;
