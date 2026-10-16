import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { proxy } from "@/proxy";
import { recordSignupAttribution } from "@/server/funnel";
import { signupAlertMessage } from "@/server/signup-alert";

vi.mock("@millionsend/config", async (original) => {
  const actual = await original<typeof import("@millionsend/config")>();
  return { ...actual, env: { ...actual.env, UNSUBSCRIBE_BASE_URL: undefined } };
});

let db: Db;
let close: () => Promise<void>;
const network = vi.fn(() => {
  throw new Error("This test must never send a request");
});

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
beforeEach(() => {
  network.mockClear();
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
afterAll(() => close());

function navigate(url: string, cookie?: string, referer?: string) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (referer) headers.set("referer", referer);
  const response = proxy(new NextRequest(url, { headers }));
  return response.cookies.get("mm_attr")
    ? response.headers.get("set-cookie")?.split(";")[0]
    : cookie;
}

async function signup(cookie: string | undefined) {
  const userId = randomUUID();
  await db
    .insert(schema.user)
    .values({ id: userId, name: "Fixture", email: `${userId}@example.test` });
  const attribution = await recordSignupAttribution(db, userId, cookie ?? null);
  const rows = await db
    .select()
    .from(schema.signupAttribution)
    .where(eq(schema.signupAttribution.userId, userId));
  const message = signupAlertMessage({
    email: "fixture@example.test",
    name: "Fixture",
    attribution,
    locale: "pt-BR",
    now: new Date("2026-10-16T12:00:00Z"),
  });
  return { attribution, rows, message };
}

it("keeps all five campaign fields and the pre-login landing through persistence and the signup notice", async () => {
  const query = new URLSearchParams({
    utm_source: "community",
    utm_medium: "post",
    utm_campaign: "campaign-50%",
    utm_content: "creative-50%",
    utm_term: "term-50%",
  });
  let cookie = navigate(
    `https://preview.example/migrate?${query}`,
    undefined,
    "https://news.example/item?id=private",
  );
  for (const path of ["/pricing", "/login", "/signup"]) {
    cookie = navigate(`https://preview.example${path}`, cookie, "https://preview.example/migrate");
  }
  const result = await signup(cookie);
  const expected = {
    source: "community",
    medium: "post",
    campaign: "campaign-50%",
    content: "creative-50%",
    term: "term-50%",
    referrer: "news.example",
    landingPath: "/migrate",
  };
  expect(result.attribution).toEqual(expected);
  expect(result.rows).toMatchObject([expected]);
  for (const value of Object.values(expected)) expect(result.message).toContain(value);
  expect(result.message).not.toContain("landing: /login");
  expect(result.message).not.toContain("private");
});

it("keeps an external first referral when a later login arrives with a different external referrer", async () => {
  let cookie = navigate(
    "https://preview.example/migrate?utm_medium=referral",
    undefined,
    "https://news.example/article",
  );
  cookie = navigate("https://preview.example/pricing", cookie, "https://preview.example/migrate");
  cookie = navigate("https://preview.example/login", cookie, "https://identity.example/callback");
  const result = await signup(cookie);
  expect(result.attribution).toMatchObject({
    source: "news.example",
    medium: "referral",
    referrer: "news.example",
    landingPath: "/migrate",
  });
  expect(result.message).toContain("news.example");
  expect(result.message).toContain("landing: /migrate");
  expect(result.message).not.toContain("identity.example");
});

it("keeps the existing explicit-new-campaign replacement rule", async () => {
  let cookie = navigate(
    "https://preview.example/migrate",
    undefined,
    "https://news.example/article",
  );
  cookie = navigate(
    "https://preview.example/pricing?utm_source=new-campaign&utm_term=new-term",
    cookie,
  );
  const result = await signup(cookie);
  expect(result.attribution).toMatchObject({
    source: "new-campaign",
    term: "new-term",
    landingPath: "/pricing",
  });
});

it("already reads the legacy encoded campaign and does not invent attribution when the cookie is absent", async () => {
  const raw = JSON.stringify({ source: "known-channel", term: "50% %22", path: "/migrate" });
  const result = await signup(`mm_attr=${encodeURIComponent(encodeURIComponent(raw))}`);
  expect(result.attribution).toMatchObject({
    source: "known-channel",
    term: "50% %22",
    landingPath: "/migrate",
  });
  const missing = await signup(undefined);
  expect(missing.attribution).toBeNull();
  expect(missing.rows).toEqual([]);
  expect(missing.message).toContain("sem cookie de atribuicao");
});
