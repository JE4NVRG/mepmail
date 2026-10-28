import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  evaluateDeliverability,
  fetchDeliverabilityHealth,
  type WindowCounts,
} from "../src/deliverability.js";

const windows = (sent: number, hardBounced = 0, complained = 0) => {
  const counts: WindowCounts = { sent, hardBounced, complained };
  return { warn: counts, pause: counts };
};
describe("MepMail internal rolling-window policy", () => {
  it.each([
    [10000, 210, 0],
    [10000, 0, 9],
    [200, 5, 0],
    [100, 0, 1],
  ])("pauses above the line with explicit noise floors (%i/%i/%i)", (sent, hard, complaints) => {
    expect(evaluateDeliverability(windows(sent, hard, complaints)).status).toBe("paused");
  });
  it.each([
    [10000, 200, 0],
    [10000, 0, 8],
  ])("strict equality is warning, not pause", (s, b, c) => {
    expect(evaluateDeliverability(windows(s, b, c)).status).toBe("warning");
  });
  it.each([
    [25, 1, 0],
    [25, 0, 1],
    [1, 1, 0],
    [1, 0, 1],
    [99, 99, 99],
  ])(
    "does not exempt trial-volume senders from a real over-limit outcome (%i/%i/%i)",
    (sent, hard, complaints) => {
      expect(evaluateDeliverability(windows(sent, hard, complaints)).status).toBe("paused");
    },
  );
  it("applies the floor only to statistical warnings and stays zero-safe", () => {
    expect(evaluateDeliverability(windows(99, 1, 0)).status).toBe("ok");
    expect(evaluateDeliverability(windows(0))).toMatchObject({
      status: "ok",
      bounceRate: 0,
      complaintRate: 0,
    });
    expect(evaluateDeliverability(windows(10000, 150)).status).toBe("warning");
    expect(evaluateDeliverability(windows(10000, 149)).status).toBe("ok");
  });
});

describe("fetchDeliverabilityHealth production SQL", () => {
  let db: Db;
  let close: () => Promise<void>;
  const now = new Date("2026-10-28T00:01:00Z");
  const at = (hours: number) => new Date(now.getTime() - hours * 3600000);
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => {
    await close?.();
  });
  async function seed(teamId: string, n: number, acceptedAt = at(12), confirmed = true) {
    return db
      .insert(schema.emails)
      .values(
        Array.from({ length: n }, () => ({
          teamId,
          from: "from@example.test",
          to: ["a@example.test", "b@example.test"],
          cc: ["c@example.test"],
          bcc: ["d@example.test"],
          subject: "Synthetic",
          createdAt: at(48),
          sentAt: acceptedAt,
          sesMessageId: confirmed ? randomUUID() : null,
        })),
      )
      .returning({ id: schema.emails.id });
  }
  async function event(
    emailId: string | undefined,
    type: "bounced" | "complained" | "sent",
    opts: {
      occurredAt?: Date;
      createdAt?: Date;
      bounceType?: string;
      provider?: boolean;
    } = {},
  ) {
    if (!emailId) throw new Error("Missing fixture email");
    await db.insert(schema.emailEvents).values({
      emailId,
      type,
      occurredAt: opts.occurredAt ?? at(1),
      createdAt: opts.createdAt ?? at(0),
      bounceType: opts.bounceType ?? null,
      snsMessageId: opts.provider === false ? null : randomUUID(),
    });
  }
  it("crosses midnight without UTC-day dilution; dedupes callbacks and counts messages not recipients", async () => {
    const team = await createTeam(db, `window-${randomUUID()}`);
    const rows = await seed(team, 200);
    await seed(team, 500, at(24)); // exact lower edge excluded
    await seed(team, 500, at(25));
    await seed(team, 500, at(2), false); // network/claim ambiguity, NOT accepted
    for (const row of rows.slice(0, 5)) {
      await event(row.id, "bounced", { bounceType: "Permanent" });
      await event(row.id, "bounced", { bounceType: "Permanent" }); // different SNS ID too
    }
    await event(rows[6]?.id, "bounced", { bounceType: "Transient" });
    await event(rows[7]?.id, "bounced", { bounceType: "Undetermined" });
    await event(rows[8]?.id, "bounced", { bounceType: "Permanent", occurredAt: at(24) });
    const other = await createTeam(db, `other-${randomUUID()}`);
    const foreign = await seed(other, 100);
    await event(foreign[0]?.id, "complained");
    const health = await fetchDeliverabilityHealth(db, team, { now });
    expect(health).toMatchObject({
      sent: 200,
      status: "paused",
      bounceRate: 0.025,
      complaintRate: 0,
      windowDays: 1,
      pause: { sent: 200, hardBounced: 5, complained: 0, windowDays: 1 },
      rollingWindow: {
        start: at(24),
        end: now,
        hours: 24,
        countingUnit: "message",
        outcomeWatermark: now,
      },
    });
    expect(
      (await fetchDeliverabilityHealth(db, team, { now: new Date(now.getTime() + 86400000) })).pause
        .hardBounced,
    ).toBe(0);
  });
  it("late callbacks use occurrence, not arrival; provider evidence resolves an ambiguous claim once", async () => {
    const team = await createTeam(db, `delayed-${randomUUID()}`);
    const rows = await seed(team, 100);
    const [ambiguous] = await seed(team, 1, at(2), false);
    expect((await fetchDeliverabilityHealth(db, team, { now })).sent).toBe(100);
    await event(ambiguous?.id, "sent", { occurredAt: at(2), provider: false });
    await event(ambiguous?.id, "complained", { occurredAt: at(1), createdAt: at(0.5) });
    await event(ambiguous?.id, "complained", { occurredAt: at(1) });
    await event(rows[0]?.id, "bounced", { bounceType: "Permanent", occurredAt: at(25) });
    await event(rows[1]?.id, "bounced", { bounceType: "Permanent", occurredAt: at(-1) });
    const health = await fetchDeliverabilityHealth(db, team, { now });
    expect(health).toMatchObject({
      sent: 101,
      status: "paused",
      pause: { hardBounced: 0, complained: 1 },
    });
    expect(health.rollingWindow?.outcomeWatermark).toEqual(at(0.5));
  });
  it("does not hide a delayed in-window outcome for an older confirmed send", async () => {
    const team = await createTeam(db, `older-${randomUUID()}`);
    await seed(team, 100);
    const [old] = await seed(team, 1, at(30));
    await event(old?.id, "complained", { occurredAt: at(2), createdAt: now });
    const health = await fetchDeliverabilityHealth(db, team, { now });
    expect(health).toMatchObject({ sent: 100, status: "paused", pause: { complained: 1 } });
  });
  it("uses confirmed send event time rather than a pre-network claim when available", async () => {
    const team = await createTeam(db, `acceptance-${randomUUID()}`);
    const rows = await seed(team, 100, at(25));
    for (const row of rows) await event(row.id, "sent", { occurredAt: at(12), provider: false });
    expect((await fetchDeliverabilityHealth(db, team, { now })).sent).toBe(100);
    const before = new Date(now.getTime() - 60_000);
    expect((await fetchDeliverabilityHealth(db, team, { now: before })).sent).toBe(0);
  });
  it("is empty-safe and rejects invalid evaluation time", async () => {
    const team = await createTeam(db, `empty-${randomUUID()}`);
    expect(await fetchDeliverabilityHealth(db, team, { now })).toMatchObject({
      sent: 0,
      status: "ok",
      bounceRate: 0,
    });
    await expect(fetchDeliverabilityHealth(db, team, { now: new Date("invalid") })).rejects.toThrow(
      RangeError,
    );
  });
});
