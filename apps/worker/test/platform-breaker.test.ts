import { resumeBreakerBroadcasts } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { runPlatformBreaker } from "../src/handlers/platform-breaker.js";

/**
 * A1/A2: who loses what when a region trips.
 *
 * - first party: broadcasts paused, transactional untouched, one alert;
 * - third party: full review hold, every surface stopped;
 * - first party twice in a day: treated as a third party;
 * - the breaker's pause and the operator's pause are different columns, so
 *   releasing one never releases the other.
 */
let db: Db;
let close: () => Promise<void>;
let sends: { to: string; subject: string; text: string }[];

const NOW = new Date("2026-09-03T12:00:00Z");
const SENT_AT = new Date(NOW.getTime() - 3_600_000);
const mailer = {
  send: async (to: string, m: { subject: string; text: string }) => {
    sends.push({ to, subject: m.subject, text: m.text });
  },
};

async function seedTeam(
  name: string,
  domain: string,
  region: string,
  sent: number,
  events: { type: "complained" | "bounced"; bounceType?: string; n: number },
  slug?: string,
): Promise<string> {
  const teamId = await createTeam(db, name);
  if (slug) await db.update(schema.teams).set({ slug }).where(eq(schema.teams.id, teamId));
  const [row] = await db
    .insert(schema.domains)
    .values({ teamId, name: domain, region, status: "verified" })
    .returning({ id: schema.domains.id });
  if (!row) throw new Error("seed failed");
  const rows = await db
    .insert(schema.emails)
    .values(
      Array.from({ length: sent }, (_, i) => ({
        teamId,
        domainId: row.id,
        from: `f@${domain}`,
        to: [`r${i}@b.com`],
        subject: "s",
        sentAt: SENT_AT,
      })),
    )
    .returning({ id: schema.emails.id });
  let cursor = 0;
  for (let i = 0; i < events.n; i++) {
    const email = rows[cursor++];
    if (!email) throw new Error("more events than emails");
    await db.insert(schema.emailEvents).values({
      emailId: email.id,
      type: events.type,
      occurredAt: SENT_AT,
      createdAt: SENT_AT,
      snsMessageId: `sns-${email.id}`,
      bounceType: events.type === "bounced" ? (events.bounceType ?? null) : null,
      data: events.type === "bounced" ? { bounce: { bounceType: events.bounceType } } : {},
    });
  }
  return teamId;
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db
    .insert(schema.user)
    .values([{ id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) }]);
});
beforeEach(async () => {
  vi.stubEnv("FIRST_PARTY_TEAM_SLUGS", "first-party-test,first-party-test-2");
  sends = [];
  await db.delete(schema.emailEvents);
  await db.delete(schema.emails);
  await db.delete(schema.usageCounters);
  await db.delete(schema.teamFlags);
  await db.delete(schema.teamMonitor);
  await db.delete(schema.regionBreakers);
  await db.update(schema.teams).set({
    sendReviewAt: null,
    sendReviewClearedAt: null,
    broadcastsPausedByOperatorAt: null,
  });
});
afterAll(() => {
  vi.unstubAllEnvs();
  return close();
});

it("time de terceiro com reclamacao perde todas as superficies", async () => {
  const third = await seedTeam("Third Party", "third.dev", "sa-east-1", 1000, {
    type: "complained",
    n: 5,
  });

  const result = await runPlatformBreaker(db, { mailer, now: NOW });

  expect(result.tripped).toEqual([]);
  expect(result.tenantsPaused).toEqual([third]);
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, third));
  expect(team?.sendReviewAt).not.toBeNull();
  expect(team?.sendReviewReason).toBe("reputation");
  expect(team?.broadcastsPausedByOperatorAt).toBeNull();
  // Nenhuma região foi pausada, e o operador recebeu um aviso do time, não da região.
  expect(await db.select().from(schema.regionBreakers)).toHaveLength(0);
  expect(sends).toHaveLength(0);
});

it("time first-party mantem o transacional e perde so o broadcast", async () => {
  const first = await seedTeam(
    "First Party",
    "first.dev",
    "us-east-1",
    400,
    { type: "complained", n: 1 },
    "first-party-test",
  );

  const result = await runPlatformBreaker(db, { mailer, now: NOW });

  expect(result.tenantsPaused).toEqual([first]);
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, first));
  // A151: nenhum review hold, entao /emails continua saindo.
  expect(team?.sendReviewAt).toBeNull();
  expect(team?.broadcastsPausedByOperatorAt).toBeNull();
  const [monitor] = await db
    .select()
    .from(schema.teamMonitor)
    .where(eq(schema.teamMonitor.teamId, first));
  expect(monitor?.broadcastsPausedAt).not.toBeNull();
});

it("first-party que repete em 24h continua sem perder o transacional (A155)", async () => {
  const first = await seedTeam(
    "First Party Repeat",
    "first2.dev",
    "us-east-1",
    400,
    { type: "complained", n: 1 },
    "first-party-test-2",
  );
  // Ocorrencia anterior no mesmo dia: reincidencia, nao um clique errado.
  await db.insert(schema.teamFlags).values({
    teamId: first,
    reason: "complaints",
    note: "episodio anterior",
  });
  await db
    .update(schema.teamFlags)
    .set({ openedAt: new Date(NOW.getTime() - 3_600_000) })
    .where(eq(schema.teamFlags.teamId, first));

  await runPlatformBreaker(db, { mailer, now: NOW });

  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, first));
  // A155: reincidencia first-party NAO vira review hold, nem mesmo na segunda vez.
  expect(team?.sendReviewAt).toBeNull();
  const [monitor] = await db
    .select()
    .from(schema.teamMonitor)
    .where(eq(schema.teamMonitor.teamId, first));
  expect(monitor?.broadcastsPausedAt).not.toBeNull();
});

it("soltar a pausa do breaker nao solta a pausa manual", async () => {
  const teamId = await createTeam(db, "Both Pauses");
  const manualAt = new Date(NOW.getTime() - 7_200_000);
  await db
    .update(schema.teams)
    .set({ broadcastsPausedByOperatorAt: manualAt })
    .where(eq(schema.teams.id, teamId));
  await db.insert(schema.teamMonitor).values({ teamId, broadcastsPausedAt: NOW });

  // Release do breaker: limpa so a coluna do breaker.
  await resumeBreakerBroadcasts(db, { teamId, now: NOW });

  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  const [monitor] = await db
    .select()
    .from(schema.teamMonitor)
    .where(eq(schema.teamMonitor.teamId, teamId));
  expect(monitor?.broadcastsPausedAt).toBeNull();
  expect(team?.broadcastsPausedByOperatorAt?.getTime()).toBe(manualAt.getTime());
});
