import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { evaluateRegionBreakers, planTenantFirstRegionBreakers } from "../src/platform-breaker.js";
import { utcDay } from "../src/utc-day.js";

/**
 * Tenant before region: one tenant's bad day must not park every customer in
 * us-east-1. These cases pin the order — the team behind the events is paused
 * first, and the region is only held when the traffic that would remain is
 * still over the line.
 */
let db: Db;
let close: () => Promise<void>;

const NOW = new Date("2026-09-03T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

async function domainIn(teamId: string, name: string, region: string): Promise<string> {
  const [row] = await db
    .insert(schema.domains)
    .values({ teamId, name, region, status: "verified" })
    .returning({ id: schema.domains.id });
  if (!row) throw new Error("seed failed");
  return row.id;
}

async function bumpCounters(
  teamId: string,
  day: string,
  counts: { sent?: number; hardBounced?: number; complained?: number },
): Promise<void> {
  const c = schema.usageCounters;
  await db.insert(c).values({ teamId, day, sent: 0, hardBounced: 0, complained: 0, ...counts });
}

/** `sent` emails on the domain; the first `events` rows carry one SES event each. */
async function seedTraffic(
  teamId: string,
  domainId: string,
  sent: number,
  events: { type: "complained" | "bounced"; bounceType?: string; n: number }[],
  sentAt = hoursAgo(6),
): Promise<void> {
  const rows = await db
    .insert(schema.emails)
    .values(
      Array.from({ length: sent }, (_, i) => ({
        teamId,
        domainId,
        from: "f@a.com",
        to: [`r${i}@b.com`],
        subject: "s",
        sentAt,
      })),
    )
    .returning({ id: schema.emails.id });
  let cursor = 0;
  for (const spec of events) {
    for (let i = 0; i < spec.n; i++) {
      const email = rows[cursor++];
      if (!email) throw new Error("more events than emails");
      await db.insert(schema.emailEvents).values({
        emailId: email.id,
        type: spec.type,
        occurredAt: sentAt,
        createdAt: sentAt,
        snsMessageId: `sns-${email.id}`,
        bounceType: spec.type === "bounced" ? (spec.bounceType ?? null) : null,
        data: spec.type === "bounced" ? { bounce: { bounceType: spec.bounceType } } : {},
      });
    }
  }
  const n = (pred: (e: (typeof events)[number]) => boolean) =>
    events.filter(pred).reduce((sum, e) => sum + e.n, 0);
  await bumpCounters(teamId, utcDay(sentAt), {
    sent,
    hardBounced: n((e) => e.type === "bounced" && e.bounceType === "Permanent"),
    complained: n((e) => e.type === "complained"),
  });
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
// Every case judges the region it seeds, so traffic never leaks across cases.
beforeEach(async () => {
  await db.delete(schema.emailEvents);
  await db.delete(schema.emails);
  await db.delete(schema.usageCounters);
});
afterAll(() => close());

it("pausa o time que reclamou e deixa a regiao liberada", async () => {
  const team = await createTeam(db, "tenant-first-solo");
  const dom = await domainIn(team, "solo.dev", "us-east-1");
  // 400 envios, 1 reclamacao: a regiao inteira triparia no breaker antigo.
  await seedTraffic(team, dom, 400, [{ type: "complained", n: 1 }]);

  const decisions = await evaluateRegionBreakers(db, { now: NOW });
  expect(decisions.find((d) => d.region === "us-east-1")?.trip).toBe(true);

  const plan = await planTenantFirstRegionBreakers(db, decisions, { now: NOW });
  expect(plan.tenantPauses).toHaveLength(1);
  expect(plan.tenantPauses[0]).toMatchObject({
    teamId: team,
    region: "us-east-1",
    metric: "complaint",
    events: 1,
    sent: 400,
    windowHours: 24,
  });
  // The decision to persist clears the region: the pause belongs to the team.
  expect(plan.decisions.find((d) => d.region === "us-east-1")?.trip).toBe(false);
  expect(plan.regionHoldsDeferred).toEqual(["us-east-1"]);
  expect(plan.regionHolds).toEqual([]);
});

it("pausa todos os times atribuiveis antes de considerar a regiao", async () => {
  const a = await createTeam(db, "tenant-first-a");
  const b = await createTeam(db, "tenant-first-b");
  const da = await domainIn(a, "tf-a.dev", "eu-west-1");
  const dbb = await domainIn(b, "tf-b.dev", "eu-west-1");
  await seedTraffic(a, da, 300, [{ type: "complained", n: 1 }]);
  await seedTraffic(b, dbb, 300, [{ type: "complained", n: 1 }]);

  const decisions = await evaluateRegionBreakers(db, { now: NOW });
  const plan = await planTenantFirstRegionBreakers(db, decisions, { now: NOW });
  expect(plan.tenantPauses.map((p) => p.teamId).sort()).toEqual([a, b].sort());
  expect(plan.regionHoldsDeferred).toContain("eu-west-1");
  expect(plan.decisions.find((d) => d.region === "eu-west-1")?.trip).toBe(false);
});

it("mantem a regiao quando a taxa que restaria continua acima da linha", async () => {
  // Seis times com 2,5% de bounce duro cada; o plano so consegue nomear cinco
  // contribuintes, entao o sexto mantem a regiao acima do limite.
  const teams: { id: string; dom: string }[] = [];
  for (let i = 0; i < 6; i++) {
    const id = await createTeam(db, `tenant-first-six-${i}`);
    const dom = await domainIn(id, `six-${i}.dev`, "ap-south-1");
    await seedTraffic(id, dom, 400, [{ type: "bounced", bounceType: "Permanent", n: 10 }]);
    teams.push({ id, dom });
  }
  const decisions = await evaluateRegionBreakers(db, { now: NOW });
  const trip = decisions.find((d) => d.region === "ap-south-1");
  expect(trip?.trip).toBe(true);
  expect(trip?.reason?.metric).toBe("bounce");

  const plan = await planTenantFirstRegionBreakers(db, decisions, { now: NOW });
  expect(plan.tenantPauses).toHaveLength(5);
  expect(plan.regionHolds).toContain("ap-south-1");
  expect(plan.regionHoldsDeferred).not.toContain("ap-south-1");
  expect(plan.decisions.find((d) => d.region === "ap-south-1")?.trip).toBe(true);
});

it("nao pausa ninguem numa regiao limpa", async () => {
  const clean = await createTeam(db, "tenant-first-clean");
  const dom = await domainIn(clean, "clean.dev", "ca-central-1");
  await seedTraffic(clean, dom, 500, []);
  const decisions = await evaluateRegionBreakers(db, { now: NOW });
  const plan = await planTenantFirstRegionBreakers(db, decisions, { now: NOW });
  expect(plan.tenantPauses.filter((p) => p.region === "ca-central-1")).toEqual([]);
  expect(plan.decisions.find((d) => d.region === "ca-central-1")?.trip).toBe(false);
});
