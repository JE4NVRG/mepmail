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
    .values({ id: userId, email, name: "Synthetic", emailVerified: verified, createdAt: now });
  return { userId, email, secret: "synthetic-only-secret", now };
}
async function capture(over: Partial<SignupRiskSignals> = {}, verified = true) {
  const user = await person(verified);
  await recordSignupRisk(db, user, {
    collect: async () => signals({ domain: `${user.userId}.test`, ...over }),
  });
  return user;
}
async function team(userId: string, at = now, name = "Synthetic") {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [created] = await tx
      .insert(schema.teams)
      .values({ name, slug: randomUUID(), createdAt: at })
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
      verificationSeconds: 1,
      genericTeamName: true,
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
    expect(first.signals).toMatchObject({ verificationSeconds: null, genericTeamName: false });
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
    expect((await profile(user.userId))?.signals.verificationSeconds).toBe(10);
    expect(await audits("auth.signup_risk_verified", user.userId)).toHaveLength(1);
  });

  it("observes a verified social signup, but never fabricates a legacy verification time or original IP", async () => {
    const social = await capture();
    expect((await profile(social.userId))?.verifiedAt).toEqual(now);
    await markSignupEmailVerified(db, {
      userId: social.userId,
      now: new Date(now.getTime() + 8000),
    });
    expect((await profile(social.userId))?.signals.verificationSeconds).toBeNull();
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
    await markSignupEmailVerified(db, { userId: old.userId, now: new Date(now.getTime() + 8000) });
    expect((await profile(old.userId))?.signals.verificationSeconds).toBeNull();
  });

  it.each([0, -1000])(
    "does not turn a zero or negative verification interval into rapid evidence: %s",
    async (elapsed) => {
      const user = await capture({}, false);
      await db
        .update(schema.user)
        .set({ emailVerified: true })
        .where(eq(schema.user.id, user.userId));
      await markSignupEmailVerified(db, {
        userId: user.userId,
        now: new Date(now.getTime() + elapsed),
      });
      expect((await profile(user.userId))?.signals.verificationSeconds).toBeNull();
    },
  );

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
  it("sandboxes an unknown-age random signup with a generic team name before any full key", async () => {
    const user = await capture({ domainAgeDays: null, randomLocal: true }, false);
    const teamId = await team(user.userId, now, "Minha Loja");
    expect(await getTeamSignupRisk(db, teamId)).toMatchObject({
      level: "sandbox",
      signals: { genericTeamName: true },
    });
    expect(
      await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.teamId, teamId)),
    ).toHaveLength(0);
  });

  it.each([{ domainAgeDays: null }, { mx: "unknown" as const, domainAgeDays: 365 }])(
    "projects a measured rapid verification into an existing unknown random team before any full key: %j",
    async (change) => {
      const user = await capture({ ...change, randomLocal: true }, false);
      const teamId = await team(user.userId);
      expect((await getTeamSignupRisk(db, teamId))?.level).toBe("good");
      await db
        .update(schema.user)
        .set({ emailVerified: true })
        .where(eq(schema.user.id, user.userId));
      await markSignupEmailVerified(db, {
        userId: user.userId,
        now: new Date(now.getTime() + 8000),
      });
      expect((await profile(user.userId))?.level).toBe("sandbox");
      expect(await getTeamSignupRisk(db, teamId)).toMatchObject({
        level: "sandbox",
        signals: { verificationSeconds: 8 },
      });
      expect(
        await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.teamId, teamId)),
      ).toHaveLength(0);
    },
  );

  it("preserves an operator-cleared team when a later verification escalates its principal", async () => {
    const user = await capture({ domainAgeDays: null, randomLocal: true }, false);
    const teamId = await team(user.userId);
    await db
      .update(schema.teamSignupRisk)
      .set({
        clearedAt: now,
        clearedBy: "synthetic-operator",
        clearedReason: "Synthetic reviewed exception",
      })
      .where(eq(schema.teamSignupRisk.teamId, teamId));
    await db
      .update(schema.user)
      .set({ emailVerified: true })
      .where(eq(schema.user.id, user.userId));
    await markSignupEmailVerified(db, { userId: user.userId, now: new Date(now.getTime() + 8000) });
    expect((await profile(user.userId))?.level).toBe("sandbox");
    expect(await getTeamSignupRisk(db, teamId)).toMatchObject({ level: "good", clearedAt: now });
  });

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
  it("keeps the first-wave unknown-age random signup in sandbox after a 19-second full key", async () => {
    const user = await capture({ domainAgeDays: null, randomLocal: true });
    const teamId = await team(user.userId);
    expect((await getTeamSignupRisk(db, teamId))?.level).toBe("good");
    await key(teamId, new Date(now.getTime() + 19_000));
    await refreshSignupRiskAfterFullKey(db, { teamId, now: new Date(now.getTime() + 20_000) });
    expect(await getTeamSignupRisk(db, teamId)).toMatchObject({
      level: "sandbox",
      policyVersion: 2,
      signals: { domainAgeDays: null, randomLocal: true, rapidFullKey: true },
    });
    expect((await profile(user.userId))?.level).toBe("sandbox");
    expect(
      (await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)))[0]?.sendReviewAt,
    ).toBeNull();
  });

  it("uses the current team name instead of its enrollment snapshot", async () => {
    const user = await capture({ randomLocal: true });
    const teamId = await team(user.userId);
    expect((await getTeamSignupRisk(db, teamId))?.signals.genericTeamName).toBe(false);
    await db.update(schema.teams).set({ name: "Minha Loja" }).where(eq(schema.teams.id, teamId));
    await key(teamId);
    await refreshSignupRiskAfterFullKey(db, { teamId, now: new Date(now.getTime() + 100_000) });
    expect(await getTeamSignupRisk(db, teamId)).toMatchObject({
      level: "sandbox",
      signals: { genericTeamName: true },
    });
    expect(JSON.stringify((await getTeamSignupRisk(db, teamId))?.signals)).not.toContain(
      "Minha Loja",
    );
  });

  it("preserves a principal hold recorded after team enrollment when the first full key is late", async () => {
    const user = await capture();
    const teamId = await team(user.userId);
    await db
      .update(schema.userSignupRisk)
      .set({ level: "hold", reasons: ["existing_owner_hold"] })
      .where(eq(schema.userSignupRisk.userId, user.userId));
    await key(teamId, new Date(now.getTime() + 181_000));
    await refreshSignupRiskAfterFullKey(db, { teamId, now: new Date(now.getTime() + 200_000) });
    expect(await getTeamSignupRisk(db, teamId)).toMatchObject({
      level: "hold",
      reasons: ["existing_owner_hold"],
      signals: { rapidFullKey: false },
    });
    expect((await profile(user.userId))?.level).toBe("hold");
  });

  it("uses a verification callback observed after team enrollment without inventing a social time", async () => {
    const user = await capture({ randomLocal: true }, false);
    const teamId = await team(user.userId);
    expect((await getTeamSignupRisk(db, teamId))?.signals.verificationSeconds).toBeNull();
    await db
      .update(schema.user)
      .set({ emailVerified: true })
      .where(eq(schema.user.id, user.userId));
    await markSignupEmailVerified(db, { userId: user.userId, now: new Date(now.getTime() + 8000) });
    await key(teamId, new Date(now.getTime() + 19_000));
    await refreshSignupRiskAfterFullKey(db, { teamId, now: new Date(now.getTime() + 20_000) });
    expect(await getTeamSignupRisk(db, teamId)).toMatchObject({
      level: "sandbox",
      signals: { verificationSeconds: 8 },
    });
  });

  it("sees a signup burst formed after capture, excludes fallback captures and evaluates a late first full key", async () => {
    const domain = `refresh-burst-${randomUUID()}.test`;
    const user = await capture({ domain, randomLocal: true });
    const teamId = await team(user.userId);
    await recordSignupRisk(
      db,
      { ...(await person()), source: "team_fallback" },
      { collect: async () => signals({ domain }) },
    );
    await capture({ domain });
    await capture({ domain });
    expect((await profile(user.userId))?.signals.signupsDomain24h).toBe(1);
    await key(teamId, new Date(now.getTime() + 181_000));
    await refreshSignupRiskAfterFullKey(db, { teamId, now: new Date(now.getTime() + 200_000) });
    expect(await getTeamSignupRisk(db, teamId)).toMatchObject({
      level: "sandbox",
      signals: { signupsDomain24h: 3, rapidFullKey: false },
    });
    expect((await profile(user.userId))?.signals.signupsDomain24h).toBe(3);
  });

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
