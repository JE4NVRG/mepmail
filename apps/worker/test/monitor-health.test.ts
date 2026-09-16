import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runMonitorHealth } from "../src/handlers/monitor-health.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
const NOW = new Date("2026-09-15T12:00:00Z");
const sends: { to: string; kind: string; text: string }[] = [];
const mailer = {
  send: async (to: string, m: { text: string; kind: string }) => {
    sends.push({ to, kind: m.kind, text: m.text });
  },
};
const judge = { provider: "typesafe" as const, model: "jev-latest" };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db
    .insert(schema.user)
    .values({ id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) });
  teamId = await createTeam(db, "health");
});
afterAll(() => close());

async function seed(
  n: number,
  status: "judged" | "unjudged" | "pending",
  at: Date = new Date(NOW.getTime() - 60_000),
) {
  await db.insert(schema.monitorSamples).values(
    Array.from({ length: n }, () => ({
      teamId,
      kind: "tier" as const,
      status,
      score: status === "judged" ? 10 : null,
      errorClass: status === "unjudged" ? "timeout" : null,
      createdAt: at,
    })),
  );
}

it("writes nothing while the judge is off", async () => {
  await seed(5, "unjudged");
  const state = { degradedMailedAt: null };
  expect(await runMonitorHealth(db, { judge: null, mailer, state, now: NOW })).toEqual({
    samples: 0,
    unjudged: 0,
    lost: 0,
    degraded: false,
  });
  expect(await db.select().from(schema.instanceProbes)).toEqual([]);
});

it("records the hour's probes, marks lost samples, and mails the operator once per six hours when degraded", async () => {
  await seed(20, "judged");
  await seed(2, "pending", new Date(NOW.getTime() - 4 * 3600_000));
  const state = { degradedMailedAt: null as Date | null };
  const first = await runMonitorHealth(db, { judge, mailer, state, now: NOW });
  expect(first).toMatchObject({ samples: 25, unjudged: 5, lost: 2, degraded: false });
  const probes = await db
    .select()
    .from(schema.instanceProbes)
    .where(eq(schema.instanceProbes.takenAt, NOW));
  expect(probes).toMatchObject([
    { probe: "monitor_samples_1h", value: 25, ok: true },
    { probe: "monitor_unjudged_rate", value: 0.2, ok: true },
  ]);
  expect(sends).toEqual([]);

  await seed(10, "unjudged");
  const later = new Date(NOW.getTime() + 600_000);
  const second = await runMonitorHealth(db, { judge, mailer, state, now: later });
  expect(second).toMatchObject({ samples: 35, unjudged: 15, degraded: true });
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ to: "op@example.com", kind: "monitor.degraded" });
  expect(sends[0]?.text).toContain("15 of 35");
  expect(sends[0]?.text).toContain("typesafe · jev-latest");
  expect(state.degradedMailedAt).toEqual(later);
  const rate = await db
    .select()
    .from(schema.instanceProbes)
    .where(eq(schema.instanceProbes.takenAt, later));
  expect(rate.find((p) => p.probe === "monitor_unjudged_rate")).toMatchObject({ ok: false });

  // Still degraded an hour on: no second notice yet; six hours on: one more.
  const hourOn = new Date(later.getTime() + 3600_000);
  await seed(30, "unjudged", new Date(hourOn.getTime() - 60_000));
  await runMonitorHealth(db, { judge, mailer, state, now: hourOn });
  expect(sends).toHaveLength(1);
  const sixOn = new Date(later.getTime() + 6 * 3600_000);
  await seed(30, "unjudged", new Date(sixOn.getTime() - 60_000));
  await runMonitorHealth(db, { judge, mailer, state, now: sixOn });
  expect(sends).toHaveLength(2);
});
