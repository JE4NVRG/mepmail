import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/support/identity with the Elozi contract v2 (account = team, user = person),
 * on a synthetic database: the cookie and the live membership authorize, the expected
 * account/user in the query are only concurrency guards (409), a sign-out is 401, a
 * removed or foreign association is 403, and a missing key is 503.
 */
const fixture = vi.hoisted(() => ({
  db: null as unknown,
  session: null as {
    user: { id: string; name: string; email: string; emailVerified: boolean };
  } | null,
}));
vi.mock("@millionsend/db", async (original) => ({
  ...(await original<typeof import("@millionsend/db")>()),
  getDb: () => fixture.db,
}));
vi.mock("@/server/auth", () => ({
  getAuth: () => ({ api: { getSession: async () => fixture.session } }),
}));
vi.mock("next-intl/server", () => ({ getLocale: async () => "pt-BR" }));

const { GET } = await import("../src/app/api/support/identity/route");

const KEY_ENV = {
  ELOZI_IDENTITY_SECRET: "fixture-secret-for-tests-only-0123456789",
  ELOZI_IDENTITY_KID: "fixture_kid",
};
const decode = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));

let close: () => Promise<void>;
let teamA: string, teamB: string, foreign: string;
const ana = { id: "ana_v2", name: "Ana", email: "ana@acme.test", emailVerified: true };
const bruno = { id: "bruno_v2", name: "Bruno", email: "bruno@acme.test", emailVerified: true };

beforeEach(async () => {
  const test = await createTestDb();
  fixture.db = test.db;
  close = test.close;
  const db = test.db;
  teamA = await createTeam(db, "account-a-v2");
  teamB = await createTeam(db, "account-b-v2");
  foreign = await createTeam(db, "foreign-v2");
  await db.insert(schema.user).values([ana, bruno]);
  await db.insert(schema.teamMembers).values([
    { teamId: teamA, userId: ana.id, role: "owner" },
    { teamId: teamB, userId: ana.id, role: "member" },
    { teamId: teamA, userId: bruno.id, role: "member" },
  ]);
  for (const [name, value] of Object.entries(KEY_ENV)) vi.stubEnv(name, value);
  fixture.session = { user: ana };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

const ask = (team: string | null, expected?: Record<string, string>, extra: HeadersInit = {}) =>
  GET(
    new Request(
      `https://mepmail.dev/api/support/identity${expected ? `?${new URLSearchParams(expected)}` : ""}`,
      {
        headers: {
          "sec-fetch-site": "same-origin",
          ...(team !== null ? { cookie: `ms_active_team=${team}` } : {}),
          ...extra,
        },
      },
    ),
  );

describe("Support identity v2: the account is the active team, the user is the person", () => {
  it("gives the same person separate accounts on teams A and B (separate histories)", async () => {
    const a = await ask(teamA);
    const b = await ask(teamB);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const bodyA = await a.json();
    const bodyB = await b.json();
    expect(bodyA.identity).toEqual({ accountId: teamA, userId: ana.id });
    expect(bodyB.identity).toEqual({ accountId: teamB, userId: ana.id });
    expect(decode(bodyA.token)).toMatchObject({ v: 2, accountId: teamA, sub: ana.id });
    expect(decode(bodyB.token)).toMatchObject({ v: 2, accountId: teamB, sub: ana.id });
    expect(a.headers.get("cache-control")).toContain("no-store");
  });

  it("keeps another person on the same account separate", async () => {
    fixture.session = { user: bruno };
    const body = await (await ask(teamA)).json();
    expect(body.identity).toEqual({ accountId: teamA, userId: bruno.id });
    expect(decode(body.token)).toMatchObject({ accountId: teamA, sub: bruno.id });
  });

  it("answers 409 to a request still expecting the previous account or user (switch in flight)", async () => {
    // The widget asked for team A's token; the person has switched to team B meanwhile.
    expect((await ask(teamB, { accountId: teamA, userId: ana.id })).status).toBe(409);
    expect((await ask(teamA, { accountId: teamA, userId: bruno.id })).status).toBe(409);
    expect((await ask(teamA, { accountId: teamA, userId: ana.id })).status).toBe(200);
  });

  it("answers 401 once signed out, even to a request expecting the old account", async () => {
    fixture.session = null;
    expect((await ask(teamA, { accountId: teamA, userId: ana.id })).status).toBe(401);
  });

  it("answers 403 for a removed association, a foreign team or a broken selection", async () => {
    const db = fixture.db as Awaited<ReturnType<typeof createTestDb>>["db"];
    await db
      .delete(schema.teamMembers)
      .where(and(eq(schema.teamMembers.userId, ana.id), eq(schema.teamMembers.teamId, teamB)));
    expect((await ask(teamB)).status).toBe(403);
    expect((await ask(foreign)).status).toBe(403);
    expect((await ask("%E0%A4%A")).status).toBe(403);
    // No selection: the server's default membership is the active account.
    expect((await (await ask(null)).json()).identity.accountId).toBe(teamA);
  });

  it("answers 403 to an unverified e-mail and to a cross-site caller", async () => {
    fixture.session = { user: { ...ana, emailVerified: false } };
    expect((await ask(teamA)).status).toBe(403);
    fixture.session = { user: ana };
    expect((await ask(teamA, undefined, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  it("answers 503 without the channel key, so a signed-in chat stays closed", async () => {
    vi.stubEnv("ELOZI_IDENTITY_SECRET", "");
    expect((await ask(teamA)).status).toBe(503);
  });
});
