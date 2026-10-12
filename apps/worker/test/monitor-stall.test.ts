import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runMonitorHealth } from "../src/handlers/monitor-health.js";

// A quiet instance draws a handful of samples a day: far below the hourly share's 20,
// so a judge whose key or credits ran out went unnoticed for days (10-10 to 10-12).
let db: Db;
let close: () => Promise<void>;
let teamId: string;
const NOW = new Date("2026-10-12T21:00:00Z");
const judge = { provider: "openai" as const, model: "deepseek/deepseek-v4.1-flash" };
let sends: { to: string; kind: string; text: string }[];
const mailer = {
  send: async (to: string, m: { text: string; kind: string }) => {
    sends.push({ to, kind: m.kind, text: m.text });
  },
};
let minute = 0;
async function sample(status: "judged" | "unjudged", errorClass: string | null = null) {
  minute++;
  await db.insert(schema.monitorSamples).values({
    teamId,
    kind: "tier" as const,
    status,
    score: status === "judged" ? 10 : null,
    errorClass: status === "unjudged" ? errorClass : null,
    // One sample every few hours, hours before NOW: never 20 in one hour.
    createdAt: new Date(NOW.getTime() - ((200 - minute) * 3 * 3600_000) / 10),
  });
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  await db
    .insert(schema.user)
    .values({ id: "op", name: "Operator", email: "op@example.com", createdAt: new Date(0) });
  teamId = await createTeam(db, "stall");
  sends = [];
  minute = 0;
});
afterEach(() => close());

it("mails the operator when the newest five samples all went unjudged, at any volume", async () => {
  await sample("judged");
  for (let i = 0; i < 4; i++) await sample("unjudged", "upstream");
  const state = { degradedMailedAt: null as Date | null };
  expect(await runMonitorHealth(db, { judge, mailer, state, now: NOW })).toMatchObject({
    degraded: false,
    stalled: false,
  });
  expect(sends).toEqual([]);
  await sample("unjudged", "upstream");
  expect(await runMonitorHealth(db, { judge, mailer, state, now: NOW })).toMatchObject({
    samples: 0,
    degraded: true,
    stalled: true,
  });
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ to: "op@example.com", kind: "monitor.stalled" });
  expect(sends[0]?.text).toContain("5 samples");
  expect(sends[0]?.text).toContain("upstream");
  expect(sends[0]?.text).toContain("openai · deepseek/deepseek-v4.1-flash");
  // Six hours apart at most, like the hourly notice.
  await runMonitorHealth(db, { judge, mailer, state, now: new Date(NOW.getTime() + 3600_000) });
  expect(sends).toHaveLength(1);
});

it("mails at once when the newest sample was refused for credentials or credits", async () => {
  await sample("judged");
  await sample("unjudged", "no_credentials");
  const state = { degradedMailedAt: null as Date | null };
  expect(await runMonitorHealth(db, { judge, mailer, state, now: NOW })).toMatchObject({
    stalled: true,
  });
  expect(sends.map((s) => s.kind)).toEqual(["monitor.stalled"]);
  expect(sends[0]?.text).toContain("no_credentials");
});

it("stays quiet once the judge answers again, and a purged body is not a failure", async () => {
  for (let i = 0; i < 5; i++) await sample("unjudged", "upstream");
  await sample("judged");
  const state = { degradedMailedAt: null as Date | null };
  expect(await runMonitorHealth(db, { judge, mailer, state, now: NOW })).toMatchObject({
    stalled: false,
  });
  for (let i = 0; i < 3; i++) await sample("unjudged", "timeout");
  await sample("unjudged", "body_purged");
  for (let i = 0; i < 4; i++) await sample("unjudged", "timeout");
  expect(await runMonitorHealth(db, { judge, mailer, state, now: NOW })).toMatchObject({
    stalled: false,
  });
  expect(sends).toEqual([]);
});
