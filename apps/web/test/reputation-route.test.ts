import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { reputationRouter } from "../src/server/routers/reputation";
import { createCallerFactory, router } from "../src/server/trpc";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));
vi.mock("@/server/auth", () => ({
  getAuth: () => {
    throw new Error("no auth initialization");
  },
}));
vi.mock("@/server/queue", () => ({ getQueue: async () => ({}) }));
vi.mock("@millionsend/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@millionsend/core")>()),
  getGraduatedSendingContext: async () => {
    const now = Date.now(),
      issued = new Date(now - 100).toISOString(),
      expires = new Date(now + 4900).toISOString();
    const balance = 302457600 * 10000;
    const receipt = {
      version: 1 as const,
      region: "us-east-1" as const,
      issuedAt: issued,
      expiresAt: expires,
      dailySemantics: "nominal-flow-ceiling-not-resource-guarantee" as const,
      globalDaily: 4320,
      globalPerMinute: 3,
      tenantPerMinute: 3,
      judgePerMinute: 3,
      observations: {
        sesMax24HourSend: 54900,
        sesSentLast24Hours: 0,
        sesUsefulNominalDaily: 53802,
        sesMaxSendRate: 14,
        modelBudgetScope: "original-primary-shared-not-exclusive" as const,
      },
      buffers: {
        sesRemaining24Hours: 53802,
        modelCreditUnitsAfterSafetyFloor: balance,
        modelFramesBeforeLocalCommitments: 10000,
        localCommitments: "parent-ledger-required" as const,
      },
      commercial: {
        judgeTokensPerMinute: 3006144,
        nominalJudgeDailyTokens: 3006144 * 1440,
        worstCaseTokensPerAdmission: 1002048,
        worstCaseCostUsd: 0.3024576,
      },
    } satisfies import("../../../packages/core/src/runtime-capacity-observation").RuntimeCapacityReceipt;
    return Object.freeze({
      clock: () => new Date(now),
      capacityReceipt: receipt,
      regionalCapacity: { "us-east-1": receipt, "eu-west-1": null },
      judgeEnvelope: Object.freeze({
        accountKey: "fixture",
        meterId: randomUUID(),
        meterAt: issued,
        meterExpiresAt: expires,
        rpm: 3,
        tenantRpm: 3,
        tpm: 3006144,
        concurrency: 1,
        maxInputTokens: 1000000,
        maxOutputTokens: 2048,
        reservedCreditUnits: 302457600,
        remainingCreditUnits: balance,
      }),
    });
  },
}));
const caller = createCallerFactory(router({ reputation: reputationRouter }));
describe("explicit owned-domain reputation with composed getter and PGlite SQL", () => {
  it("anonymous 403 / cross-team domain 403 / own mature / own fresh", async () => {
    const { db, close } = await createTestDb();
    try {
      // test-utils owns the real main DDL; this getter now also reads only
      // metadata from Native, so apply its actual additive migration history.
      const nativeDdl = fileURLToPath(
        new URL("../../../packages/db/mailbox-drizzle/", import.meta.url),
      );
      for (const name of readdirSync(nativeDdl)
        .filter((n) => n.endsWith(".sql"))
        .sort())
        await db.transaction(async (tx) => {
          for (const statement of readFileSync(nativeDdl + name, "utf8")
            .split("--> statement-breakpoint")
            .filter((part) => part.trim()))
            await tx.execute(sql.raw(statement));
        });
      const a = await createTeam(db, "Reputation A");
      const b = await createTeam(db, "Reputation B");
      await db.insert(schema.user).values({
        id: "rep-owner",
        name: "Fixture",
        email: "reputation@example.test",
        emailVerified: true,
      });
      await db.insert(schema.teamMembers).values({ teamId: a, userId: "rep-owner", role: "owner" });
      const mature = randomUUID(),
        fresh = randomUUID(),
        foreign = randomUUID();
      const now = new Date(),
        anchor = new Date(now.getTime() - 45 * 86400000);
      const domain = (id: string, teamId: string, name: string, verifiedAt: Date) => ({
        id,
        teamId,
        name,
        status: "verified" as const,
        region: "us-east-1",
        verifiedAt,
        lastCheckedAt: now,
        dmarcCheckedAt: now,
        dkimSelector: "test",
        mailFromSubdomain: "send",
        dmarcPolicy: "none" as const,
        dnsRecords: [
          {
            group: "verification" as const,
            name: "test._domainkey." + name,
            type: "TXT",
            status: "found" as const,
          },
          {
            group: "sending" as const,
            name: "send." + name,
            type: "TXT",
            status: "found" as const,
          },
          { group: "sending" as const, name: "send." + name, type: "MX", status: "found" as const },
          {
            group: "dmarc" as const,
            name: "_dmarc." + name,
            type: "TXT",
            status: "found" as const,
          },
        ],
      });
      await db
        .insert(schema.domains)
        .values([
          domain(mature, a, "mature.invalid", anchor),
          domain(fresh, a, "fresh.invalid", now),
          domain(foreign, b, "foreign.invalid", anchor),
        ]);
      for (let n = 0; n < 22; n++) {
        const id = randomUUID(),
          at = new Date(now.getTime() - (n * 24 + 1) * 3600000);
        await db.insert(schema.emails).values({
          id,
          teamId: a,
          domainId: mature,
          from: "owner@mature.invalid",
          to: ["fixture@example.test"],
          subject: "Synthetic",
          createdAt: at,
          sentAt: at,
          sesMessageId: "fixture-" + id,
        });
        await db.insert(schema.auditLog).values({
          teamId: a,
          action: "sending.graduated_reserved",
          target: "graduated:" + id,
          createdAt: at,
          data: { units: 1 },
        });
      }
      const session = {
        user: { id: "rep-owner", name: "Fixture", email: "reputation@example.test" },
      };
      await expect(
        caller({ db, teamId: a, role: "owner", session: null }).reputation.get({
          domainId: mature,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        caller({ db, teamId: a, role: "owner", session }).reputation.get({ domainId: foreign }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        caller({ db, teamId: b, role: "owner", session }).reputation.get({ domainId: foreign }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const own = caller({ db, teamId: a, role: "owner", session });
      const m = await own.reputation.get({ domainId: mature });
      expect(m.state).toBe("established");
      expect(m.warmupPercent).toBe(100);
      expect(m.campaignEligible).toBe(true);
      expect(m.capacityKnown).toBe(true);
      const f = await own.reputation.get({ domainId: fresh });
      expect(f.state).toBe("domain_verified");
      expect(f.warmupPercent).toBe(25);
      expect(f.campaignEligible).toBe(false);
      const principal = await own.reputation.get({ domainId: null });
      expect(principal.state).toBe("verified");
      expect(Object.keys(m).sort()).toEqual(
        [
          "state",
          "plan",
          "nominalMonthly",
          "effectiveDaily",
          "effectivePerMinute",
          "dailyUsed",
          "dailyLeft",
          "newRecipientWindows",
          "complaintRate",
          "bounceRate",
          "reputationDenominator24h",
          "warmupPercent",
          "nextEligibleAt",
          "nextDaily",
          "campaignEligible",
          "capacityKnown",
          "capacityAvailable",
          "reason",
          "nextStep",
        ].sort(),
      );
      expect(m).not.toHaveProperty("domainId");
      expect(m).not.toHaveProperty("teamId");
      expect(JSON.stringify(m)).not.toContain("reputation@example.test");
    } finally {
      await close();
    }
  });
});
