import { randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb, verifiedMonthlyBilling } from "@millionsend/test-utils";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { issueApiKey } from "../src/api-key-issuance.js";
import * as keys from "../src/api-keys.js";
import { checkSignupSend } from "../src/signup-risk-enforcement.js";
import type { SignupRiskSignals } from "../src/signup-risk-policy.js";

let db: Db;
let close: () => Promise<void>;
const now = new Date("2026-10-17T15:00:00.000Z");
const at = new Date(now.getTime() + 20_000);

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

async function fixture(
  level: "good" | "sandbox" | "hold" = "good",
  overrides: Partial<SignupRiskSignals> = {},
  verified = true,
) {
  const teamId = await createTeam(db, `key-${randomUUID()}`);
  await db.update(schema.teams).set({ createdAt: now }).where(eq(schema.teams.id, teamId));
  const userId = randomUUID();
  const email = `${userId}@fixture.test`;
  const signals: SignupRiskSignals = {
    domain: `${userId}.test`,
    disposable: false,
    mx: "present",
    domainAgeDays: 400,
    catchAll: "unknown",
    randomLocal: false,
    ipKey: null,
    asn: null,
    signupsIp1h: 0,
    signupsDomain24h: 0,
    signupsAsn1h: 0,
    verificationSeconds: 4,
    ...overrides,
  };
  await db
    .insert(schema.user)
    .values({ id: userId, name: "Synthetic", email, emailVerified: verified });
  await db.insert(schema.teamMembers).values({ teamId, userId, role: "owner" });
  await db.insert(schema.userSignupRisk).values({
    userId,
    domain: signals.domain,
    level,
    signals,
    reasons: ["synthetic_fixture"],
    capturedAt: now,
  });
  await db.insert(schema.teamSignupRisk).values({
    teamId,
    principalUserId: userId,
    level,
    signals,
    reasons: ["synthetic_fixture"],
  });
  return { teamId, userId, email };
}

const mint = (
  teamId: string,
  permission: "full_access" | "sending_access" = "full_access",
  isCloud = true,
) => issueApiKey(db, { teamId, name: "Synthetic test", permission, isCloud, now: at });
const rows = (teamId: string) =>
  db.select().from(schema.apiKeys).where(eq(schema.apiKeys.teamId, teamId));

it("preserves legacy teams without captured risk, including full-access rotation", async () => {
  const teamId = await createTeam(db, `legacy-${randomUUID()}`);
  const result = await mint(teamId);
  expect(result.allowed).toBe(true);
  if (!result.allowed) throw new Error("expected key");
  const [stored] = await rows(teamId);
  expect(stored?.permission).toBe("full_access");
  expect(keys.verifyApiKey(result.token, stored?.keyHash ?? "")).toBe(true);
});

it("does not restrict a legitimate fast verification and full-key request alone", async () => {
  const f = await fixture();
  expect((await mint(f.teamId)).allowed).toBe(true);
  const [risk] = await db
    .select()
    .from(schema.teamSignupRisk)
    .where(eq(schema.teamSignupRisk.teamId, f.teamId));
  expect(risk?.level).toBe("good");
  expect(risk?.signals.rapidFullKey).toBe(true);
});

it("leaves self-host issuance behavior unchanged", async () => {
  const f = await fixture("hold");
  await db
    .update(schema.teams)
    .set({ suspendedAt: now, suspensionReason: "manual" })
    .where(eq(schema.teams.id, f.teamId));
  expect((await mint(f.teamId, "full_access", false)).allowed).toBe(true);
});

it.each(["risk", "hold", "suspension"] as const)(
  "refuses all new keys for a cloud %s without generating a secret or changing existing keys",
  async (kind) => {
    const f = await fixture(kind === "risk" ? "hold" : "good");
    const existing = await mint(f.teamId, "sending_access", false);
    expect(existing.allowed).toBe(true);
    if (kind === "hold")
      await db
        .update(schema.teams)
        .set({ sendReviewAt: now, sendReviewReason: "new_sender" })
        .where(eq(schema.teams.id, f.teamId));
    if (kind === "suspension")
      await db
        .update(schema.teams)
        .set({ suspendedAt: now, suspensionReason: "manual" })
        .where(eq(schema.teams.id, f.teamId));
    const before = await rows(f.teamId);
    const generate = vi.spyOn(keys, "generateApiKey");
    try {
      for (const permission of ["full_access", "sending_access"] as const)
        expect(await mint(f.teamId, permission)).toEqual({
          allowed: false,
          reason: "team_review_required",
        });
      expect(generate).not.toHaveBeenCalled();
      expect(await rows(f.teamId)).toEqual(before);
    } finally {
      generate.mockRestore();
    }
  },
);

it("refuses a sandbox full key explicitly and allows one sending-only own-address test key", async () => {
  const f = await fixture("sandbox");
  expect(await mint(f.teamId)).toEqual({ allowed: false, reason: "signup_api_key_restricted" });
  expect(await rows(f.teamId)).toHaveLength(0);
  expect((await mint(f.teamId, "sending_access")).allowed).toBe(true);
  expect(await mint(f.teamId, "sending_access")).toEqual({
    allowed: false,
    reason: "signup_sandbox_key_limit",
  });
  expect(await checkSignupSend(db, f.teamId, [f.email])).toEqual({ allowed: true });
  expect(await checkSignupSend(db, f.teamId, [f.email, "external@fixture.test"])).toEqual({
    allowed: false,
    reason: "signup_sandbox",
  });
  expect((await rows(f.teamId))[0]?.permission).toBe("sending_access");
});

