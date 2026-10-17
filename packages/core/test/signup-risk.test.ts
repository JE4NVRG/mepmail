import { randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  enrollTeamSignupRisk,
  getTeamSignupRisk,
  markSignupEmailVerified,
  recordSignupRisk,
  refreshSignupRiskAfterFullKey,
} from "../src/signup-risk.js";
import type { SignupRiskSignals } from "../src/signup-risk-policy.js";
import type { CollectSignupRiskInput } from "../src/signup-risk-signals.js";

let db: Db;
let close: () => Promise<void>;
const now = new Date("2026-10-17T04:00:00.000Z");
const signals = (over: Partial<SignupRiskSignals> = {}): SignupRiskSignals => ({
  domain: "signup.test",
  disposable: false,
  mx: "present",
  domainAgeDays: 365,
  catchAll: "unknown",
  randomLocal: false,
  ipKey: null,
  asn: null,
  signupsIp1h: 0,
  signupsDomain24h: 0,
  signupsAsn1h: 0,
  ...over,
});
async function person(verified = false) {
  const userId = randomUUID();
  const email = `${userId}@signup.test`;
  await db
    .insert(schema.user)
    .values({ id: userId, email, name: "Synthetic", emailVerified: verified });
  return { userId, email, secret: "synthetic-only-secret", now };
}
async function capture(over: Partial<SignupRiskSignals> = {}, verified = true) {
  const user = await person(verified);
  await recordSignupRisk(db, user, {
    collect: async () => signals({ domain: `${user.userId}.test`, ...over }),
  });
  return user;
}
async function team(userId: string, at = now) {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [created] = await tx
      .insert(schema.teams)
      .values({ name: "Synthetic", slug: randomUUID(), createdAt: at })
      .returning();
    if (!created) throw new Error("fixture_team_missing");
    await tx.insert(schema.teamMembers).values({ teamId: created.id, userId, role: "owner" });
    await enrollTeamSignupRisk(tx, { teamId: created.id, userId, now: at });
    return created.id;
  });
}
async function key(
  teamId: string,
  at = new Date(now.getTime() + 90_000),
  permission: "full_access" | "sending_access" = "full_access",
) {
  const id = randomUUID();
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "Synthetic",
    tokenPrefix: id,
    keyHash: id,
    last4: "test",
    permission,
    createdAt: at,
  });
}
const profile = async (userId: string) =>
  (
    await db.select().from(schema.userSignupRisk).where(eq(schema.userSignupRisk.userId, userId))
  )[0];
const audits = (action: string, userId: string) =>
  db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.actorId, `user:${userId}`)));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

describe("signup risk capture and verification", () => {
  it("captures unverified people once and stores only allow-listed private metadata", async () => {
    const user = await person();
    const collect = vi.fn(async () => ({
      ...signals(),
      rawIp: "198.51.100.41",
      email: user.email,
    }));
    const first = await recordSignupRisk(db, user, { collect });
    const again = await recordSignupRisk(
      db,
      { ...user, source: "team_fallback", now: new Date(now.getTime() + 1000) },
      { collect },
    );
    expect(collect).toHaveBeenCalledTimes(1);
    expect(again).toEqual(first);
    expect(first).toMatchObject({ source: "signup", capturedAt: now, verifiedAt: null });
    expect(JSON.stringify(first)).not.toContain("198.51.100.41");
    expect(JSON.stringify(first)).not.toContain(user.email);
    expect(await audits("auth.signup_risk_recorded", user.userId)).toHaveLength(1);
  });

  it("records real verification idempotently, never updated_at or a callback before verification", async () => {
    const user = await capture({}, false);
    await db
      .update(schema.user)
      .set({ updatedAt: new Date(now.getTime() + 5000) })
      .where(eq(schema.user.id, user.userId));
    await markSignupEmailVerified(db, { userId: user.userId, now });
    expect((await profile(user.userId))?.verifiedAt).toBeNull();
    await db
      .update(schema.user)
      .set({ emailVerified: true })
      .where(eq(schema.user.id, user.userId));
    const verifiedAt = new Date(now.getTime() + 10_000);
    await markSignupEmailVerified(db, { userId: user.userId, now: verifiedAt });
    await markSignupEmailVerified(db, {
      userId: user.userId,
      now: new Date(now.getTime() + 20_000),
    });
    expect((await profile(user.userId))?.verifiedAt).toEqual(verifiedAt);
    expect(await audits("auth.signup_risk_verified", user.userId)).toHaveLength(1);
  });

  it("observes a verified social signup, but never fabricates a legacy verification time or original IP", async () => {
    const social = await capture();
    expect((await profile(social.userId))?.verifiedAt).toEqual(now);
    const old = await person(true);
    const collect = vi.fn(async (_input: CollectSignupRiskInput) =>
      signals({ domain: "legacy.test" }),
    );
    await recordSignupRisk(
      db,
      { ...old, source: "team_fallback", ip: "198.51.100.42" },
      { collect },
    );
    expect(collect.mock.calls[0]?.[0]).not.toHaveProperty("ip");
    expect((await profile(old.userId))?.verifiedAt).toBeNull();
  });

  it("counts actual signup captures, excluding legacy fallback creation from signup velocity", async () => {
    const domain = `burst-${randomUUID()}.test`;
    const ipKey = "a".repeat(64);
    const collect = async () =>
      signals({ domain, ipKey, asn: 64501, domainAgeDays: 2, randomLocal: true });
    const first = await recordSignupRisk(db, await person(), { collect });
    await recordSignupRisk(db, { ...(await person()), source: "team_fallback" }, { collect });
    const second = await recordSignupRisk(db, await person(), { collect });
    const third = await recordSignupRisk(db, await person(), { collect });
    expect(first.signals.signupsDomain24h).toBe(1);
    expect(second.signals.signupsDomain24h).toBe(2);
    expect(third.signals).toMatchObject({ signupsDomain24h: 3, signupsIp1h: 3, signupsAsn1h: 3 });
    expect(third.level).toBe("hold");
  });

  it("serializes duplicate captures without replacing provenance", async () => {
    const user = await person();
    await Promise.all([
      recordSignupRisk(db, user, { collect: async () => signals() }),
      recordSignupRisk(db, user, { collect: async () => signals() }),
    ]);
    expect(await audits("auth.signup_risk_recorded", user.userId)).toHaveLength(1);
  });
});

