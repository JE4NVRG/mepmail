import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb, verifiedMonthlyBilling } from "@millionsend/test-utils";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { acceptEmail } from "../src/accept-email.js";
import { EnvKeyring, type Keyring } from "../src/crypto/keyring.js";
import {
  checkSignupSend,
  clearTeamSignupRisk,
  getSignupSendingRestriction,
} from "../src/signup-risk-enforcement.js";

let db: Db;
let close: () => Promise<void>;

// Every signal and identity belongs to this in-memory migrated fixture.
const signals = {
  domain: "signup-fixture.example.test",
  disposable: false,
  mx: "present" as const,
  domainAgeDays: 400,
  catchAll: "unknown" as const,
  randomLocal: false,
  ipKey: null,
  asn: null,
  signupsIp1h: 0,
  signupsDomain24h: 0,
  signupsAsn1h: 0,
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

async function fixture(level: "sandbox" | "good" | "hold" = "sandbox", verified = true) {
  const userId = randomUUID();
  const email = `principal-${userId}@example.test`;
  const teamId = await createTeam(db, `signup-risk-${userId}`);
  await db
    .insert(schema.user)
    .values({ id: userId, name: "Synthetic principal", email, emailVerified: verified });
  await db.insert(schema.teamMembers).values({ teamId, userId, role: "owner" });
  await db
    .insert(schema.teamSignupRisk)
    .values({ teamId, principalUserId: userId, level, signals, reasons: ["synthetic_fixture"] });
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: `${userId}.example.test`, region: "us-east-1", status: "verified" })
    .returning({ id: schema.domains.id, name: schema.domains.name });
  if (!domain) throw new Error("synthetic domain missing");
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  if (!team) throw new Error("synthetic team missing");
  return { teamId, userId, email, domain, team };
}

async function paid(teamId: string) {
  const periodStart = new Date(Date.now() - 86_400_000);
  const periodEnd = new Date(Date.now() + 30 * 86_400_000);
  const binding = verifiedMonthlyBilling({ teamId, periodStart, periodEnd, included: 110_000 });
  const customerId = `cus_${teamId}`;
  const subscriptionId = `sub_${teamId}`;
  await db
    .update(schema.teams)
    .set({
      ...binding,
      plan: "pro",
      planQuota: 110_000,
      planStatus: "active",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      sendBillingContract: { ...binding.sendBillingContract, customerId, subscriptionId },
      billingTerms: { ...binding.billingTerms, customerId, subscriptionId },
    })
    .where(eq(schema.teams.id, teamId));
}

function cryptoSpy() {
  const real = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  const wrap = vi.fn((dek: Buffer) => real.wrapDek(dek));
  const keyring: Keyring = {
    wrapDek: wrap,
    unwrapDek: (wrapped, version) => real.unwrapDek(wrapped, version),
  };
  return { wrap, keyring };
}

it("accepts a sandbox test only to the original verified mailbox", async () => {
  const f = await fixture();
  const { keyring, wrap } = cryptoSpy();
  const enqueue = vi.fn(async (_id: string) => {});
  const result = await acceptEmail(
    { db, keyring, isCloud: true, enqueueEmailSend: enqueue },
    { teamId: f.teamId, billing: f.team, apiKeyId: null },
    {
      from: `Fixture <sender@${f.domain.name}>`,
      to: [`Principal <${f.email.toUpperCase()}>`],
      subject: "Synthetic hello",
      text: "Synthetic body",
      domainId: f.domain.id,
    },
  );
  expect(result.ok).toBe(true);
  expect(wrap).toHaveBeenCalledOnce();
  expect(enqueue).toHaveBeenCalledOnce();
});

