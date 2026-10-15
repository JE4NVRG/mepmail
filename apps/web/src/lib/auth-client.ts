import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";
import {
  announceOnAuthTransitionRequest,
  announceOnAuthTransitionSettled,
} from "./support-session-signal";

// oauthProviderClient forwards the signed OAuth query of the current page
// (login/consent) with each auth call, which is how a sign-in resumes a
// pending MCP authorization.
export const authClient = createAuthClient({
  plugins: [oauthProviderClient()],
  fetchOptions: {
    // Compose support invalidation with the existing OAuth plugin, before and after
    // login/logout. Signals revoke old capabilities; they never authenticate a new one.
    onRequest: announceOnAuthTransitionRequest,
    onSuccess: announceOnAuthTransitionSettled,
    onError: announceOnAuthTransitionSettled,
  },
});