describe("team projection, holds and immutable principal", () => {
  it("preserves legacy absence and returns server-only principal verification", async () => {
    const [legacy] = await db
      .insert(schema.teams)
      .values({ name: "Legacy", slug: randomUUID() })
      .returning();
    expect(await getTeamSignupRisk(db, legacy!.id)).toBeNull();
    const user = await capture({}, false);
    const teamId = await team(user.userId);
    expect(await getTeamSignupRisk(db, teamId)).toMatchObject({
      principalEmail: user.email,
      principalVerified: false,
      clearedAt: null,
    });
  });

  it("inherits another owned team's hold, writes review flag and mandatory audit together", async () => {
    const user = await capture();
    const oldTeam = await team(user.userId);
    await db
      .update(schema.teams)
      .set({ sendReviewAt: now, sendReviewReason: "content" })
      .where(eq(schema.teams.id, oldTeam));
    const newTeam = await team(user.userId);
    expect(await getTeamSignupRisk(db, newTeam)).toMatchObject({
      level: "hold",
      reasons: ["existing_owner_hold"],
    });
    expect((await profile(user.userId))?.level).toBe("hold");
    expect(
      (await db.select().from(schema.teamFlags).where(eq(schema.teamFlags.teamId, newTeam)))[0],
    ).toMatchObject({ reason: "review", status: "open" });
    expect(
      (await db.select().from(schema.teams).where(eq(schema.teams.id, newTeam)))[0],
    ).toMatchObject({ sendReviewReason: "new_sender", sendReviewAt: now });
    expect(await audits("team.signup_risk_enrolled", user.userId)).toHaveLength(2);
    // Deleting the old team cannot erase the persisted user assessment.
    await db.delete(schema.teams).where(eq(schema.teams.id, oldTeam));
    expect((await getTeamSignupRisk(db, await team(user.userId)))?.level).toBe("hold");
  });

  it("does not inherit a team where the principal is only a member", async () => {
    const user = await capture();
    const [other] = await db
      .insert(schema.teams)
      .values({ name: "Other", slug: randomUUID(), suspendedAt: now })
      .returning();
    await db
      .insert(schema.teamMembers)
      .values({ teamId: other!.id, userId: user.userId, role: "member" });
    expect((await getTeamSignupRisk(db, await team(user.userId)))?.level).toBe("good");
  });

  it("forbids principal reassignment and keeps a deleted original principal unsafe", async () => {
    const original = await capture();
    const other = await capture();
    const teamId = await team(original.userId);
    await expect(
      db
        .update(schema.teamSignupRisk)
        .set({ principalUserId: other.userId })
        .where(eq(schema.teamSignupRisk.teamId, teamId)),
    ).rejects.toThrow();
    await db
      .update(schema.teamSignupRisk)
      .set({
        clearedAt: now,
        clearedBy: "synthetic-operator",
        clearedReason: "Previously reviewed principal",
      })
      .where(eq(schema.teamSignupRisk.teamId, teamId));
    await db.delete(schema.user).where(eq(schema.user.id, original.userId));
    expect(await getTeamSignupRisk(db, teamId)).toMatchObject({
      level: "hold",
      principalEmail: null,
      principalVerified: false,
      reasons: ["principal_missing"],
      clearedAt: null,
    });
    expect(
      (
        await db
          .select()
          .from(schema.teamSignupRisk)
          .where(eq(schema.teamSignupRisk.teamId, teamId))
      )[0]?.clearedAt,
    ).toEqual(now);
  });

  it("rolls team creation and its hold back when mandatory risk audit fails", async () => {
    const user = await capture({ domainAgeDays: 2, randomLocal: true });
    await db
      .update(schema.userSignupRisk)
      .set({ level: "hold" })
      .where(eq(schema.userSignupRisk.userId, user.userId));
    const slug = randomUUID();
    await db.execute(
      sql.raw(
        `CREATE FUNCTION signup_risk_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'team.signup_risk_enrolled' AND NEW.actor_id = 'user:${user.userId}' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$`,
      ),
    );
    await db.execute(
      sql.raw(
        "CREATE TRIGGER signup_risk_test_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION signup_risk_test_audit_failure()",
      ),
    );
    try {
      await expect(
        db.transaction(async (transaction) => {
          const tx = transaction as unknown as Db;
          const [row] = await tx
            .insert(schema.teams)
            .values({ name: "Rollback", slug })
            .returning();
          await enrollTeamSignupRisk(tx, { teamId: row!.id, userId: user.userId, now });
        }),
      ).rejects.toThrow("signup_risk_audit_unavailable");
      expect(await db.select().from(schema.teams).where(eq(schema.teams.slug, slug))).toHaveLength(
        0,
      );
    } finally {
      await db.execute(sql.raw("DROP TRIGGER signup_risk_test_audit_failure ON audit_log"));
      await db.execute(sql.raw("DROP FUNCTION signup_risk_test_audit_failure()"));
    }
  });
});

