import { randomUUID } from "node:crypto";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { drainQuotaParked } from "../src/handlers/cron.js";

let fixture: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  fixture = await createTestDb();
});
afterAll(async () => {
  await fixture?.close();
});
it.each([null, 10000])(
  "legacy parked rows use probation inside re-reservation even with raw ceiling %s",
  async (dailySendCeiling) => {
    const { db } = fixture;
    const teamId = await createTeam(db, randomUUID());
    await db.update(schema.teams).set({ dailySendCeiling }).where(eq(schema.teams.id, teamId));
    const [ambiguous] = await db
      .insert(schema.emails)
      .values({
        teamId,
        from: "sender@example.test",
        to: ["recipient@example.test"],
        subject: "Ambiguous claim",
        latestStatus: "queued_quota",
        sentAt: new Date(),
      })
      .returning();
    const rows = await db
      .insert(schema.emails)
      .values(
        Array.from({ length: 30 }, (_, i) => ({
          teamId,
          from: "sender@example.test",
          to: [`recipient${i}@example.test`],
          subject: `Legacy ${i}`,
          latestStatus: "queued_quota" as const,
        })),
      )
      .returning();
    const queued: string[] = [];
    const result = await drainQuotaParked(db, {
      isCloud: true,
      enqueueSends: async (batch) => {
        queued.push(...batch.map((job) => job.emailId));
      },
    });
    expect(result.drained).toBe(25);
    const state = await db.select().from(schema.emails).where(eq(schema.emails.teamId, teamId));
    expect(state.filter((row) => row.latestStatus === "queued")).toHaveLength(25);
    expect(state.filter((row) => row.latestStatus === "queued_quota")).toHaveLength(6);
    expect(queued).toHaveLength(25);
    expect(new Set(queued).size).toBe(25);
    expect(queued.every((id) => rows.some((row) => row.id === id))).toBe(true);
    expect(queued).not.toContain(ambiguous?.id);
    expect(state.find((row) => row.id === ambiguous?.id)?.sentAt).toEqual(ambiguous?.sentAt);
    const usage = await db
      .select()
      .from(schema.usageCounters)
      .where(eq(schema.usageCounters.teamId, teamId));
    expect(usage).toHaveLength(1);
    expect(usage[0]?.accepted).toBe(25);
    const again = await drainQuotaParked(db, {
      isCloud: true,
      enqueueSends: async (batch) => {
        queued.push(...batch.map((job) => job.emailId));
      },
    });
    expect(again.drained).toBe(0);
    expect(queued).toHaveLength(25);
    expect(
      (
        await db.select().from(schema.usageCounters).where(eq(schema.usageCounters.teamId, teamId))
      )[0]?.accepted,
    ).toBe(25);
  },
);
