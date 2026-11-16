import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  fetchDeliverabilityHealth,
  nativeReputationSchemaReady,
} from "../../src/deliverability.js";
import { firstRow } from "../../src/driver-result.js";
import { getTenantReputation } from "../../src/graduated-sending.js";

const now = new Date("2026-11-16T00:00:00Z");
it("reads a real base-only database without a Native query; tenant suspension is preserved", async () => {
  const { db, close } = await createTestDb();
  try {
    const team = await createTeam(db, randomUUID());
    const other = await createTeam(db, randomUUID());
    await db.insert(schema.emails).values({
      teamId: other,
      from: "from@example.test",
      to: ["to@example.test"],
      subject: "Other",
      sesMessageId: "other",
      sentAt: now,
      createdAt: now,
    });
    expect(await nativeReputationSchemaReady(db)).toBe(false);
    expect(await fetchDeliverabilityHealth(db, team, { now })).toMatchObject({
      sent: 0,
      status: "ok",
    });
    await db
      .update(schema.teams)
      .set({ suspendedAt: now, suspensionReason: "reputation" })
      .where(eq(schema.teams.id, team));
    expect(await getTenantReputation(db, team, { clock: () => now })).toMatchObject({
      state: "suspended",
      complaintRate: null,
      bounceRate: null,
    });
    const [row] = await db.select().from(schema.teams).where(eq(schema.teams.id, team));
    expect(row?.suspendedAt).toEqual(now);
  } finally {
    await close();
  }
});
it("keeps one confirmed adverse old send paused with an unknown denominator", async () => {
  const { db, close } = await createTestDb();
  try {
    const team = await createTeam(db, randomUUID());
    const [e] = await db
      .insert(schema.emails)
      .values({
        teamId: team,
        from: "from@example.test",
        to: ["to@example.test"],
        subject: "Synthetic",
        sesMessageId: "accepted",
        createdAt: new Date("2026-11-01"),
        sentAt: new Date("2026-11-01"),
      })
      .returning();
    await db.insert(schema.emailEvents).values({
      emailId: e!.id,
      type: "complained",
      snsMessageId: "confirmed",
      occurredAt: now,
      createdAt: now,
    });
    expect(await fetchDeliverabilityHealth(db, team, { now })).toMatchObject({
      sent: 0,
      status: "paused",
      pause: { complained: 1 },
    });
    expect(await getTenantReputation(db, team, { clock: () => now })).toMatchObject({
      state: "suspended",
      complaintRate: null,
    });
  } finally {
    await close();
  }
});
it("refuses a partial installation rather than treating it as absent", async () => {
  const { db, close } = await createTestDb();
  try {
    await db.execute(sql`create table mailboxes(id uuid)`);
    const team = await createTeam(db, randomUUID());
    await expect(fetchDeliverabilityHealth(db, team, { now })).rejects.toThrow(
      "native_reputation_schema_partial",
    );
    await expect(getTenantReputation(db, team, { clock: () => now })).rejects.toThrow(
      "native_reputation_schema_partial",
    );
  } finally {
    await close();
  }
});
it("reads actual complete Native migrations and never hides read/schema errors", async () => {
  const { db, close } = await createTestDb();
  try {
    const dir = new URL("../../../db/mailbox-drizzle/", import.meta.url);
    for (const f of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort())
      for (const stmt of readFileSync(new URL(f, dir), "utf8")
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter(Boolean))
        await db.execute(sql.raw(stmt));
    expect(await nativeReputationSchemaReady(db)).toBe(true);
    const team = await createTeam(db, randomUUID());
    expect(await fetchDeliverabilityHealth(db, team, { now })).toMatchObject({
      sent: 0,
      status: "ok",
    });
    await db.execute(
      sql`alter table mailbox_outbox rename column provider_message_id to broken_provider_message_id`,
    );
    await expect(fetchDeliverabilityHealth(db, team, { now })).rejects.toThrow();
  } finally {
    await close();
  }
});
it("propagates catalog unavailability, without classifying it as absent", async () => {
  const { db, close } = await createTestDb();
  await close();
  await expect(nativeReputationSchemaReady(db)).rejects.toThrow();
});