describe("full-key rescreening", () => {
  it("escalates a young random signup after a full key, persists the user assessment and never releases mail", async () => {
    const user = await capture({ domainAgeDays: 2, randomLocal: true });
    const teamId = await team(user.userId);
    expect((await getTeamSignupRisk(db, teamId))?.level).toBe("sandbox");
    await key(teamId);
    await refreshSignupRiskAfterFullKey(db, { teamId, now: new Date(now.getTime() + 100_000) });
    expect(await getTeamSignupRisk(db, teamId)).toMatchObject({
      level: "hold",
      signals: { rapidFullKey: true },
    });
    expect((await profile(user.userId))?.level).toBe("hold");
    expect((await getTeamSignupRisk(db, await team(user.userId)))?.level).toBe("hold");
    await refreshSignupRiskAfterFullKey(db, { teamId, now: new Date(now.getTime() + 200_000) });
    expect(await audits("team.signup_risk_escalated", user.userId)).toHaveLength(1);
  });

  it("measures the three-minute interval from team creation, not user creation, and ignores sending-only keys", async () => {
    const user = await capture({ domainAgeDays: 2, randomLocal: true });
    const lateTeamAt = new Date(now.getTime() + 86_400_000);
    const teamId = await team(user.userId, lateTeamAt);
    await key(teamId, new Date(lateTeamAt.getTime() + 181_000));
    await key(teamId, new Date(lateTeamAt.getTime() + 50_000), "sending_access");
    await refreshSignupRiskAfterFullKey(db, {
      teamId,
      now: new Date(lateTeamAt.getTime() + 200_000),
    });
    expect((await getTeamSignupRisk(db, teamId))?.level).toBe("sandbox");
    await key(teamId, new Date(lateTeamAt.getTime() + 180_000));
    await refreshSignupRiskAfterFullKey(db, {
      teamId,
      now: new Date(lateTeamAt.getTime() + 200_000),
    });
    expect((await getTeamSignupRisk(db, teamId))?.level).toBe("hold");
  });

  it("does not undo a per-team operator override or an existing hold reason", async () => {
    const user = await capture({ domainAgeDays: 2, randomLocal: true });
    const teamId = await team(user.userId);
    await key(teamId);
    await db
      .update(schema.teamSignupRisk)
      .set({
        clearedAt: now,
        clearedBy: "synthetic-operator",
        clearedReason: "Synthetic reviewed exception",
      })
      .where(eq(schema.teamSignupRisk.teamId, teamId));
    await refreshSignupRiskAfterFullKey(db, { teamId, now: new Date(now.getTime() + 100_000) });
    expect((await getTeamSignupRisk(db, teamId))?.level).toBe("sandbox");
    expect(await audits("team.signup_risk_escalated", user.userId)).toHaveLength(0);
    const otherId = await team(user.userId);
    await db
      .update(schema.teams)
      .set({ sendReviewAt: now, sendReviewReason: "content" })
      .where(eq(schema.teams.id, otherId));
    await key(otherId);
    await refreshSignupRiskAfterFullKey(db, {
      teamId: otherId,
      now: new Date(now.getTime() + 100_000),
    });
    expect(
      (await db.select().from(schema.teams).where(eq(schema.teams.id, otherId)))[0]
        ?.sendReviewReason,
    ).toBe("content");
  });
});
