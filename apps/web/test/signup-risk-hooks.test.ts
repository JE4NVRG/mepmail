import { createHmac } from "node:crypto";
import type { SystemMailMessage } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "@/server/auth";
import { createCaller } from "@/server/routers";

let db: Db;
let close: () => Promise<void>;
const secret = "test-only-aaaaaaaaaaaaaaaaaaaaaaaa";
const email = "jean@example.com";

beforeEach(async () => {
  vi.stubEnv("IS_CLOUD", "true");
  vi.stubEnv("BETTER_AUTH_SECRET", secret);
  vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
  vi.stubEnv("ALLOW_SIGNUP", "true");
  vi.stubEnv("AUTH_EMAIL_FROM", "");
  vi.stubEnv("NOTIFICATIONS_EMAIL_FROM", "");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
  vi.stubEnv("AWS_DEFAULT_CHAIN", "");
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
  ({ db, close } = await createTestDb());
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

const caller = (userId: string, teamId: string | null = null) =>
  createCaller({
    db,
    session: { user: { id: userId, name: "Synthetic", email } },
    teamId,
    role: teamId ? "owner" : null,
  });
const signUp = (auth: ReturnType<typeof createAuth>, headers: Record<string, string> = {}) =>
  auth.api.signUpEmail({
    body: { name: "Synthetic", email, password: "synthetic correct horse battery" },
    headers: new Headers(headers),
  });

describe("signup risk web hooks", () => {
  it("captures an unverified signup before team creation and hashes only the trusted Cloudflare IP", async () => {
    const response = await signUp(createAuth(db, { send: async () => {} }), {
      "cf-connecting-ip": "8.8.8.8",
      "x-forwarded-for": "1.1.1.1",
    });
    const [risk] = await db
      .select()
      .from(schema.userSignupRisk)
      .where(eq(schema.userSignupRisk.userId, response.user.id));
    expect(risk).toMatchObject({
      source: "signup",
      verifiedAt: null,
      domain: "example.com",
      ipKey: createHmac("sha256", secret)
        .update("mepmail-signup-risk:v1")
        .update("\0")
        .update("8.8.8.8")
        .digest("hex"),
    });
    expect(await db.select().from(schema.teams)).toHaveLength(0);
    expect(JSON.stringify(risk)).not.toContain("8.8.8.8");
    expect(JSON.stringify(risk)).not.toContain("1.1.1.1");
  });

  it("does not accept a spoofed forwarded IP or persist risk in self-host mode", async () => {
    const response = await signUp(createAuth(db, { send: async () => {} }), {
      "x-forwarded-for": "1.1.1.1",
    });
    expect(
      (
        await db
          .select()
          .from(schema.userSignupRisk)
          .where(eq(schema.userSignupRisk.userId, response.user.id))
      )[0]?.ipKey,
    ).toBeNull();
    vi.stubEnv("IS_CLOUD", "");
    const selfHosted = createAuth(db, { send: async () => {} });
    const other = await selfHosted.api.signUpEmail({
      body: {
        name: "Self-host",
        email: "other@example.com",
        password: "synthetic correct horse battery",
      },
    });
    expect(
      await db
        .select()
        .from(schema.userSignupRisk)
        .where(eq(schema.userSignupRisk.userId, other.user.id)),
    ).toHaveLength(0);
  });

  it("records the real verification callback while keeping the existing verification requirement", async () => {
    vi.stubEnv("AUTH_EMAIL_FROM", "MepMail <no-reply@mail.example.com>");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "synthetic-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "synthetic-secret");
    const sent: SystemMailMessage[] = [];
    const auth = createAuth(db, {
      send: async (message) => {
        sent.push(message);
      },
    });
    const response = await signUp(auth);
    expect(response.token).toBeNull();
    expect((await db.select().from(schema.userSignupRisk))[0]?.verifiedAt).toBeNull();
    const verification = sent.find((message) => message.kind === "email_verification");
    const url = verification?.text.match(/https?:\/\/\S+/)?.[0];
    expect(url).toBeTruthy();
    expect((await auth.handler(new Request(url!))).status).toBe(302);
    const [risk] = await db.select().from(schema.userSignupRisk);
    expect(risk?.verifiedAt).toBeInstanceOf(Date);
    expect((await db.select().from(schema.user))[0]?.emailVerified).toBe(true);
    expect(
      (await db.select().from(schema.auditLog)).filter(
        (row) => row.action === "auth.signup_risk_verified",
      ),
    ).toHaveLength(1);
  });

  it("projects a fallback profile inside new-team creation without fabricating signup IP or verification time", async () => {
    await db
      .insert(schema.user)
      .values({ id: "legacy", name: "Synthetic", email, emailVerified: true });
    const { teamId } = await caller("legacy").team.createTeam({ name: "Risk fixture" });
    expect((await db.select().from(schema.userSignupRisk))[0]).toMatchObject({
      source: "team_fallback",
      ipKey: null,
      asn: null,
      verifiedAt: null,
    });
    expect((await db.select().from(schema.teamSignupRisk))[0]).toMatchObject({
      teamId,
      principalUserId: "legacy",
    });
    const standing = await caller("legacy", teamId).team.standing();
    expect(standing).toHaveProperty("signupRisk", "none");
    expect(JSON.stringify(standing)).not.toContain(email);
    expect(JSON.stringify(standing)).not.toContain("ipKey");
  });

  it("inherits a held owned team in the actual bootstrap transaction", async () => {
    await db
      .insert(schema.user)
      .values({ id: "owner", name: "Synthetic", email, emailVerified: true });
    const [held] = await db
      .insert(schema.teams)
      .values({
        name: "Held",
        slug: "held-fixture",
        plan: "pro",
        sendReviewAt: new Date(),
        sendReviewReason: "content",
      })
      .returning();
    await db
      .insert(schema.teamMembers)
      .values({ teamId: held!.id, userId: "owner", role: "owner" });
    const { teamId } = await caller("owner").team.createTeam({ name: "Cannot reset review" });
    expect(
      (
        await db
          .select()
          .from(schema.teamSignupRisk)
          .where(eq(schema.teamSignupRisk.teamId, teamId))
      )[0],
    ).toMatchObject({ level: "hold", reasons: expect.arrayContaining(["existing_owner_hold"]) });
    expect(
      (await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)))[0]
        ?.sendReviewReason,
    ).toBe("new_sender");
    expect(
      (await db.select().from(schema.teamFlags).where(eq(schema.teamFlags.teamId, teamId)))[0]
        ?.status,
    ).toBe("open");
    expect((await caller("owner", teamId).team.standing())?.signupRisk).toBe("review");
  });
});
