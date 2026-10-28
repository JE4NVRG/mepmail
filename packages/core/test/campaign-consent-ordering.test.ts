import { randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  checkCampaignConsent,
  latestCampaignConsent,
  reviewCampaignConsent,
  submitCampaignConsent,
} from "../src/campaign-consent.js";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => {
  await close?.();
});
const evidence = {
  listReference: "synthetic-order-list",
  source: "Direct registration on our public website",
  method: "Explicit unchecked opt-in checkbox",
  formUrl: "https://example.test/signup",
  permissionText: "I agree to receive the Example product newsletter.",
  permissionScope: "Monthly Example product updates only",
  samples: [
    { reference: "record-***42", registeredAt: "2026-01-01T12:00:00.000Z", ipAvailable: false },
  ],
};

it.each(["same transaction timestamp", "prior marker ahead of the wall clock"])(
  "a replacement revokes effective prior approval with %s, independent of UUID order",
  async (schedule) => {
    const teamId = await createTeam(db, randomUUID());
    const domain = `${randomUUID()}.example.test`;
    await db
      .update(schema.teams)
      .set({ sendReviewClearedAt: new Date() })
      .where(eq(schema.teams.id, teamId));
    await db.insert(schema.domains).values({
      teamId,
      name: domain,
      region: "eu-west-1",
      status: "verified",
      dkimSelector: "test",
      dmarcPolicy: "none",
      dmarcCheckedAt: new Date(),
      dnsRecords: [
        { group: "verification", name: `test._domainkey.${domain}`, type: "TXT", status: "found" },
        { group: "sending", name: `send.${domain}`, type: "TXT", status: "found" },
        { group: "sending", name: `send.${domain}`, type: "MX", status: "found" },
        { group: "dmarc", name: `_dmarc.${domain}`, type: "TXT", status: "found" },
      ],
    });
    await db.transaction(async (tx) => {
      const transactionalDb = tx as unknown as Db;
      // A maximum valid v4 UUID makes the old failure deterministic: an equal
      // timestamp cannot be rescued by a lucky randomly generated identifier.
      const priorId =
        schedule === "same transaction timestamp"
          ? "ffffffff-ffff-4fff-bfff-ffffffffffff"
          : randomUUID();
      await tx
        .insert(schema.campaignConsentDossiers)
        .values({
          id: priorId,
          teamId,
          evidence,
          submittedBy: "synthetic-owner",
          submittedAt:
            schedule === "same transaction timestamp"
              ? sql`now()`
              : sql`clock_timestamp() + interval '1 hour'`,
        });
      await reviewCampaignConsent(transactionalDb, {
        teamId,
        dossierId: priorId,
        operatorId: "synthetic-independent-operator",
        decision: "approved",
        reason: "Verified original synthetic consent records",
      });
      expect(
        (await checkCampaignConsent(transactionalDb, { teamId, operation: "import" })).allowed,
      ).toBe(true);
      const replacement = await submitCampaignConsent(transactionalDb, {
        teamId,
        actorId: "synthetic-owner",
        evidence: { ...evidence, listReference: "synthetic-replacement-list" },
      });
      expect((await latestCampaignConsent(transactionalDb, teamId))?.id).toBe(replacement.id);
      expect(
        await checkCampaignConsent(transactionalDb, { teamId, operation: "import" }),
      ).toMatchObject({ allowed: false, reason: "campaign_consent_required" });
      await expect(
        reviewCampaignConsent(transactionalDb, {
          teamId,
          dossierId: priorId,
          operatorId: "synthetic-independent-operator",
          decision: "revoked",
          reason: "A stale review cannot affect the new dossier",
        }),
      ).rejects.toThrow("consent_not_current");
      await reviewCampaignConsent(transactionalDb, {
        teamId,
        dossierId: replacement.id,
        operatorId: "synthetic-independent-operator",
        decision: "approved",
        reason: "New evidence separately reviewed and approved",
      });
      expect(
        (await checkCampaignConsent(transactionalDb, { teamId, operation: "import" })).allowed,
      ).toBe(true);
      const third = await submitCampaignConsent(transactionalDb, {
        teamId,
        actorId: "synthetic-owner",
        evidence: { ...evidence, listReference: "synthetic-third-list" },
      });
      expect((await latestCampaignConsent(transactionalDb, teamId))?.id).toBe(third.id);
      expect(
        (await checkCampaignConsent(transactionalDb, { teamId, operation: "import" })).allowed,
      ).toBe(false);
    });
  },
);
