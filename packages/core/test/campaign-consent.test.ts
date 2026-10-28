import { randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb, verifiedMonthlyBilling } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  campaignConsentEvidenceSchema,
  campaignMessage,
  checkCampaignConsent,
  checkCampaignMessage,
  latestCampaignConsent,
  reviewCampaignConsent,
  submitCampaignConsent,
} from "../src/campaign-consent.js";
import { applySenderProbationQuota, probationCeiling } from "../src/sender-probation.js";
import {
  clearTeamSignupRisk,
  getSignupSendingRestriction,
} from "../src/signup-risk-enforcement.js";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => {
  await close?.();
});
const evidence = {
  listReference: "list-synthetic-42",
  source: "Direct first-party signup on our public website",
  method: "Explicit unchecked opt-in checkbox",
  formUrl: "https://example.test/signup",
  permissionText: "I agree to receive the Example product newsletter.",
  permissionScope: "Monthly Example product news only",
  samples: [
    { reference: "record-***42", registeredAt: "2026-01-01T12:00:00.000Z", ipAvailable: false },
  ],
};
async function fixture() {
  const teamId = await createTeam(db, randomUUID());
  const actorId = `owner-${randomUUID()}`;
  const operatorId = `operator-${randomUUID()}`;
  await db
    .update(schema.teams)
    .set({ sendReviewClearedAt: new Date() })
    .where(eq(schema.teams.id, teamId));
  const name = `${randomUUID()}.example.test`;
  const dnsRecords = [
    {
      group: "verification",
      name: `test._domainkey.${name}`,
      type: "TXT",
      status: "found" as const,
    },
    { group: "sending", name: `send.${name}`, type: "TXT", status: "found" as const },
    { group: "sending", name: `send.${name}`, type: "MX", status: "found" as const },
    { group: "dmarc", name: `_dmarc.${name}`, type: "TXT", status: "found" as const },
  ];
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name,
      dkimSelector: "test",
      region: "eu-west-1",
      status: "verified",
      dmarcPolicy: "none",
      dmarcCheckedAt: new Date(),
      dnsRecords,
    })
    .returning();
  if (!domain) throw new Error("Synthetic domain insert failed");
  return { teamId, actorId, operatorId, from: `service@${domain.name}`, domain };
}
it("payment plus DNS does not auto-clear sandbox, and operator review requires independent actor and actual DNS", async () => {
  const f = await fixture();
  const userId = randomUUID();
  await db.insert(schema.user).values({
    id: userId,
    email: `${userId}@example.test`,
    name: "Synthetic owner",
    emailVerified: true,
  });
  await db.insert(schema.teamSignupRisk).values({
    teamId: f.teamId,
    principalUserId: userId,
    level: "sandbox",
    signals: {
      domain: "example.test",
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
    },
    reasons: ["synthetic"],
  });
  const periodStart = new Date(Date.now() - 86400000);
  const periodEnd = new Date(Date.now() + 86400000);
  await db
    .update(schema.teams)
    .set({
      ...verifiedMonthlyBilling({ teamId: f.teamId, periodStart, periodEnd, included: 1000 }),
      plan: "pro",
      planStatus: "active",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      sendReviewClearedAt: null,
    })
    .where(eq(schema.teams.id, f.teamId));
  expect((await getSignupSendingRestriction(db, f.teamId, true)).kind).toBe("sandbox");
  await expect(
    clearTeamSignupRisk(db, {
      teamId: f.teamId,
      operatorId: userId,
      reason: "Owner cannot approve own new account",
    }),
  ).rejects.toThrow("independent_operator");
  await db.update(schema.domains).set({ dnsRecords: [] }).where(eq(schema.domains.id, f.domain.id));
  await expect(
    clearTeamSignupRisk(db, {
      teamId: f.teamId,
      operatorId: f.operatorId,
      reason: "DNS must really have been verified",
    }),
  ).rejects.toThrow("verified_dns");
});

it("probation uses existing atomic quota ceiling and never ramps by age or payment alone", async () => {
  const f = await fixture();
  expect(
    await applySenderProbationQuota(db, f.teamId, { kind: "day", plan: "free", limit: 100 }, true),
  ).toMatchObject({ dailyCeiling: 25 });
  expect(
    probationCeiling({
      reviewed: false,
      dnsReady: true,
      clean: true,
      ageDays: 90,
      operatorCeiling: 10000,
    }),
  ).toBe(25);
  expect(
    probationCeiling({
      reviewed: true,
      dnsReady: true,
      clean: true,
      ageDays: 1,
      operatorCeiling: 500,
    }),
  ).toBe(100);
  expect(
    probationCeiling({
      reviewed: true,
      dnsReady: true,
      clean: true,
      ageDays: 10,
      operatorCeiling: 500,
    }),
  ).toBe(200);
  expect(
    probationCeiling({
      reviewed: true,
      dnsReady: true,
      clean: false,
      ageDays: 90,
      operatorCeiling: 500,
    }),
  ).toBe(25);
});

it("defaults to shared-pool enforcement and only server-owned self-host mode opts out", async () => {
  const teamId = await createTeam(db, randomUUID());
  expect((await checkCampaignConsent(db, { teamId, operation: "import" })).allowed).toBe(false);
  expect(
    (await checkCampaignConsent(db, { teamId, operation: "import", isCloud: true })).allowed,
  ).toBe(false);
  expect(await checkCampaignConsent(db, { teamId, operation: "import", isCloud: false })).toEqual({
    allowed: true,
  });
  expect(
    (
      await checkCampaignMessage(db, {
        teamId,
        from: "service@example.test",
        broadcastId: randomUUID(),
      })
    ).allowed,
  ).toBe(false);
  expect(
    await checkCampaignMessage(db, {
      teamId,
      from: "service@example.test",
      broadcastId: randomUUID(),
      isCloud: false,
    }),
  ).toEqual({ allowed: true });
});

