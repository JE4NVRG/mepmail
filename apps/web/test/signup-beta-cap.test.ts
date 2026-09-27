import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Auth, createAuth } from "@/server/auth";
import { createCaller } from "@/server/routers";

const BASE = "http://localhost:3000";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-1234");
  vi.stubEnv("APP_BASE_URL", BASE);
  vi.stubEnv("ALLOW_SIGNUP", "true");
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

async function signUp(auth: Auth, email: string): Promise<string> {
  const { response } = await auth.api.signUpEmail({
    body: { name: email, email, password: "correct horse battery" },
    headers: new Headers(),
    returnHeaders: true,
  });
  return response.user.id;
}

describe("beta seat cap (BETA_MAX_USERS)", () => {
  it("blocks sign-up once the cap is reached", async () => {
    vi.stubEnv("BETA_MAX_USERS", "2");
    await db.insert(schema.user).values([
      { id: "u1", name: "u1", email: "u1@example.com" },
      { id: "u2", name: "u2", email: "u2@example.com" },
    ]);
    const auth = createAuth(db);
    await expect(signUp(auth, "u3@example.com")).rejects.toThrow(/full/i);
    const rows = await db.select({ id: schema.user.id }).from(schema.user);
    expect(rows).toHaveLength(2);
  });

  it("admits sign-up below the cap", async () => {
    vi.stubEnv("BETA_MAX_USERS", "3");
    const auth = createAuth(db);
    const userId = await signUp(auth, "ada@example.com");
    const [row] = await db.select().from(schema.user).where(eq(schema.user.id, userId));
    expect(row?.email).toBe("ada@example.com");
  });

  it("applies no cap when BETA_MAX_USERS is unset", async () => {
    await db.insert(schema.user).values([
      { id: "u1", name: "u1", email: "u1@example.com" },
      { id: "u2", name: "u2", email: "u2@example.com" },
      { id: "u3", name: "u3", email: "u3@example.com" },
    ]);
    const auth = createAuth(db);
    const userId = await signUp(auth, "u4@example.com");
    expect(userId).toBeTruthy();
  });
});

describe("beta default daily ceiling (BETA_DEFAULT_DAILY_CEILING)", () => {
  function callerFor(userId: string) {
    return createCaller({
      db,
      session: { user: { id: userId, email: `${userId}@example.com`, name: userId } },
      teamId: null,
      role: null,
    });
  }

  it("stamps new teams with the operator ceiling", async () => {
    vi.stubEnv("BETA_DEFAULT_DAILY_CEILING", "100");
    await db.insert(schema.user).values({ id: "u1", name: "u1", email: "u1@example.com" });
    const { teamId } = await callerFor("u1").team.createTeam({ name: "Ada Labs" });
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(team?.dailySendCeiling).toBe(100);
  });

  it("leaves new teams uncapped without the beta ceiling", async () => {
    await db.insert(schema.user).values({ id: "u1", name: "u1", email: "u1@example.com" });
    const { teamId } = await callerFor("u1").team.createTeam({ name: "Acme" });
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(team?.dailySendCeiling).toBeNull();
  });
});
