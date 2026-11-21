import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { runPlatformBreaker } from "../src/handlers/platform-breaker.js";

/**
 * Tenant before region. A team's bad day pauses that team; the region is only
 * held when the traffic that would remain is still over the line.
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
): Promise<string> {
  const teamId = await createTeam(db, name);
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
  sends = [];
  await db.delete(schema.emailEvents);
  await db.delete(schema.emails);
  await db.delete(schema.usageCounters);
  await db.delete(schema.teamFlags);
  await db.delete(schema.regionBreakers);
  await db
    .update(schema.teams)
    .set({ sendReviewAt: null, sendReviewClearedAt: null, broadcastsPausedByOperatorAt: null });
});
afterAll(() => close());

it("pausa o time reclamado e deixa a regiao liberada", async () => {
  const noisy = await seedTeam("Noisy Sender", "noisy.dev", "sa-east-1", 1000, {
    type: "complained",
    n: 5,
  });

  const result = await runPlatformBreaker(db, {
    mailer,
    appBaseUrl: "https://app.example.test",
    now: NOW,
  });

  expect(result.tripped).toEqual([]);
  expect(result.tenantsPaused).toEqual([noisy]);
  // A151: the tenant loses broadcasts, not transactional mail. The appreciation
  // hold stays untouched, so a password reset from that team still leaves.
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, noisy));
  expect(team?.broadcastsPausedByOperatorAt).not.toBeNull();
  expect(team?.sendReviewAt).toBeNull();
  const flags = await db.select().from(schema.teamFlags).where(eq(schema.teamFlags.teamId, noisy));
  expect(flags.map((f) => f.reason)).toEqual(["complaints"]);
  const audit = await db
    .select({ action: schema.auditLog.action })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.teamId, noisy));
  expect(audit.map((a) => a.action)).toContain("team.broadcasts_paused_reputation");
  // No region hold, so no region mail to the operator.
  expect(await db.select().from(schema.regionBreakers)).toHaveLength(0);
  expect(sends).toHaveLength(0);

  // Same state twice: the second run pauses nothing new and mails nobody.
  const again = await runPlatformBreaker(db, { mailer, now: NOW });
  expect(again.tenantsPaused).toEqual([]);
  expect(sends).toHaveLength(0);
});

it("ainda segura a regiao quando a taxa sem os times pausados continua acima da linha", async () => {
  const teams: string[] = [];
  for (let i = 0; i < 6; i++) {
    teams.push(
      await seedTeam(`Bouncer ${i}`, `bouncer-${i}.dev`, "ap-south-1", 400, {
        type: "bounced",
        bounceType: "Permanent",
        n: 10,
      }),
    );
  }

  const result = await runPlatformBreaker(db, {
    mailer,
    appBaseUrl: "https://app.example.test",
    now: NOW,
  });

  expect(result.tripped).toEqual(["ap-south-1"]);
  expect(result.tenantsPaused).toHaveLength(5);
  const [region] = await db.select().from(schema.regionBreakers);
  expect(region).toMatchObject({ region: "ap-south-1", paused: true });
  expect(sends).toHaveLength(1);
  expect(sends[0]?.subject).toContain("paused in ap-south-1");
});
