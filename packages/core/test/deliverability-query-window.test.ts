import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchDeliverabilityHealth } from "../src/deliverability.js";
import { firstRow } from "../src/driver-result.js";

const now = new Date("2026-10-28T00:01:00Z");
const at = (hours: number) => new Date(now.getTime() - hours * 3600000);
// Frozen pre-optimization query: independent semantic and plan reference.
function legacyQuery(teamId: string) {
  const e = schema.emails;
  const v = schema.emailEvents;
  const start = at(24);
  return sql`
    with confirmed as (
      select ${e.id} as id,
        coalesce((
          select min(${v.occurredAt}) from ${v}
          where ${v.emailId} = ${e.id} and ${v.type} = 'sent'
            and ${v.createdAt} <= ${now} and ${v.occurredAt} <= ${now}
        ), ${e.sentAt}, (
          select min(${v.occurredAt}) from ${v}
          where ${v.emailId} = ${e.id} and (${v.type} = 'sent' or ${v.snsMessageId} is not null)
            and ${v.type} in ('sent', 'delivered', 'bounced', 'complained', 'delivery_delayed')
            and ${v.createdAt} <= ${now} and ${v.occurredAt} <= ${now}
        )) as accepted_at
      from ${e}
      where ${e.teamId} = ${teamId} and ${e.createdAt} <= ${now}
        and (${e.sesMessageId} is not null or exists (
          select 1 from ${v} where ${v.emailId} = ${e.id}
            and (${v.type} = 'sent' or ${v.snsMessageId} is not null)
            and ${v.type} in ('sent', 'delivered', 'bounced', 'complained', 'delivery_delayed')
            and ${v.createdAt} <= ${now} and ${v.occurredAt} <= ${now}
        ))
    ), outcomes as (
      select ${v.emailId} as email_id,
        bool_or(${v.type} = 'bounced' and ${v.bounceType} = 'Permanent') as hard,
        bool_or(${v.type} = 'complained') as complaint,
        greatest(
          min(${v.createdAt}) filter (where ${v.type} = 'bounced' and ${v.bounceType} = 'Permanent'),
          min(${v.createdAt}) filter (where ${v.type} = 'complained')
        ) as arrived_at
      from ${v} inner join confirmed c on c.id = ${v.emailId}
      where ${v.occurredAt} > ${start} and ${v.occurredAt} <= ${now}
        and ${v.createdAt} <= ${now}
        and ((${v.type} = 'bounced' and ${v.bounceType} = 'Permanent') or ${v.type} = 'complained')
      group by ${v.emailId}
    )
    select count(*) filter (where c.accepted_at > ${start} and c.accepted_at <= ${now})::text as sent,
      count(*) filter (where o.hard)::text as "hardBounced",
      count(*) filter (where o.complaint)::text as complained,
      max(o.arrived_at) as watermark
    from confirmed c left join outcomes o on o.email_id = c.id
  `;
}

