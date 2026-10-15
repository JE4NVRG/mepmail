"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient } from "@trpc/client";
import { useState } from "react";
import { createBrowserTrpcTransport } from "@/lib/browser-trpc-transport";
import { supportSessionLink } from "@/lib/support-session-signal";
import { TRPCProvider } from "@/lib/trpc";
import { trpcErrorCode } from "@/lib/trpc-error";
import type { AppRouter } from "@/server/routers";

// Answers that will not change on a retry: a record that is gone, or one the
// caller may not see. Everything else keeps react-query's default three tries.
const FINAL_CODES = new Set(["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED", "BAD_REQUEST"]);

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) =>
          !FINAL_CODES.has(trpcErrorCode(error) ?? "") && failureCount < 3,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

// Server renders must not share a QueryClient across requests; the browser
// must reuse one across suspense re-renders.
function getQueryClient() {
  if (typeof window === "undefined") return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const queryClient = getQueryClient();
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      // Mutations finish before headers are sent, so an async team switch can set its
      // cookie. Queries still stream, keeping slow lists from holding fast counters.
      // A team switch, a new team or an accepted invitation tells the support chat's
      // windows that the account changed (lib/support-session-signal.ts).
      links: [supportSessionLink, createBrowserTrpcTransport()],
    }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
