import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";
import { androidAppHeaders } from "./android-app";
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
    onRequest(context) {
      announceOnAuthTransitionRequest(context);
      // The Android app's requests say so: the server records no ad conversion for them.
      for (const [name, value] of Object.entries(androidAppHeaders()))
        context.headers.set(name, value);
      return context;
    },
    onSuccess: announceOnAuthTransitionSettled,
    onError: announceOnAuthTransitionSettled,
  },
});