it.each(["cc", "bcc"] as const)(
  "one external %s refuses the whole email before encryption, quota or queue",
  async (field) => {
    const f = await fixture();
    const { keyring, wrap } = cryptoSpy();
    const enqueue = vi.fn(async (_id: string) => {});
    const result = await acceptEmail(
      { db, keyring, isCloud: true, enqueueEmailSend: enqueue },
      { teamId: f.teamId, billing: f.team, apiKeyId: null },
      {
        from: `sender@${f.domain.name}`,
        to: [f.email],
        [field]: ["external@example.test"],
        subject: "Synthetic hello",
        text: "Synthetic body",
        domainId: f.domain.id,
      },
    );
    expect(result).toEqual({ ok: false, reason: "signup_sandbox" });
    expect(wrap).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(
      await db.select().from(schema.emails).where(eq(schema.emails.teamId, f.teamId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(schema.usageCounters).where(eq(schema.usageCounters.teamId, f.teamId)),
    ).toHaveLength(0);
  },
);

it("membership and a verified invitee cannot expand the original principal", async () => {
  const f = await fixture();
  const memberId = randomUUID();
  const memberEmail = `${memberId}@example.test`;
  await db
    .insert(schema.user)
    .values({ id: memberId, name: "Synthetic invitee", email: memberEmail, emailVerified: true });
  await db.insert(schema.teamMembers).values({ teamId: f.teamId, userId: memberId, role: "admin" });
  expect(await checkSignupSend(db, f.teamId, [memberEmail])).toEqual({
    allowed: false,
    reason: "signup_sandbox",
  });
  expect(await checkSignupSend(db, f.teamId, [f.email])).toEqual({ allowed: true });
  expect(await checkSignupSend(db, f.teamId, [f.email.replace("@", "+alias@")])).toEqual({
    allowed: false,
    reason: "signup_sandbox",
  });
});

it.each(["missing", "unverified"] as const)(
  "denies a %s principal, including self sends",
  async (kind) => {
    const f = await fixture("sandbox", kind !== "unverified");
    if (kind === "missing") {
      await clearTeamSignupRisk(db, {
        teamId: f.teamId,
        operatorId: f.userId,
        reason: "Synthetic review before deleting this fixture principal",
      });
      await db.delete(schema.user).where(eq(schema.user.id, f.userId));
    } else {
      await expect(
        clearTeamSignupRisk(db, {
          teamId: f.teamId,
          operatorId: f.userId,
          reason: "Synthetic operator cannot bypass principal verification",
        }),
      ).rejects.toThrow("signup_review_verified_principal_required");
    }
    expect(await checkSignupSend(db, f.teamId, [f.email])).toEqual({
      allowed: false,
      reason: kind === "missing" ? "signup_review_required" : "signup_sandbox",
    });
  },
);

it("payment alone and an active contract without verified DNS do not clear sandbox", async () => {
  const f = await fixture();
  await paid(f.teamId);
  await db
    .update(schema.teams)
    .set({ sendBillingContract: null })
    .where(eq(schema.teams.id, f.teamId));
  expect(await checkSignupSend(db, f.teamId, ["external@example.test"])).toEqual({
    allowed: false,
    reason: "signup_sandbox",
  });
  await paid(f.teamId);
  await db
    .update(schema.domains)
    .set({ status: "pending", verifiedAt: null })
    .where(eq(schema.domains.id, f.domain.id));
  expect(await checkSignupSend(db, f.teamId, ["external@example.test"])).toEqual({
    allowed: false,
    reason: "signup_sandbox",
  });
  await db
    .update(schema.domains)
    .set({ status: "verified", verifiedAt: new Date() })
    .where(eq(schema.domains.id, f.domain.id));
  expect(await checkSignupSend(db, f.teamId, ["external@example.test"])).toEqual({ allowed: true });
});

it("a good paid team flows normally, but payment cannot bypass a review profile", async () => {
  const good = await fixture("good");
  await paid(good.teamId);
  expect(await getSignupSendingRestriction(db, good.teamId)).toEqual({ kind: "none" });
  const held = await fixture("hold");
  await paid(held.teamId);
  expect(await checkSignupSend(db, held.teamId, [held.email])).toEqual({
    allowed: false,
    reason: "signup_review_required",
  });
});

it("an audited human decision is per team, idempotent, and preserves holds and queued mail", async () => {
  const f = await fixture("hold");
  const otherTeamId = await createTeam(db, `same-principal-${randomUUID()}`);
  await db
    .insert(schema.teamSignupRisk)
    .values({ teamId: otherTeamId, principalUserId: f.userId, level: "sandbox", signals });
  const holdAt = new Date("2026-10-01T00:00:00Z");
  await db
    .update(schema.teams)
    .set({
      sendReviewAt: holdAt,
      sendReviewReason: "content",
      suspendedAt: holdAt,
      suspensionReason: "manual",
    })
    .where(eq(schema.teams.id, f.teamId));
  const [queued] = await db
    .insert(schema.emails)
    .values({
      teamId: f.teamId,
      from: "fixture@example.test",
      to: ["external@example.test"],
      subject: "Synthetic queued row",
      latestStatus: "queued_quota",
    })
    .returning();
  const reason = "Synthetic operator reviewed the intended use";
  expect(await clearTeamSignupRisk(db, { teamId: f.teamId, operatorId: f.userId, reason })).toBe(
    true,
  );
  expect(await clearTeamSignupRisk(db, { teamId: f.teamId, operatorId: f.userId, reason })).toBe(
    false,
  );
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, f.teamId));
  expect(team).toMatchObject({
    sendReviewAt: holdAt,
    sendReviewReason: "content",
    suspendedAt: holdAt,
    suspensionReason: "manual",
  });
  const rows = await db.select().from(schema.emails).where(eq(schema.emails.teamId, f.teamId));
  expect(rows).toEqual([queued]);
  expect(await checkSignupSend(db, otherTeamId, ["external@example.test"])).toEqual({
    allowed: false,
    reason: "signup_sandbox",
  });
  const audit = await db
    .select()
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.teamId, f.teamId),
        eq(schema.auditLog.action, "team.signup_risk_cleared"),
      ),
    );
  expect(audit).toMatchObject([
    {
      actorId: `user:${f.userId}`,
      target: `team:${f.teamId}`,
      data: { reason, existingHoldOrSuspensionUnchanged: true, noQueueAction: true },
    },
  ]);
  expect(audit).toHaveLength(1);
});