it("retains an old unresolved legacy admission when every Native source relation is absent", async () => {
  const { db, close } = await createTestDb();
  try {
    const team = await createTeam(db, randomUUID());
    const owner = randomUUID();
    await db.insert(schema.user).values({
      id: owner,
      name: "Stock fixture",
      email: "stock-owner@example.test",
      emailVerified: true,
    });
    await db.insert(schema.teamMembers).values({ teamId: team, userId: owner, role: "owner" });
    const receipt = {
      version: 1 as const,
      region: "us-east-1" as const,
      issuedAt: new Date(now.getTime() - 100).toISOString(),
      expiresAt: new Date(now.getTime() + 4900).toISOString(),
      dailySemantics: "nominal-flow-ceiling-not-resource-guarantee" as const,
      globalDaily: 98,
      globalPerMinute: 3,
      tenantPerMinute: 3,
      judgePerMinute: 3,
      observations: {
        sesMax24HourSend: 100,
        sesSentLast24Hours: 95,
        sesUsefulNominalDaily: 98,
        sesMaxSendRate: 14,
        modelBudgetScope: "original-primary-shared-not-exclusive" as const,
      },
      buffers: {
        sesRemaining24Hours: 3,
        modelCreditUnitsAfterSafetyFloor: 1000000000,
        modelFramesBeforeLocalCommitments: 3,
        localCommitments: "parent-ledger-required" as const,
      },
      commercial: {
        judgeTokensPerMinute: 3006144,
        nominalJudgeDailyTokens: 3006144 * 1440,
        worstCaseTokensPerAdmission: 1002048,
        worstCaseCostUsd: 0.3024576,
      },
    };
    const context = {
      clock: () => now,
      capacityReceipt: receipt,
      judgeEnvelope: {
        accountKey: "commandcode-primary",
        meterId: randomUUID(),
        meterAt: receipt.issuedAt,
        meterExpiresAt: receipt.expiresAt,
        rpm: 3,
        tenantRpm: 3,
        tpm: 3006144,
        concurrency: 1,
        maxInputTokens: 1000000,
        maxOutputTokens: 2048,
        reservedCreditUnits: 302457600,
        remainingCreditUnits: 1000000000,
      },
    };
    expect(await nativeReputationSchemaReady(db)).toBe(false);
    expect((await getTenantReputation(db, team, context)).capacityAvailable).toBe(true);
    // Outside both the minute and24hour usage windows, with no source record,
    // region or transport witness. This is still an unsettled stock obligation.
    await db.insert(schema.auditLog).values({
      teamId: team,
      action: "sending.graduated_reserved",
      target: `graduated:${randomUUID()}`,
      createdAt: new Date(now.getTime() - 26 * 60 * 60 * 1000),
      data: { units: 3 },
    });
    const after = await getTenantReputation(db, team, context);
    expect(after.dailyUsed).toBe(0);
    expect(after.capacityAvailable).toBe(false);
    expect(after.state).not.toBe("suspended");
  } finally {
    await close();
  }
});

beforeEach(() => {
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "0");
  vi.stubEnv("MAILBOX_TRANSPORT_ENABLED", "0");
});
afterEach(() => vi.unstubAllEnvs());
it.each(["MAILBOX_REGISTRY_ENABLED", "MAILBOX_TRANSPORT_ENABLED"])(
  "refuses missing Native required by the actual %s opt-in",
  async (flag) => {
    const { db, close } = await createTestDb();
    try {
      const team = await createTeam(db, randomUUID());
      vi.stubEnv(flag, "1");
      await expect(nativeReputationSchemaReady(db)).rejects.toThrow(
        "native_reputation_schema_required",
      );
      await expect(fetchDeliverabilityHealth(db, team, { now })).rejects.toThrow(
        "native_reputation_schema_required",
      );
    } finally {
      await close();
    }
  },
);
it("does not clear retained MAIN mailbox identity when both opt-ins are disabled", async () => {
  const { db, close } = await createTestDb();
  try {
    const team = await createTeam(db, randomUUID());
    const source = randomUUID();
    await db.execute(sql`insert into sending_judge_attempts
      (account_key,attempt_id,team_id,message_kind,message_id,mailbox_outbox_id,fingerprint,reserved_tokens,reserved_units)
      values('fixture-native-history',${randomUUID()}::uuid,${team}::uuid,'mailbox',${source}::uuid,${source}::uuid,${"1".repeat(64)},1002048,302457600)`);
    await expect(nativeReputationSchemaReady(db)).rejects.toThrow(
      "native_reputation_history_unavailable",
    );
    await expect(fetchDeliverabilityHealth(db, team, { now })).rejects.toThrow(
      "native_reputation_history_unavailable",
    );
    const result = await db.execute(
      sql`select state from sending_judge_attempts where account_key='fixture-native-history'`,
    );
    expect(firstRow<{ state: string }>(result)?.state).toBe("pending");
  } finally {
    await close();
  }
});
it("retains legacy MAIN activity as participation without a live private source", async () => {
  const { db, close } = await createTestDb();
  try {
    const team = await createTeam(db, randomUUID());
    await db
      .insert(schema.auditLog)
      .values({ teamId: team, action: "mailbox.send_approved", target: randomUUID() });
    await expect(fetchDeliverabilityHealth(db, team, { now })).rejects.toThrow(
      "native_reputation_history_unavailable",
    );
  } finally {
    await close();
  }
});
it("does not treat a retained optional migration tracker as a never-installed feature", async () => {
  const { db, close } = await createTestDb();
  try {
    await db.execute(sql`create table public.__mailbox_migrations(id int)`);
    await expect(nativeReputationSchemaReady(db)).rejects.toThrow(
      "native_reputation_history_unavailable",
    );
  } finally {
    await close();
  }
});
it("does not omit surviving private relations outside the four reputation tables", async () => {
  const { db, close } = await createTestDb();
  try {
    await db.execute(sql`create table mailbox_subscriptions(id int)`);
    await expect(nativeReputationSchemaReady(db)).rejects.toThrow(
      "native_reputation_history_unavailable",
    );
  } finally {
    await close();
  }
});
