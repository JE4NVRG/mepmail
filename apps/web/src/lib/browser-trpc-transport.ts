import { httpBatchLink, httpBatchStreamLink, splitLink, type TRPCLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "@/server/routers";
import { androidAppHeaders } from "./android-app";

type BrowserFetch = NonNullable<Parameters<typeof httpBatchLink<AppRouter>>[0]["fetch"]>;

/** Mutations must finish before response headers (including cookies) are sent. */
export function createBrowserTrpcTransport(fetchImpl?: BrowserFetch): TRPCLink<AppRouter> {
  const options = {
    url: "/api/trpc",
    transformer: superjson,
    headers: androidAppHeaders,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  };
  return splitLink<AppRouter>({
    condition: (op) => op.type === "mutation",
    true: httpBatchLink(options),
    // Keep fast queries independent of slower results in the same batch.
    false: httpBatchStreamLink(options),
  });
}
