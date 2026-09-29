import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ATTRIBUTION_TTL_SECONDS,
  attributionFromCookieValue,
  attributionFromVisit,
  buildFunnelEventPayload,
  emitFunnelEvent,
  type FunnelEventTarget,
  funnelEventData,
  sendFunnelEvent,
  teamFunnelProps,
  UMAMI_COLLECTOR_USER_AGENT,
  userFunnelProps,
} from "../src/funnel-events.js";

const ENDPOINT = "https://umami.example.com/api/send";
const WEBSITE = "11111111-2222-3333-4444-555555555555";

/** A fetch stub: records every call, answers `status` (200 by default). */
function stubFetch(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(status === 200 ? '{"beep":"boop"}' : "nope", { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function target(overrides: Partial<FunnelEventTarget> = {}): FunnelEventTarget {
  return { endpoint: ENDPOINT, websiteId: WEBSITE, hostname: "mepmail.example.com", ...overrides };
}

const body = (init: RequestInit) =>
  JSON.parse(String(init.body)) as ReturnType<typeof buildFunnelEventPayload>;

describe("attributionFromVisit", () => {
  it("keeps the campaign fields and the landing path, dropping the query", () => {
    expect(
      attributionFromVisit({
        source: "linkedin",
        medium: "cpc",
        campaign: "beta-lancamento",
        content: "ad-1",
        term: "email marketing",
        referrer: "https://www.linkedin.com/feed/?trk=public_post",
        path: "/pricing?utm_source=linkedin",
      }),
    ).toEqual({
      source: "linkedin",
      medium: "cpc",
      campaign: "beta-lancamento",
      content: "ad-1",
      term: "email marketing",
      // The referrer's own query string can carry the visitor's identifiers.
      referrer: "www.linkedin.com",
      landingPath: "/pricing",
    });
  });

  it("falls back to the referrer's host, then to direct", () => {
    expect(
      attributionFromVisit({ referrer: "https://news.ycombinator.com/item?id=1" }).source,
    ).toBe("news.ycombinator.com");
    expect(attributionFromVisit({}).source).toBe("direct");
    // A value that is not parseable as a URL is kept as typed rather than lost.
    expect(attributionFromVisit({ referrer: "morning-brew" }).source).toBe("morning-brew");
  });

  it("strips control characters, bounds each field and reads empty as absent", () => {
    const attribution = attributionFromVisit({
      source: "  linked\nin\u0000  ",
      campaign: "x".repeat(500),
    });
    expect(attribution.source).toBe("linkedin");
    expect(attribution.campaign).toHaveLength(200);
    expect(attributionFromVisit({ source: "   " }).source).toBe("direct");
  });
});

describe("attributionFromCookieValue", () => {
  it("parses the JSON the proxy wrote", () => {
    expect(attributionFromCookieValue('{"source":"producthunt","path":"/"}')).toMatchObject({
      source: "producthunt",
      landingPath: "/",
    });
  });

  it("treats a broken cookie as no channel at all", () => {
    expect(attributionFromCookieValue(undefined)).toBeNull();
    expect(attributionFromCookieValue("")).toBeNull();
    expect(attributionFromCookieValue("not json")).toBeNull();
    expect(attributionFromCookieValue('["producthunt"]')).toBeNull();
    expect(attributionFromCookieValue("null")).toBeNull();
  });
});

describe("buildFunnelEventPayload", () => {
  it("defaults the url to the funnel path of the event", () => {
    expect(buildFunnelEventPayload({ name: "signup", websiteId: WEBSITE, hostname: "h" })).toEqual({
      type: "event",
      payload: { website: WEBSITE, hostname: "h", url: "/signup", name: "signup" },
    });
  });

  it("drops props it has no value for, so 'no campaign' is not read as empty", () => {
    expect(funnelEventData({ source: "linkedin", medium: null, campaign: undefined })).toEqual({
      source: "linkedin",
    });
    expect(funnelEventData({ source: null, medium: "  " })).toBeUndefined();
    const built = buildFunnelEventPayload({
      name: "payment_succeeded",
      websiteId: WEBSITE,
      hostname: "h",
      props: { plan: "pro", source: null },
    });
    expect(built.payload.data).toEqual({ plan: "pro" });
  });
});

describe("sendFunnelEvent", () => {
  it("posts the event to the collector with the browser shape Umami stores", async () => {
    const { calls, fetchImpl } = stubFetch();
    const sent = await sendFunnelEvent(
      buildFunnelEventPayload({
        name: "signup",
        websiteId: WEBSITE,
        hostname: "mepmail.example.com",
        props: { source: "linkedin", locale: "pt-BR" },
      }),
      target({ fetch: fetchImpl }),
    );
    expect(sent).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(ENDPOINT);
    expect(calls[0]?.init.method).toBe("POST");
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("x-umami-website-id")).toBe(WEBSITE);
    // A bot-shaped UA is dropped by Umami's filter, so the emitter presents a browser.
    expect(headers.get("user-agent")).toBe(UMAMI_COLLECTOR_USER_AGENT);
    expect(body(calls[0]?.init ?? {})).toMatchObject({
      type: "event",
      payload: { website: WEBSITE, name: "signup", data: { source: "linkedin", locale: "pt-BR" } },
    });
  });

  it("never throws: a refusal, a timeout or an unconfigured instance is just false", async () => {
    const logs: string[] = [];
    const { fetchImpl } = stubFetch(500);
    expect(
      await sendFunnelEvent(
        buildFunnelEventPayload({ name: "signup", websiteId: WEBSITE, hostname: "h" }),
        target({ fetch: fetchImpl, log: (m) => logs.push(m) }),
      ),
    ).toBe(false);
    expect(logs.join(" ")).toContain("collector answered 500");

    const unreachable = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(
      await sendFunnelEvent(
        buildFunnelEventPayload({ name: "signup", websiteId: WEBSITE, hostname: "h" }),
        target({ fetch: unreachable, log: (m) => logs.push(m) }),
      ),
    ).toBe(false);
    expect(logs.join(" ")).toContain("collector unreachable");

    // An unconfigured instance (self-host default) is the cheapest case: no request at all.
    const { calls } = stubFetch();
    expect(
      await sendFunnelEvent(
        buildFunnelEventPayload({ name: "signup", websiteId: WEBSITE, hostname: "h" }),
        target({ endpoint: null, websiteId: null, fetch: fetchImpl }),
      ),
    ).toBe(false);
    // Nothing was attempted: the emitter short-circuits before fetch.
    expect(calls).toHaveLength(0);
  });

  it("gives up on a collector that never answers", async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const logs: string[] = [];
    expect(
      await sendFunnelEvent(
        buildFunnelEventPayload({ name: "signup", websiteId: WEBSITE, hostname: "h" }),
        target({ fetch: hanging, timeoutMs: 10, log: (m) => logs.push(m) }),
      ),
    ).toBe(false);
    expect(logs.join(" ")).toContain("collector unreachable");
  });
});

describe("emitFunnelEvent", () => {
  let db: Db;
  let close: () => Promise<void>;
  let userId: string;
  let teamId: string;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    teamId = await createTeam(db, "funnel-team");
    userId = `user_${Math.random().toString(36).slice(2)}`;
    await db
      .insert(schema.user)
      .values({ id: userId, name: "Ada", email: `${userId}@example.com` });
    await db.insert(schema.teamMembers).values({ teamId, userId, role: "owner" });
    await db.insert(schema.signupAttribution).values({
      userId,
      source: "linkedin",
      medium: "cpc",
      campaign: "beta",
      landingPath: "/",
    });
  });

  afterEach(() => close());

  it("claims the event once, stores the props it sent, and skips the second caller", async () => {
    const { calls, fetchImpl } = stubFetch();
    const first = await emitFunnelEvent(db, target({ fetch: fetchImpl }), {
      name: "signup",
      dedupeKey: `signup:${userId}`,
      props: { locale: "pt-BR" },
      resolve: (tx) => userFunnelProps(tx, userId),
    });
    expect(first).toBe(true);

    const second = await emitFunnelEvent(db, target({ fetch: fetchImpl }), {
      name: "signup",
      dedupeKey: `signup:${userId}`,
      props: { locale: "pt-BR" },
      resolve: (tx) => userFunnelProps(tx, userId),
    });
    // The insert is the lock: the duplicate never reaches the collector.
    expect(second).toBe(false);
    expect(calls).toHaveLength(1);

    const rows = await db.select().from(schema.funnelEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "signup",
      dedupeKey: `signup:${userId}`,
      props: { source: "linkedin", medium: "cpc", campaign: "beta", locale: "pt-BR" },
    });
  });

  it("reads the channel and plan of a team-scoped event from the owner's row", async () => {
    await db.update(schema.teams).set({ plan: "pro" }).where(eq(schema.teams.id, teamId));
    const { calls, fetchImpl } = stubFetch();
    await emitFunnelEvent(db, target({ fetch: fetchImpl }), {
      name: "first_email_sent",
      dedupeKey: `first_email_sent:${teamId}`,
      teamId,
      resolve: (tx) => teamFunnelProps(tx, teamId),
    });
    expect(body(calls[0]?.init ?? {}).payload.data).toEqual({
      plan: "pro",
      source: "linkedin",
      medium: "cpc",
      campaign: "beta",
    });
  });

  it("does nothing (and keeps no ledger row) when the instance has no collector", async () => {
    const { calls, fetchImpl } = stubFetch();
    expect(
      await emitFunnelEvent(db, target({ endpoint: null, websiteId: null, fetch: fetchImpl }), {
        name: "signup",
        dedupeKey: `signup:${userId}`,
      }),
    ).toBe(false);
    expect(calls).toHaveLength(0);
    expect(await db.select().from(schema.funnelEvents)).toEqual([]);
  });

  it("keeps the claim and swallows a collector failure", async () => {
    const logs: string[] = [];
    const failing = (async () => {
      throw new Error("collector down");
    }) as unknown as typeof fetch;
    // The claim is durable: a lost emission is a lost data point, never a
    // failed signup, and the row is there to replay by hand.
    await expect(
      emitFunnelEvent(db, target({ fetch: failing, log: (m) => logs.push(m) }), {
        name: "signup",
        dedupeKey: `signup:${userId}`,
      }),
    ).resolves.toBe(true);
    const rows = await db.select().from(schema.funnelEvents);
    expect(rows).toHaveLength(1);
  });

  it("does not read anything when the claim is lost", async () => {
    const { fetchImpl } = stubFetch();
    await emitFunnelEvent(db, target({ fetch: fetchImpl }), {
      name: "email_verified",
      dedupeKey: `email_verified:${userId}`,
    });
    let reads = 0;
    await emitFunnelEvent(db, target({ fetch: fetchImpl }), {
      name: "email_verified",
      dedupeKey: `email_verified:${userId}`,
      resolve: async () => {
        reads += 1;
        return {};
      },
    });
    expect(reads).toBe(0);
  });
});

it("keeps the cookie lifetime in step with the attribution window the report reads", () => {
  expect(ATTRIBUTION_TTL_SECONDS).toBe(90 * 24 * 60 * 60);
});