type Plan = {
  "Node Type": string;
  "Subplan Name"?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Relation Name"?: string;
  "Index Cond"?: string;
  "Recheck Cond"?: string;
  Plans?: Plan[];
};
function nodes(plan: Plan): Plan[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

describe("window-bounded deliverability query", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => {
    await close?.();
  });
  async function emails(teamId: string, n: number, sentAt: Date | null = at(12), proof = true) {
    const rows: { id: string }[] = [];
    for (let offset = 0; offset < n; offset += 500) {
      rows.push(
        ...(await db
          .insert(schema.emails)
          .values(
            Array.from({ length: Math.min(500, n - offset) }, () => ({
              teamId,
              from: "fixture@example.test",
              to: ["a@example.test", "b@example.test"],
              cc: ["c@example.test"],
              bcc: ["d@example.test"],
              subject: "Synthetic query window",
              createdAt: at(240),
              sentAt,
              sesMessageId: proof ? randomUUID() : null,
            })),
          )
          .returning({ id: schema.emails.id })),
      );
    }
    return rows;
  }
  async function event(
    emailId: string,
    type: typeof schema.emailEvents.$inferInsert.type,
    options: {
      occurredAt?: Date;
      createdAt?: Date;
      snsMessageId?: string | null;
      bounceType?: string;
    } = {},
  ) {
    await db.insert(schema.emailEvents).values({
      emailId,
      type,
      occurredAt: options.occurredAt ?? at(1),
      createdAt: options.createdAt ?? at(0.5),
      snsMessageId: options.snsMessageId === undefined ? randomUUID() : options.snsMessageId,
      bounceType: options.bounceType ?? null,
    });
  }
  async function compare(teamId: string) {
    const health = await fetchDeliverabilityHealth(db, teamId, { now });
    const reference = firstRow<{
      sent: string;
      hardBounced: string;
      complained: string;
      watermark: Date | string | null;
    }>(await db.execute(legacyQuery(teamId)));
    expect(health.pause).toEqual({
      sent: Number(reference?.sent),
      hardBounced: Number(reference?.hardBounced),
      complained: Number(reference?.complained),
      windowDays: 1,
    });
    expect(health.rollingWindow?.outcomeWatermark).toEqual(
      reference?.watermark ? new Date(reference.watermark) : null,
    );
    return health;
  }
  it("preserves canonical acceptance, both time bounds, tenant isolation and first-arrival dedup", async () => {
    const team = await createTeam(db, `candidate-${randomUUID()}`);
    await emails(team, 100);
    const [old] = await emails(team, 1, at(90));
    const [claim] = await emails(team, 1, at(2), false);
    const [sentOverride] = await emails(team, 1, at(90), false);
    const [olderSent] = await emails(team, 1, at(2));
    const [fallback] = await emails(team, 1, null, false);
    const [oldFallback] = await emails(team, 1, null, false);
    const [future] = await emails(team, 1, at(-1));
    const [lower] = await emails(team, 1, at(24));
    const [upper] = await emails(team, 1, now);
    const [futureArrival] = await emails(team, 1, at(2), false);
    if (
      !old ||
      !claim ||
      !sentOverride ||
      !olderSent ||
      !fallback ||
      !oldFallback ||
      !future ||
      !lower ||
      !upper ||
      !futureArrival
    )
      throw new Error("Missing fixtures");
    await event(old.id, "complained", { createdAt: at(0.75) });
    await event(old.id, "complained", { createdAt: at(0.25) });
    await event(old.id, "bounced", { bounceType: "Permanent", createdAt: at(0.5) });
    await event(old.id, "bounced", { bounceType: "Permanent", createdAt: at(0.1) });
    await event(claim.id, "bounced", { bounceType: "Permanent", snsMessageId: null });
    await event(sentOverride.id, "sent", { occurredAt: at(3), snsMessageId: null });
    await event(olderSent.id, "sent", { occurredAt: at(30), snsMessageId: null });
    await event(fallback.id, "delivered", { occurredAt: at(4) });
    await event(oldFallback.id, "delivered", { occurredAt: at(48) });
    await event(oldFallback.id, "delivery_delayed", { occurredAt: at(2) });
    await event(futureArrival.id, "sent", { createdAt: at(-1) });
    await event(lower.id, "complained", { occurredAt: at(24) });
    await event(upper.id, "bounced", { bounceType: "Transient", occurredAt: now });
    await event(upper.id, "bounced", { bounceType: "Undetermined" });
    await event(upper.id, "complained", { occurredAt: at(-1) });
    const other = await createTeam(db, `foreign-${randomUUID()}`);
    const [foreign] = await emails(other, 1);
    if (!foreign) throw new Error("Missing foreign fixture");
    await event(foreign.id, "complained", { createdAt: now });
    const health = await compare(team);
    expect(health).toMatchObject({
      sent: 103,
      pause: { hardBounced: 1, complained: 1 },
      rollingWindow: { outcomeWatermark: at(0.5) },
    });
    // A third SNS ID changes neither distinct counts nor the watermark.
    await event(old.id, "complained", { createdAt: now });
    expect(await compare(team)).toEqual(health);
  });
  it("keeps rates above one for old outcomes, and zero-safe without current sends", async () => {
    const team = await createTeam(db, `unclamped-${randomUUID()}`);
    await emails(team, 1);
    const old = await emails(team, 3, at(90));
    await db.insert(schema.emailEvents).values(
      old.map(({ id }) => ({
        emailId: id,
        type: "bounced" as const,
        bounceType: "Permanent",
        snsMessageId: randomUUID(),
        occurredAt: at(1),
        createdAt: now,
      })),
    );
    expect(await compare(team)).toMatchObject({
      sent: 1,
      bounceRate: 3,
      pause: { hardBounced: 3 },
    });
    const empty = await createTeam(db, `zero-${randomUUID()}`);
    const [oldOnly] = await emails(empty, 1, at(90));
    if (!oldOnly) throw new Error("Missing old-only fixture");
    await event(oldOnly.id, "complained");
    expect(await compare(empty)).toMatchObject({
      sent: 0,
      complaintRate: 0,
      bounceRate: 0,
      pause: { complained: 1 },
    });
  });
  it("EXPLAIN bounds confirmation to candidates as history grows, with identical results", async () => {
    // Index contract is exercised only inside the disposable in-memory fixture.
    await db.execute(
      sql`create index if not exists emails_team_sent_window_idx on emails (team_id, sent_at) where sent_at is not null`,
    );
    await db.execute(
      sql`create index if not exists email_events_reputation_window_idx on email_events (occurred_at, email_id) where type in ('sent', 'delivered', 'bounced', 'complained', 'delivery_delayed')`,
    );
    const team = await createTeam(db, `explain-${randomUUID()}`);
    await emails(team, 100);
    async function seedHistory(n: number) {
      const history = await emails(team, n, at(90), false);
      for (let offset = 0; offset < history.length; offset += 500) {
        await db.insert(schema.emailEvents).values(
          history.slice(offset, offset + 500).map(({ id }) => ({
            emailId: id,
            type: "sent" as const,
            occurredAt: at(90),
            createdAt: at(80),
          })),
        );
      }
      return history;
    }
    const history = await seedHistory(500);
    const oldId = history[0]?.id;
    if (!oldId) throw new Error("Missing historic fixture");
    await event(oldId, "complained");
    async function explain(query: SQL) {
      const row = firstRow<{ "QUERY PLAN": { Plan: Plan; "Execution Time": number }[] }>(
        await db.execute(sql`explain (analyze, buffers, format json) ${query}`),
      );
      if (!row) throw new Error("Missing EXPLAIN result");
      return row["QUERY PLAN"][0];
    }
    const measurements = [];
    for (const totalHistory of [500, 5000]) {
      if (totalHistory === 5000) await seedHistory(4500);
      await db.execute(sql`analyze emails`);
      await db.execute(sql`analyze email_events`);
      let captured: SQL | undefined;
      const traced = {
        execute: async (query: SQL) => {
          captured = query;
          return db.execute(query);
        },
      } as unknown as Db;
      await fetchDeliverabilityHealth(traced, team, { now });
      if (!captured) throw new Error("Health SQL was not captured");
      await compare(team);
      const optimized = await explain(captured);
      const legacy = await explain(legacyQuery(team));
      if (!optimized || !legacy) throw new Error("Missing plans");
      const optimizedConfirmed = nodes(optimized.Plan).find(
        (node) => node["Subplan Name"] === "CTE confirmed",
      );
      const legacyConfirmed = nodes(legacy.Plan).find(
        (node) => node["Subplan Name"] === "CTE confirmed",
      );
      expect(optimizedConfirmed?.["Actual Rows"]).toBe(101);
      expect(legacyConfirmed?.["Actual Rows"]).toBe(totalHistory + 100);
      for (const node of nodes(optimized.Plan)) {
        if (node["Actual Loops"] === 0) continue;
        if (node["Relation Name"] === "emails") {
          expect(node["Actual Rows"] * node["Actual Loops"]).toBeLessThanOrEqual(101);
        }
        if (node["Relation Name"] === "email_events") {
          expect(node["Index Cond"] ?? node["Recheck Cond"]).toMatch(/email_id =|occurred_at >/);
        }
      }
      measurements.push({ totalHistory, optimized, legacy });
    }
    // Evidence, not a fragile wall-clock speed assertion or production promise.
    console.info("DELIVERABILITY_WINDOW_EXPLAIN", JSON.stringify(measurements));
  }, 60000);
});
