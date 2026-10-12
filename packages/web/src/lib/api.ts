import type { paths } from "@opensender/contract";
import createClient from "openapi-fetch";
import { config } from "@/config";

/**
 * The typed API client (SPEC §13, dogfooding): every call to the public
 * Resend-compatible surface and the x-internal dashboard endpoints goes
 * through this `openapi-fetch` client, typed by the generated contract
 * `paths`. `credentials: "include"` sends the Better-auth session cookie so
 * the dashboard authenticates as the logged-in user's team.
 */
export const api = createClient<paths>({
  baseUrl: config.apiUrl,
  credentials: "include",
});

/** Narrow an openapi-fetch result to its data, throwing the API error body. */
export function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.error !== undefined) {
    const message =
      typeof result.error === "object" && result.error && "message" in result.error
        ? String((result.error as { message: unknown }).message)
        : "Request failed";
    throw new Error(message);
  }
  return result.data as T;
}
