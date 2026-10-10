"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchStreamLink } from "@trpc/client";
import { useState } from "react";
import superjson from "superjson";
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
      // Still batched, but each answer streams back as soon as it is ready, so a
      // slow query (the Correio list) never holds the folders and counters behind it.
      links: [httpBatchStreamLink({ url: "/api/trpc", transformer: superjson })],
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
