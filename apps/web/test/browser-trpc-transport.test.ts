import { createTRPCClient } from "@trpc/client";
import { initTRPC } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ANDROID_APP_ATTRIBUTE, ANDROID_APP_HEADER } from "@/lib/android-app";
import { createBrowserTrpcTransport } from "@/lib/browser-trpc-transport";
import type { AppRouter } from "@/server/routers";

const APP = "https://app.example.test";
const OBSERVED_AT = new Date("2026-10-15T12:00:00Z");
const t = initTRPC.context<{ headers: Headers; resHeaders: Headers }>().create({
  transformer: superjson,
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const slowStarted = deferred();
  const slowGate = deferred();
  const requests: { streaming: boolean; android: string | null; setCookie: string | null }[] = [];
  let cookie = "ms_active_team=team_a";
  const router = t.router({
    team: t.router({
      switch: t.procedure
        .input(z.object({ teamId: z.string() }))
        .mutation(async ({ ctx, input }) => {
          // A real asynchronous boundary, like the membership lookup before cookies().set.
          await new Promise((done) => setTimeout(done, 0));
          ctx.resHeaders.append("set-cookie", `ms_active_team=${input.teamId}; Path=/; HttpOnly`);
          return { teamId: input.teamId };
        }),
      list: t.procedure.query(({ ctx }) => ({
        activeTeamId: ctx.headers.get("cookie")?.match(/ms_active_team=([^;]+)/)?.[1],
        teams: [],
        observedAt: OBSERVED_AT,
      })),
      standing: t.procedure.query(async () => {
        slowStarted.resolve();
        await slowGate.promise;
        return { observedAt: OBSERVED_AT };
      }),
    }),
  });
  const fetchImpl: NonNullable<Parameters<typeof createBrowserTrpcTransport>[0]> = async (
    input,
    init,
  ) => {
    const request = new Request(
      new URL(String(input), APP),
      init ? { ...init, signal: init.signal ?? null } : undefined,
    );
    request.headers.set("cookie", cookie);
    const response = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: request,
      router,
      createContext: ({ resHeaders }) => ({ headers: request.headers, resHeaders }),
    });
    // Browser cookie storage happens when headers arrive, before a streamed body resolves.
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0] ?? cookie;
    requests.push({
      streaming: request.headers.get("trpc-accept") === "application/jsonl",
      android: request.headers.get(ANDROID_APP_HEADER),
      setCookie,
    });
    return response;
  };
  const client = createTRPCClient<AppRouter>({ links: [createBrowserTrpcTransport(fetchImpl)] });
  return { client, requests, slowStarted, slowGate };
}

afterEach(() => vi.unstubAllGlobals());

describe("browser tRPC transport", () => {
  it("persists a cookie set after async mutation work and sends Android headers on both transports", async () => {
    vi.stubGlobal("document", {
      documentElement: { hasAttribute: (name: string) => name === ANDROID_APP_ATTRIBUTE },
    });
    const { client, requests } = fixture();

    expect(await client.team.switch.mutate({ teamId: "team_b" })).toEqual({ teamId: "team_b" });
    expect(requests[0]).toMatchObject({
      streaming: false,
      android: "android-app",
      setCookie: "ms_active_team=team_b; Path=/; HttpOnly",
    });
    // The next real client query sees the selection; superjson preserves its Date too.
    expect(await client.team.list.query()).toMatchObject({
      activeTeamId: "team_b",
      observedAt: OBSERVED_AT,
    });
    expect(requests[1]).toMatchObject({ streaming: true, android: "android-app" });
  });

  it("delivers a fast query before a slow query in the same streaming batch", async () => {
    const { client, requests, slowStarted, slowGate } = fixture();
    const fast = client.team.list.query();
    const slow = client.team.standing.query();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await slowStarted.promise;
      const result = await Promise.race([
        fast,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Fast query waited for the slow query")),
            2000,
          );
        }),
      ]);
      expect(result).toMatchObject({ activeTeamId: "team_a", observedAt: OBSERVED_AT });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ streaming: true, android: null });
    } finally {
      clearTimeout(timeout);
      slowGate.resolve();
      await slow;
    }
  });
});
