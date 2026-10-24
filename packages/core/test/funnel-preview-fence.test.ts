import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { expect, it, vi } from "vitest";
import { emitFunnelEvent, type FunnelEventTarget } from "../src/funnel-events.js";

const WEBSITE = "11111111-2222-3333-4444-555555555555";
function recorder() {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const target: FunnelEventTarget = {
    endpoint: "https://umami.example.com/api/send",
    websiteId: WEBSITE,
    hostname: "mepmail.example.com",
    fetch: fetchImpl,
  };
  return { calls, target };
}

it("keeps both direct canonical emitters completely silent in preview, even with a collector", async () => {
  const { db, close } = await createTestDb();
  const teamId = await createTeam(db);
  const { calls, target: baseTarget } = recorder();
  vi.stubEnv("MEPMAIL_LOCAL_PREVIEW", "1");
  try {
    for (const name of ["first_send", "subscription_paid"] as const) {
      expect(
        await emitFunnelEvent(db, baseTarget, {
          name,
          dedupeKey: `preview-direct:${name}:${teamId}`,
          teamId,
          props: { product: "send", amount_paid_minor: "900" },
        }),
      ).toBe(false);
    }
    expect(calls).toEqual([]);
    expect(await db.select().from(schema.funnelEvents)).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    await close();
  }
});
it("keeps both direct canonical emitters out of loopback APP origins and collector hostnames", async () => {
  const { db, close } = await createTestDb();
  const teamId = await createTeam(db);
  const { calls, target: baseTarget } = recorder();
  try {
    for (const app of ["http://localhost:3186", "http://127.0.0.1:3000", "http://[::1]:3186"]) {
      vi.stubEnv("APP_BASE_URL", app);
      for (const name of ["first_send", "subscription_paid"] as const) {
        expect(
          await emitFunnelEvent(db, baseTarget, {
            name,
            dedupeKey: `loopback-app:${name}:${teamId}`,
            teamId,
          }),
        ).toBe(false);
      }
    }
    vi.stubEnv("APP_BASE_URL", "https://mepmail.dev");
    for (const hostname of ["localhost:3186", "127.0.0.1:3000", "[::1]:3186"]) {
      for (const name of ["first_send", "subscription_paid"] as const) {
        expect(
          await emitFunnelEvent(
            db,
            { ...baseTarget, hostname },
            {
              name,
              dedupeKey: `loopback-target:${name}:${teamId}`,
              teamId,
            },
          ),
        ).toBe(false);
      }
    }
    expect(calls).toEqual([]);
    expect(await db.select().from(schema.funnelEvents)).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    await close();
  }
});