it("requires explicit evidence; absent IP is valid and never invented", () => {
  expect(campaignConsentEvidenceSchema.safeParse(evidence).success).toBe(true);
  expect(campaignConsentEvidenceSchema.safeParse({ ...evidence, samples: [] }).success).toBe(false);
  expect(
    campaignConsentEvidenceSchema.safeParse({
      ...evidence,
      formUrl: "https://example.test/?token=secret",
    }).success,
  ).toBe(false);
  expect(
    campaignConsentEvidenceSchema.safeParse({
      ...evidence,
      samples: [{ ...evidence.samples[0], ipAvailable: true }],
    }).success,
  ).toBe(false);
});
it("does not trust false transactional declarations and preserves password resets", () => {
  expect(
    campaignMessage({
      subject: "Reset your password",
      to: ["synthetic@example.test"],
      text: "You requested a password reset.",
    }),
  ).toBe(false);
  expect(campaignMessage({ subject: "Product newsletter", to: ["synthetic@example.test"] })).toBe(
    true,
  );
  expect(campaignMessage({ broadcastId: randomUUID(), subject: "Reset password" })).toBe(true);
  expect(
    campaignMessage({ headers: { "list-unsubscribe": "<https://example.test/unsubscribe>" } }),
  ).toBe(true);
});
it("new customer cannot import/campaign; independent operator approves and revokes with audit and no queue action", async () => {
  const f = await fixture();
  expect(
    (await checkCampaignConsent(db, { teamId: f.teamId, from: f.from, operation: "campaign" }))
      .allowed,
  ).toBe(false);
  const row = await submitCampaignConsent(db, { ...f, evidence });
  expect((await checkCampaignConsent(db, { teamId: f.teamId, operation: "import" })).allowed).toBe(
    false,
  );
  await expect(
    reviewCampaignConsent(db, {
      ...f,
      dossierId: row.id,
      operatorId: f.actorId,
      decision: "approved",
      reason: "Verified first party opt-in evidence",
    }),
  ).rejects.toThrow("independent_operator");
  await reviewCampaignConsent(db, {
    ...f,
    dossierId: row.id,
    decision: "approved",
    reason: "Verified first party opt-in evidence",
  });
  expect((await checkCampaignConsent(db, { teamId: f.teamId, operation: "import" })).allowed).toBe(
    true,
  );
  expect(
    (await checkCampaignMessage(db, { teamId: f.teamId, from: f.from, broadcastId: randomUUID() }))
      .allowed,
  ).toBe(true);
  await reviewCampaignConsent(db, {
    ...f,
    dossierId: row.id,
    decision: "revoked",
    reason: "Permission scope withdrawn by owner",
  });
  expect(
    (await checkCampaignMessage(db, { teamId: f.teamId, from: f.from, broadcastId: randomUUID() }))
      .allowed,
  ).toBe(false);
  expect(
    (
      await checkCampaignMessage(db, {
        teamId: f.teamId,
        from: f.from,
        subject: "Reset your password",
        to: ["synthetic@example.test"],
      })
    ).allowed,
  ).toBe(true);
  const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.teamId, f.teamId));
  expect(audit.map((a) => a.action)).toEqual([
    "campaign.consent_submitted",
    "campaign.consent_approved",
    "campaign.consent_revoked",
  ]);
  expect(audit.every((a) => a.data?.noQueueAction)).toBe(true);
});
it("tenant isolation, rejection, verified DNS and manual onboarding are independent gates", async () => {
  const f = await fixture();
  const other = await fixture();
  const row = await submitCampaignConsent(db, { ...f, evidence });
  expect(await latestCampaignConsent(db, other.teamId)).toBeNull();
  await expect(
    reviewCampaignConsent(db, {
      ...other,
      dossierId: row.id,
      decision: "approved",
      reason: "Cannot review another tenant dossier",
    }),
  ).rejects.toThrow("not_current");
  await reviewCampaignConsent(db, {
    ...f,
    dossierId: row.id,
    decision: "rejected",
    reason: "Evidence permission scope does not match",
  });
  expect((await checkCampaignConsent(db, { teamId: f.teamId, operation: "import" })).allowed).toBe(
    false,
  );
  const replacement = await submitCampaignConsent(db, { ...f, evidence });
  await reviewCampaignConsent(db, {
    ...f,
    dossierId: replacement.id,
    decision: "approved",
    reason: "Verified corrected opt-in scope and date",
  });
  await db
    .update(schema.teams)
    .set({ sendReviewClearedAt: null })
    .where(eq(schema.teams.id, f.teamId));
  expect(await checkCampaignConsent(db, { teamId: f.teamId, operation: "campaign" })).toMatchObject(
    { reason: "campaign_manual_review_required" },
  );
  await db
    .update(schema.teams)
    .set({ sendReviewClearedAt: new Date() })
    .where(eq(schema.teams.id, f.teamId));
  await db
    .update(schema.domains)
    .set({ dmarcCheckedAt: null })
    .where(eq(schema.domains.id, f.domain.id));
  expect(await checkCampaignConsent(db, { teamId: f.teamId, operation: "campaign" })).toMatchObject(
    { reason: "campaign_domain_required" },
  );
});