it("permits replacement of a revoked sandbox key while retaining its history", async () => {
  const f = await fixture("sandbox");
  const first = await mint(f.teamId, "sending_access");
  if (!first.allowed) throw new Error("expected key");
  await db.update(schema.apiKeys).set({ revokedAt: at }).where(eq(schema.apiKeys.id, first.id));
  expect((await mint(f.teamId, "sending_access")).allowed).toBe(true);
  expect(await rows(f.teamId)).toHaveLength(2);
  expect((await rows(f.teamId)).filter((key) => !key.revokedAt)).toHaveLength(1);
});

it.each(["unverified", "orphaned"] as const)(
  "fails closed for a sandbox %s principal",
  async (kind) => {
    const f = await fixture("sandbox", {}, kind !== "unverified");
    if (kind === "orphaned") await db.delete(schema.user).where(eq(schema.user.id, f.userId));
    expect(await mint(f.teamId, "sending_access")).toEqual({
      allowed: false,
      reason: "team_review_required",
    });
    expect(await rows(f.teamId)).toHaveLength(0);
  },
);

it("persists prospective full-key escalation and audit even when issuance is refused", async () => {
  const f = await fixture("good", { domainAgeDays: null });
  const generate = vi.spyOn(keys, "generateApiKey");
  try {
    expect(await mint(f.teamId)).toEqual({ allowed: false, reason: "signup_api_key_restricted" });
    expect(generate).not.toHaveBeenCalled();
  } finally {
    generate.mockRestore();
  }
  const [risk] = await db
    .select()
    .from(schema.teamSignupRisk)
    .where(eq(schema.teamSignupRisk.teamId, f.teamId));
  expect(risk).toMatchObject({ level: "sandbox", signals: { rapidFullKey: true } });
  expect(await rows(f.teamId)).toHaveLength(0);
  const audits = await db
    .select()
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.teamId, f.teamId),
        eq(schema.auditLog.action, "team.signup_risk_escalated"),
      ),
    );
  expect(audits).toHaveLength(1);
  expect(audits[0]?.data).toMatchObject({ keyIssuanceAttempt: true, to: "sandbox" });
});

it("commits a prospective hold before refusing the first full key, without releasing existing holds", async () => {
  const f = await fixture("good", { domainAgeDays: 15, randomLocal: true });
  expect(await mint(f.teamId)).toEqual({ allowed: false, reason: "team_review_required" });
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, f.teamId));
  expect(team?.sendReviewAt).not.toBeNull();
  expect(await rows(f.teamId)).toHaveLength(0);
});

it("preserves an operator-cleared risk override, but an independent hold still refuses issuance", async () => {
  const f = await fixture("hold");
  await db
    .update(schema.teamSignupRisk)
    .set({ clearedAt: now, clearedBy: f.userId, clearedReason: "Synthetic operator decision" })
    .where(eq(schema.teamSignupRisk.teamId, f.teamId));
  expect((await mint(f.teamId)).allowed).toBe(true);
  await db
    .update(schema.teams)
    .set({ sendReviewAt: now, sendReviewReason: "new_sender" })
    .where(eq(schema.teams.id, f.teamId));
  expect(await mint(f.teamId)).toEqual({ allowed: false, reason: "team_review_required" });
});

it("preserves the existing verified-contract plus verified-domain exception, never payment alone", async () => {
  const f = await fixture("sandbox");
  const periodStart = new Date(Date.now() - 86_400_000);
  const periodEnd = new Date(Date.now() + 30 * 86_400_000);
  await db
    .update(schema.teams)
    .set({
      plan: "pro",
      planQuota: 110_000,
      planStatus: "active",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      ...verifiedMonthlyBilling({ teamId: f.teamId, periodStart, periodEnd, included: 110_000 }),
    })
    .where(eq(schema.teams.id, f.teamId));
  expect(await mint(f.teamId)).toEqual({ allowed: false, reason: "signup_api_key_restricted" });
  await db.insert(schema.domains).values({
    teamId: f.teamId,
    name: `${f.userId}.test`,
    status: "verified",
    region: "us-east-1",
  });
  expect((await mint(f.teamId)).allowed).toBe(true);
  await db
    .update(schema.teams)
    .set({ sendReviewAt: now, sendReviewReason: "new_sender" })
    .where(eq(schema.teams.id, f.teamId));
  expect(await mint(f.teamId)).toEqual({ allowed: false, reason: "team_review_required" });
});

it("serializes concurrent sandbox key creation so only one request succeeds", async () => {
  const f = await fixture("sandbox");
  const results = await Promise.all([
    mint(f.teamId, "sending_access"),
    mint(f.teamId, "sending_access"),
  ]);
  expect(results.filter((result) => result.allowed)).toHaveLength(1);
  expect(await rows(f.teamId)).toHaveLength(1);
});

it("serializes the last normal slot across minters and keeps the existing cap", async () => {
  const teamId = await createTeam(db, `normal-cap-${randomUUID()}`);
  await db.insert(schema.apiKeys).values(
    Array.from({ length: keys.MAX_ACTIVE_API_KEYS - 1 }, () => {
      const key = keys.generateApiKey();
      return {
        teamId,
        name: "Synthetic existing key",
        tokenPrefix: key.tokenPrefix,
        keyHash: key.keyHash,
        last4: key.last4,
      };
    }),
  );
  const results = await Promise.all([mint(teamId), mint(teamId)]);
  expect(results.filter((result) => result.allowed)).toHaveLength(1);
  expect(
    await db
      .select()
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.teamId, teamId), isNull(schema.apiKeys.revokedAt))),
  ).toHaveLength(keys.MAX_ACTIVE_API_KEYS);
});
