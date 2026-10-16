import { randomBytes, randomUUID } from "node:crypto";
import {
  EnvKeyring,
  encryptEmailBody,
  holdTeamForReview,
  MONITOR_SETTING_DEFAULTS,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createOpenAiJudge } from "../src/abuse-judge/openai.js";
import { JUDGE_THROTTLE_RETRIES, judgeSample } from "../src/handlers/abuse-judge.js";

let db: Db;
let close: () => Promise<void>;
const NOW = new Date("2026-10-16T12:00:00Z");
const EARLIER = new Date(NOW.getTime() - 3600_000);
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

async function seed(held: boolean) {
  const teamId = await createTeam(db, `upstream-${randomUUID()}`);
  await db
    .update(schema.teams)
    .set({
      plan: "pro",
      planStatus: "active",
      stripeSubscriptionId: `sub_fixture_${randomUUID()}`,
      createdAt: EARLIER,
    })
    .where(eq(schema.teams.id, teamId));
  // A high historical risk must not turn an infrastructure error into another
  // vote or a new pause. The judged history belongs to an earlier decision.
  await db.insert(schema.teamMonitor).values({
    teamId,
    sentTotal: 3,
    firstSendAt: EARLIER,
    risk: 0.99,
    riskNum: 0.99,
    riskDen: 1,
    riskUpdatedAt: EARLIER,
  });
  await db.insert(schema.monitorSamples).values({
    teamId,
    kind: "first_sends",
    status: "judged",
    score: 99,
    verdict: "abuse",
    categories: ["phishing"],
    reasons: ["credential_ask"],
    judgedAt: EARLIER,
    createdAt: EARLIER,
  });
  if (held) {
    await holdTeamForReview(db, {
      teamId,
      reason: "content",
      note: "Existing reviewed content verdict",
      now: EARLIER,
    });
  }
  const emailId = randomUUID();
  const sealed = await encryptEmailBody(
    { html: "<p>Fixture content</p>", text: "Fixture content" },
    keyring,
    { teamId, rowId: emailId },
  );
  await db.insert(schema.emails).values({
    id: emailId,
    teamId,
    from: "Fixture <sender@example.test>",
    to: ["recipient@example.test"],
    subject: "Fixture",
    latestStatus: "sent",
    bodyCiphertext: sealed.ciphertext,
    bodyIv: sealed.iv,
    bodyWrappedDek: sealed.wrappedDek,
    bodyKeyVersion: sealed.keyVersion,
  });
  const [sample] = await db
    .insert(schema.monitorSamples)
    .values({ teamId, emailId, kind: "first_sends", createdAt: NOW })
    .returning({ id: schema.monitorSamples.id });
  if (!sample) throw new Error("Fixture sample missing");
  return { teamId, sampleId: sample.id };
}

async function protectedState(teamId: string) {
  return {
    teams: await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)),
    monitor: await db
      .select()
      .from(schema.teamMonitor)
      .where(eq(schema.teamMonitor.teamId, teamId)),
    votes: await db
      .select()
      .from(schema.monitorSamples)
      .where(eq(schema.monitorSamples.teamId, teamId))
      .orderBy(asc(schema.monitorSamples.id)),
    flags: await db.select().from(schema.teamFlags).where(eq(schema.teamFlags.teamId, teamId)),
    audit: await db.select().from(schema.auditLog).where(eq(schema.auditLog.teamId, teamId)),
  };
}

const failures = [
  ["upstream", async () => new Response("unavailable", { status: 503 })],
  [
    "upstream",
    async () => {
      throw new TypeError("fixture network failure");
    },
  ],
  [
    "timeout",
    async () => {
      throw new DOMException("fixture timeout", "TimeoutError");
    },
  ],
  ["parse_error", async () => new Response("invalid JSON")],
  ["no_credentials", async () => new Response("denied", { status: 401 })],
  ["throttled", async () => new Response("slow down", { status: 429 })],
] as const;

it.each([false, true])(
  "preserves paid team, risk, prior votes and existing hold=%s across judge failures",
  async (held) => {
    for (const [errorClass, fetcher] of failures) {
      const { teamId, sampleId } = await seed(held);
      const before = await protectedState(teamId);
      const mailer = { send: vi.fn(async () => {}) };
      const settings = vi.fn(async () => MONITOR_SETTING_DEFAULTS);
      const fetch = vi.fn(fetcher);
      const judge = createOpenAiJudge({
        model: "fixture-judge",
        baseUrl: "https://judge.example.test",
        apiKey: "fixture-only",
        fetch,
      });
      const deps = { judge, keyring, settings, mailer, now: () => NOW };
      if (errorClass === "throttled") {
        for (let attempt = 1; attempt <= JUDGE_THROTTLE_RETRIES; attempt++) {
          await expect(judgeSample(db, deps, { sampleId })).rejects.toMatchObject({
            class: "throttled",
          });
          const pending = await protectedState(teamId);
          const row = pending.votes.find((vote) => vote.id === sampleId);
          expect(row).toMatchObject({
            status: "pending",
            attempts: attempt,
            score: null,
            verdict: null,
          });
          expect({
            ...pending,
            votes: pending.votes.filter((vote) => vote.id !== sampleId),
          }).toEqual({ ...before, votes: before.votes.filter((vote) => vote.id !== sampleId) });
        }
      }
      expect(await judgeSample(db, deps, { sampleId })).toBe("unjudged");
      const after = await protectedState(teamId);
      const failed = after.votes.find((vote) => vote.id === sampleId);
      expect(failed).toMatchObject({ status: "unjudged", errorClass, score: null, verdict: null });
      expect({ ...after, votes: after.votes.filter((vote) => vote.id !== sampleId) }).toEqual({
        ...before,
        votes: before.votes.filter((vote) => vote.id !== sampleId),
      });
      expect(settings).not.toHaveBeenCalled();
      expect(mailer.send).not.toHaveBeenCalled();
      // A repeated delivery of the finished job must not call upstream again.
      const calls = fetch.mock.calls.length;
      expect(await judgeSample(db, deps, { sampleId })).toBe("skipped");
      expect(fetch).toHaveBeenCalledTimes(calls);
      expect(await protectedState(teamId)).toEqual(after);
    }
  },
);
