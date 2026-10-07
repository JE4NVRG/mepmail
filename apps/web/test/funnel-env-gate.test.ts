import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emitFunnel, funnelTarget } from "@/server/funnel";

/**
 * The server-side funnel end to end against the environment (card t_47d43fde).
 *
 * What went wrong: `isCloudDeployment()` alone used to buy the hosted
 * collector, so any process carrying `IS_CLOUD=true` — a dev box, and the web
 * test suite, which stubs that toggle in a dozen files — POSTed real
 * `signup`/`checkout_started` events to umami.je4ndev.com. Production's Umami
 * showed 6 signups from `localhost:3000` and 9 checkouts from
 * `app.example.com` while the product held 1 account and 0 payments.
 *
 * The two tests below pin the contract: an environment that configured no
 * collector sends NOTHING (proved by the recorded fetch log, not by a return
 * value alone), and one that set UMAMI_ENDPOINT/UMAMI_WEBSITE_ID sends to
 * exactly that pair.
 */
const ENDPOINT = "https://umami.example.com/api/send";
const WEBSITE = "11111111-2222-3333-4444-555555555555";
const HOSTED_ENDPOINT = "https://umami.je4ndev.com/api/send";

let db: Db;
let close: () => Promise<void>;
let calls: { url: string; headers: Record<string, string>; body: unknown }[];

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  calls = [];
  // Every outbound request the code under test makes is recorded here: only an
  // empty log proves that nothing was sent.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response('{"beep":"boop"}', { status: 200 });
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await close();
});

it("sends nothing when the environment configured no collector, IS_CLOUD or not", async () => {
  // The exact shape of the leaking environments: the cloud toggle set (a dev
  // box, a test run) and no Umami configuration at all.
  vi.stubEnv("IS_CLOUD", "true");
  vi.stubEnv("APP_BASE_URL", "http://localhost:3000");

  expect(funnelTarget()).toEqual({ endpoint: null, websiteId: null, hostname: "localhost:3000" });

  const teamId = await createTeam(db);
  expect(
    await emitFunnel(db, {
      name: "checkout_started",
      dedupeKey: `checkout_started:${teamId}:2026-09-28`,
      teamId,
    }),
  ).toBe(false);
  expect(await emitFunnel(db, { name: "signup_complete", dedupeKey: "signup:dev-user" })).toBe(
    false,
  );

  expect(calls).toEqual([]);
  expect(calls.map((call) => call.url)).not.toContain(HOSTED_ENDPOINT);
  // An unconfigured instance keeps no ledger row either: nothing claimed,
  // nothing half-written for a report that will never look for it.
  expect(await db.select({ id: schema.funnelEvents.id }).from(schema.funnelEvents)).toEqual([]);
});

it("sends to exactly the collector this environment set", async () => {
  vi.stubEnv("IS_CLOUD", "true");
  vi.stubEnv("UMAMI_ENDPOINT", ENDPOINT);
  vi.stubEnv("UMAMI_WEBSITE_ID", WEBSITE);
  vi.stubEnv("APP_BASE_URL", "https://mepmail.dev");

  expect(funnelTarget()).toEqual({
    endpoint: ENDPOINT,
    websiteId: WEBSITE,
    hostname: "mepmail.dev",
  });

  const teamId = await createTeam(db);
  expect(
    await emitFunnel(db, {
      name: "checkout_started",
      dedupeKey: `checkout_started:${teamId}:2026-09-28`,
      teamId,
    }),
  ).toBe(true);

  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe(ENDPOINT);
  expect(calls[0]?.headers["x-umami-website-id"]).toBe(WEBSITE);
  expect(calls[0]?.body).toMatchObject({
    type: "event",
    payload: {
      website: WEBSITE,
      hostname: "mepmail.dev",
      url: "/settings/billing",
      name: "checkout_started",
    },
  });
});

it("sends nothing when only half the pair is set", async () => {
  vi.stubEnv("UMAMI_ENDPOINT", ENDPOINT);

  expect(funnelTarget()).toEqual({ endpoint: null, websiteId: null, hostname: "localhost" });
  expect(await emitFunnel(db, { name: "signup_complete", dedupeKey: "signup:half" })).toBe(false);
  expect(calls).toEqual([]);
});
