import { randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchDeliverabilityHealth } from "../src/deliverability.js";
import { holdReputationRuns } from "../src/send-review.js";
import { fetchTeamStanding, teamStandingOf } from "../src/team-standing.js";

const at = new Date("2026-10-28T12:00:00.000Z");
const earlier = new Date(at.getTime() - 60000);
const later = new Date(at.getTime() + 60000);
const standing = (teamId: string, outcomeWatermark?: Date) => ({
  teamId,
  guardrail: "paused",
  guardrailMetric: "hard_bounce" as const,
  complaintRate7d: 0,
  hardBounceRate7d: 0.03,
  ...(outcomeWatermark ? { outcomeWatermark } : {}),
});
const row = {
  suspendedAt: null,
  suspensionReason: null,
  suspensionNote: null,
  sendReviewAt: earlier,
  sendReviewReason: "reputation" as const,
  broadcastsPausedByOperatorAt: null,
  dailySendCeiling: null,
};

it("all standing readers honor both watermarks rather than timestamp presence", () => {
  expect(teamStandingOf({ ...row, sendReviewClearedAt: at }).sendReview).toBeNull();
  expect(teamStandingOf({ ...row, sendReviewClearedAt: earlier }).sendReview).toBeNull();
  expect(
    teamStandingOf({ ...row, sendReviewAt: later, sendReviewClearedAt: at }).sendReview?.at,
  ).toEqual(later);
});

describe("reputation review evidence is not a seven-day amnesty", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => {
    await close?.();
  });

  it("fetchTeamStanding ignores a cleared retained timestamp and recognizes its rearm", async () => {
    const teamId = await createTeam(db, randomUUID());
    await db
      .update(schema.teams)
      .set({ sendReviewAt: earlier, sendReviewReason: "reputation", sendReviewClearedAt: at })
      .where(eq(schema.teams.id, teamId));
    expect((await fetchTeamStanding(db, teamId))?.sendReview).toBeNull();
    await db.update(schema.teams).set({ sendReviewAt: later }).where(eq(schema.teams.id, teamId));
    expect((await fetchTeamStanding(db, teamId))?.sendReview?.at).toEqual(later);
  });

  it("reviewed evidence stays cleared, but a distinct later outcome rearms immediately", async () => {
    const teamId = await createTeam(db, randomUUID());
    await db
      .update(schema.teams)
      .set({ sendReviewClearedAt: at })
      .where(eq(schema.teams.id, teamId));
    expect(await holdReputationRuns(db, [standing(teamId, earlier)], later)).toEqual([]);
    expect(await holdReputationRuns(db, [standing(teamId, later)], later)).toEqual([teamId]);
    const held = await fetchTeamStanding(db, teamId);
    expect(held?.sendReview?.at).toEqual(later);
    const release = new Date(later.getTime() + 1000);
    await db
      .update(schema.teams)
      .set({ sendReviewAt: null, sendReviewReason: null, sendReviewClearedAt: release })
      .where(eq(schema.teams.id, teamId));
    expect(
      await holdReputationRuns(db, [standing(teamId, later)], new Date(release.getTime() + 1000)),
    ).toEqual([]);
  });

  it("a hard bounce below trial quota still pauses and persists the team hold", async () => {
    const teamId = await createTeam(db, randomUUID());
    const accepted = await db
      .insert(schema.emails)
      .values(
        Array.from({ length: 20 }, () => ({
          teamId,
          from: "service@example.test",
          to: ["recipient@example.test"],
          subject: "Synthetic trial",
          createdAt: earlier,
          sentAt: earlier,
          sesMessageId: randomUUID(),
        })),
      )
      .returning({ id: schema.emails.id });
    await db
      .insert(schema.emailEvents)
      .values({
        emailId: accepted[0]!.id,
        type: "bounced",
        bounceType: "Permanent",
        snsMessageId: randomUUID(),
        occurredAt: new Date(at.getTime() - 30000),
        createdAt: new Date(at.getTime() - 30000),
      });
    const health = await fetchDeliverabilityHealth(db, teamId, { now: at });
    expect(health).toMatchObject({ sent: 20, status: "paused", bounceRate: 0.05 });
    expect(
      await holdReputationRuns(
        db,
        [
          {
            ...standing(teamId, health.rollingWindow?.outcomeWatermark ?? undefined),
            hardBounceRate7d: health.bounceRate,
          },
        ],
        at,
      ),
    ).toEqual([teamId]);
    expect((await fetchTeamStanding(db, teamId))?.sendReview?.reason).toBe("reputation");
  });

  it("missing evidence watermark is fail-closed, not a permanent release bypass", async () => {
    const teamId = await createTeam(db, randomUUID());
    await db
      .update(schema.teams)
      .set({ sendReviewClearedAt: at })
      .where(eq(schema.teams.id, teamId));
    expect(await holdReputationRuns(db, [standing(teamId)], later)).toEqual([teamId]);
    expect((await fetchTeamStanding(db, teamId))?.sendReview?.reason).toBe("reputation");
  });
});
