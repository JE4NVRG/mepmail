import {
  DAY_MS,
  latestProbes,
  PROBE_HISTORY_DAYS,
  probeHistory,
  pruneProbes,
  recordProbes,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runInstanceProbes } from "../src/handlers/instance-probes.js";

let db: Db;
let close: () => Promise<void>;

const NOW = new Date("2026-09-15T12:00:00Z");
const offCloud = { isCloud: false, eventsConfigured: false };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const teamId = await createTeam(db, "probed");
  await db.insert(schema.domains).values({
    teamId,
    name: "probed.dev",
    region: "us-east-1",
    status: "verified",
    verifiedAt: NOW,
  });
});
afterAll(() => close());

it("records the instance probes, without pg-boss and off cloud", async () => {
  const samples = await runInstanceProbes(db, { ...offCloud, now: NOW });
  const byKey = new Map(samples.map((s) => [s.probe, s]));
  expect(byKey.get("pg_latency_ms")).toMatchObject({ ok: true });
  expect(byKey.get("pg_latency_ms")?.value).toBeGreaterThanOrEqual(0);
  expect(byKey.get("worker_heartbeat")).toEqual({ probe: "worker_heartbeat", value: 1, ok: true });
  expect(byKey.get("teams_total")).toEqual({ probe: "teams_total", value: 1, ok: true });
  expect(byKey.get("domains_verified")).toEqual({ probe: "domains_verified", value: 1, ok: true });
  expect(byKey.get("queue_quota_held")).toEqual({ probe: "queue_quota_held", value: 0, ok: true });
  // No pgboss schema on a fresh database: nothing waiting, nothing failed.
  expect(byKey.get("boss_waiting")).toEqual({ probe: "boss_waiting", value: 0, ok: true });
  expect(byKey.get("boss_failed")).toEqual({ probe: "boss_failed", value: 0, ok: true });
  expect(byKey.has("kms_wrap_ms")).toBe(false);
  expect(byKey.has("stripe_last_event_s")).toBe(false);
  expect(byKey.has("ses_events_lag_s")).toBe(false);

  const rows = await db
    .select()
    .from(schema.instanceProbes)
    .where(eq(schema.instanceProbes.takenAt, NOW));
  expect(rows.map((r) => r.probe).sort()).toEqual(samples.map((s) => s.probe).sort());
  expect(rows.find((r) => r.probe === "teams_total")).toMatchObject({ value: 1, ok: true });
});

it("latestProbes returns the newest sample per probe", async () => {
  const later = new Date(NOW.getTime() + 60_000);
  await createTeam(db, "second");
  await runInstanceProbes(db, { ...offCloud, now: later });
  const latest = await latestProbes(db, later);
  expect(latest.get("teams_total")).toEqual({
    probe: "teams_total",
    value: 2,
    ok: true,
    takenAt: later,
  });
  expect(latest.get("worker_heartbeat")?.takenAt).toEqual(later);
  expect(latest.has("kms_wrap_ms")).toBe(false);
});

it("pruneProbes drops samples past the history window and keeps the rest", async () => {
  const old = new Date(NOW.getTime() - (PROBE_HISTORY_DAYS + 1) * DAY_MS);
  const recent = new Date(NOW.getTime() - DAY_MS);
  await recordProbes(db, [{ probe: "pg_size_bytes", value: 1, ok: true }], old);
  await recordProbes(db, [{ probe: "pg_size_bytes", value: 2, ok: true }], recent);
  expect(await pruneProbes(db, NOW)).toBe(1);
  const left = await db
    .select({ takenAt: schema.instanceProbes.takenAt })
    .from(schema.instanceProbes)
    .where(
      and(
        eq(schema.instanceProbes.probe, "pg_size_bytes"),
        eq(schema.instanceProbes.takenAt, recent),
      ),
    );
  expect(left).toEqual([{ takenAt: recent }]);
  expect(
    await db.select().from(schema.instanceProbes).where(eq(schema.instanceProbes.takenAt, old)),
  ).toEqual([]);
});

it("probeHistory buckets samples with the average and bool_and(ok)", async () => {
  const t0 = new Date("2026-01-01T10:00:00Z");
  const t1 = new Date("2026-01-01T10:01:00Z");
  await recordProbes(db, [{ probe: "pg_latency_ms", value: 10, ok: true }], t0);
  await recordProbes(db, [{ probe: "pg_latency_ms", value: 30, ok: false }], t1);
  const points = await probeHistory(db, {
    probe: "pg_latency_ms",
    from: t0,
    to: new Date(t0.getTime() + 3_600_000),
    bucketSeconds: 3_600,
  });
  expect(points).toEqual([{ t: t0, value: 20, ok: false }]);
});

it("ses_transactional_parked reads the worker's memory of the last park", async () => {
  const quiet = await runInstanceProbes(db, { ...offCloud, now: NOW, regions: ["us-east-1"] });
  expect(quiet.find((s) => s.probe === "ses_transactional_parked")).toEqual({
    probe: "ses_transactional_parked",
    value: null,
    ok: true,
  });
  const later = new Date(NOW.getTime() + 1);
  const parkedAt = new Date(later.getTime() - 90_000);
  const recent = await runInstanceProbes(db, {
    ...offCloud,
    now: later,
    regions: ["us-east-1", "sa-east-1"],
    txParkedAt: (region) => (region === "sa-east-1" ? parkedAt : null),
  });
  expect(recent.find((s) => s.probe === "ses_transactional_parked")).toEqual({
    probe: "ses_transactional_parked",
    value: 90,
    ok: false,
  });
  const old = await runInstanceProbes(db, {
    ...offCloud,
    now: new Date(NOW.getTime() + 2),
    regions: ["sa-east-1"],
    txParkedAt: () => new Date(NOW.getTime() - 2 * DAY_MS),
  });
  expect(old.find((s) => s.probe === "ses_transactional_parked")).toMatchObject({ ok: true });
});