it("requires a review reason and rolls back clearance if mandatory audit cannot be written", async () => {
  const f = await fixture();
  await expect(
    clearTeamSignupRisk(db, { teamId: f.teamId, operatorId: f.userId, reason: "short" }),
  ).rejects.toThrow("signup_review_reason_required");
  // Deliberately fail only this synthetic team's audit in this synthetic DB.
  await db.execute(
    sql.raw(`CREATE FUNCTION reject_fixture_signup_audit() RETURNS trigger AS $$
    BEGIN IF NEW.action = 'team.signup_risk_cleared' AND NEW.team_id = '${f.teamId}'::uuid
    THEN RAISE EXCEPTION 'synthetic audit unavailable'; END IF; RETURN NEW; END;
    $$ LANGUAGE plpgsql;`),
  );
  await db.execute(
    sql.raw(`CREATE TRIGGER reject_fixture_signup_audit BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION reject_fixture_signup_audit();`),
  );
  await expect(
    clearTeamSignupRisk(db, {
      teamId: f.teamId,
      operatorId: f.userId,
      reason: "Synthetic mandatory audit failure fixture",
    }),
  ).rejects.toThrow();
  const [risk] = await db
    .select()
    .from(schema.teamSignupRisk)
    .where(eq(schema.teamSignupRisk.teamId, f.teamId));
  expect(risk).toMatchObject({ clearedAt: null, clearedBy: null, clearedReason: null });
});

it("keeps legacy teams and self-host sends on their existing path", async () => {
  const legacy = await createTeam(db, `legacy-${randomUUID()}`);
  expect(await checkSignupSend(db, legacy, ["external@example.test"])).toEqual({ allowed: true });
  const held = await fixture("hold");
  expect(await checkSignupSend(db, held.teamId, ["external@example.test"], false)).toEqual({
    allowed: true,
  });
});
