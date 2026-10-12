import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { adminClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { config } from "@/config";

/**
 * Dashboard auth client (SPEC §13.1). The server mounts Better-auth at
 * `/auth` on the API origin (see core `createAuth` basePath), so the client
 * points at the API URL with the matching basePath. Teams are organizations
 * and admin bootstrap uses the admin plugin surface.
 *
 * The oauthProvider client plugin forwards the signed
 * `oauth_query` from the page URL with every auth call, which is how the
 * login → select-team → consent flow stays stitched to the pending
 * /auth/oauth2/authorize request.
 */
export const authClient = createAuthClient({
  baseURL: config.apiUrl,
  basePath: "/auth",
  plugins: [organizationClient(), adminClient(), oauthProviderClient()],
});

export const { signIn, signOut, signUp } = authClient;
