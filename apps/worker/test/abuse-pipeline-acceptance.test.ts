import { randomBytes, randomUUID } from "node:crypto";
import {
  EnvKeyring,
  encryptEmailBody,
  MONITOR_SETTING_DEFAULTS,
  markLostSamples,
  planBroadcastSamples,
  recordMonitorSample,
  sampleAcceptedEmail,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createOpenAiJudge } from "../src/abuse-judge/openai.js";
import { judgeSample } from "../src/handlers/abuse-judge.js";
import { flushMonitorAlerts } from "../src/handlers/monitor-alerts.js";
import { runMonitorHealth } from "../src/handlers/monitor-health.js";

// Source-bound acceptance: actual sampling, crypto, Drizzle/PGlite, adapters,
// verdict fold, holds and audit. Only queue delivery and external HTTP are fake.
let db: Db;
let close: () => Promise<void>;
const now = new Date("2026-11-12T12:00:00Z");
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const settings = async () => MONITOR_SETTING_DEFAULTS;
const samplingKey = randomBytes(32);
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => {
  await close();
  vi.unstubAllEnvs();
});
async function seed(name = "fixture") {
  const teamId = await createTeam(db, `${name}-${randomUUID()}`);
  const emailId = randomUUID();
  const sealed = await encryptEmailBody(
    { html: "<p>BODY_PRIVATE_SENTINEL</p>", text: null },
    keyring,
    { teamId, rowId: emailId },
  );
  await db.insert(schema.emails).values({
    id: emailId,
    teamId,
    from: "Fixture <sender@example.test>",
    to: ["RECIPIENT_PRIVATE@example.test"],
    subject: "Fixture",
    latestStatus: "sent",
    bodyCiphertext: sealed.ciphertext,
    bodyIv: sealed.iv,
    bodyWrappedDek: sealed.wrappedDek,
    bodyKeyVersion: sealed.keyVersion,
  });
  return { teamId, emailId };
}
async function capture(f: { teamId: string; emailId: string }, queue: string[]) {
  return sampleAcceptedEmail(
    db,
    {
      samplingKey,
      settings,
      enqueueJudge: async (id) => {
        queue.push(id);
      },
    },
    { ...f, broadcast: false, anomalies: 0, now },
  );
}
const row = async (id: string) =>
  (await db.select().from(schema.monitorSamples).where(eq(schema.monitorSamples.id, id)))[0];
const monitor = async (id: string) =>
  (await db.select().from(schema.teamMonitor).where(eq(schema.teamMonitor.teamId, id)))[0];
function adapter(score: number, blocks: string[], response?: () => Promise<Response>) {
  return createOpenAiJudge({
    model: "offline-fixture",
    baseUrl: "https://never-network.example.test",
    apiKey: "fixture-only-not-a-secret",
    fetch: async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      blocks.push(payload.messages[1].content);
      return response
        ? response()
        : new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      is_abuse: score / 100,
                      impersonation: score / 100,
                      category: "phishing",
                      language: "en",
                    }),
                  },
                },
              ],
            }),
          );
    },
  });
}
it("captures eligible accepted first-send, queues its durable id, judges clean once and excludes recipient", async () => {
  const fixture = await seed("clean"),
    queue: string[] = [],
    blocks: string[] = [];
  const captured = await capture(fixture, queue);
  expect(captured.decision).toMatchObject({ tier: "new", rate: 1, kind: "first_sends" });
  expect(queue).toEqual([captured.sampleId]);
  const id = queue[0] ?? "";
  expect(await row(id)).toMatchObject({
    teamId: fixture.teamId,
    emailId: fixture.emailId,
    status: "pending",
  });
  const mailer = { send: vi.fn(async () => {}) };
  const deps = { judge: adapter(0, blocks), keyring, settings, mailer, now: () => now };
  expect(await judgeSample(db, deps, { sampleId: id })).toBe("judged");
  expect(await row(id)).toMatchObject({
    status: "judged",
    score: 0,
    verdict: "clean",
    model: "offline-fixture",
  });
  expect(blocks[0]).toContain("BODY_PRIVATE_SENTINEL");
  expect(blocks[0]).not.toContain("RECIPIENT_PRIVATE");
  expect(JSON.stringify(await row(id))).not.toContain("BODY_PRIVATE_SENTINEL");
  const before = await monitor(fixture.teamId);
  expect(await judgeSample(db, deps, { sampleId: id })).toBe("skipped");
  expect(await monitor(fixture.teamId)).toEqual(before);
  expect(blocks).toHaveLength(1);
  expect(mailer.send).not.toHaveBeenCalled();
});
it("repeated abuse produces one safe durable operator alert, pause audit and no actual mail", async () => {
  vi.stubEnv("OPERATOR_ALERTS_SINK", "audit");
  const f = await seed("abuse"),
    queue: string[] = [],
    blocks: string[] = [];
  const mailer = { send: vi.fn(async () => {}) };
  const deps = {
    judge: adapter(100, blocks),
    keyring,
    settings,
    mailer,
    now: () => now,
    appBaseUrl: "https://app.example.test",
  };
  for (let n = 0; n < 12; n++) {
    const emailId = randomUUID();
    const sealed = await encryptEmailBody({ html: "<p>synthetic abuse</p>", text: null }, keyring, {
      teamId: f.teamId,
      rowId: emailId,
    });
    await db.insert(schema.emails).values({
      id: emailId,
      teamId: f.teamId,
      from: "sender@example.test",
      to: ["recipient@example.test"],
      subject: "Fixture",
      latestStatus: "sent",
      bodyCiphertext: sealed.ciphertext,
      bodyIv: sealed.iv,
      bodyWrappedDek: sealed.wrappedDek,
      bodyKeyVersion: sealed.keyVersion,
    });
    const sample = await capture({ teamId: f.teamId, emailId }, queue);
    expect(await judgeSample(db, deps, { sampleId: sample.sampleId ?? "" })).toBe("judged");
  }
  const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.teamId, f.teamId));
  const alerts = audit.filter((a) => a.action === "operator.alert");
  expect(alerts.filter((a) => a.data?.kind === "monitor.alert")).toHaveLength(1);
  expect(alerts.filter((a) => a.data?.kind === "monitor.broadcasts_paused")).toHaveLength(1);
  expect(audit.some((a) => a.action === "monitor.broadcasts_paused")).toBe(true);
  expect(JSON.stringify(alerts)).not.toContain("BODY_PRIVATE_SENTINEL");
  expect(JSON.stringify(alerts)).not.toContain("RECIPIENT_PRIVATE");
  expect(JSON.stringify(alerts)).toContain(`/console/safety/${f.teamId}`);
  expect(mailer.send).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});
it.each(["malformed", "unavailable"])(
  "captured %s model outcome is durable unjudged and cannot change safety state",
  async (kind) => {
    const f = await seed(kind),
      queue: string[] = [],
      blocks: string[] = [];
    const sample = await capture(f, queue),
      before = await monitor(f.teamId);
    const mailer = { send: vi.fn(async () => {}) };
    const judge = adapter(100, blocks, async () =>
      kind === "malformed"
        ? new Response("not-json")
        : new Response("unavailable", { status: 503 }),
    );
    expect(
      await judgeSample(
        db,
        { judge, keyring, settings, mailer, now: () => now },
        { sampleId: sample.sampleId ?? "" },
      ),
    ).toBe("unjudged");
    expect(await row(sample.sampleId ?? "")).toMatchObject({
      status: "unjudged",
      score: null,
      verdict: null,
      errorClass: kind === "malformed" ? "parse_error" : "upstream",
    });
    expect(await monitor(f.teamId)).toEqual(before);
    expect(mailer.send).not.toHaveBeenCalled();
  },
);
it("system plan remains exempt and broadcast accepted counter never creates per-recipient samples", async () => {
  const f = await seed("system"),
    queue: string[] = [];
  await db.update(schema.teams).set({ plan: "system" }).where(eq(schema.teams.id, f.teamId));
  expect((await capture(f, queue)).sampleId).toBeNull();
  const b = await seed("broadcast");
  expect(
    await sampleAcceptedEmail(
      db,
      {
        samplingKey,
        settings,
        enqueueJudge: async (id) => {
          queue.push(id);
        },
      },
      { ...b, broadcast: true, anomalies: 0, now },
    ),
  ).toEqual({ sampleId: null, decision: null });
  expect(queue).toEqual([]);
});
it("queue boundary failure leaves persisted pending sample rather than a false clean verdict", async () => {
  const f = await seed("queue-failure");
  await expect(
    sampleAcceptedEmail(
      db,
      {
        samplingKey,
        settings,
        enqueueJudge: async () => {
          throw Error("fixture queue unavailable");
        },
      },
      { ...f, broadcast: false, anomalies: 0, now },
    ),
  ).rejects.toThrow("fixture queue unavailable");
  const samples = await db
    .select()
    .from(schema.monitorSamples)
    .where(eq(schema.monitorSamples.teamId, f.teamId));
  expect(samples).toHaveLength(1);
  expect(samples[0]).toMatchObject({ status: "pending", score: null });
});
it("TENANT FENCE: inconsistent sample must not expose another team's decrypted body to the judge", async () => {
  const a = await seed("team-a"),
    b = await seed("team-b"),
    queue: string[] = [],
    blocks: string[] = [];
  const captured = await capture(a, queue);
  // Both independent foreign keys are valid, but ownership is inconsistent.
  await db
    .update(schema.monitorSamples)
    .set({ emailId: b.emailId })
    .where(eq(schema.monitorSamples.id, captured.sampleId ?? ""));
  await judgeSample(
    db,
    { judge: adapter(0, blocks), keyring, settings, now: () => now },
    { sampleId: captured.sampleId ?? "" },
  );
  expect(blocks, "cross-tenant email must be rejected before model boundary").toHaveLength(0);
});

const monitorDeps = { samplingKey, settings, enqueueJudge: async () => {} };
async function broadcast(teamId: string) {
  const [b] = await db
    .insert(schema.broadcasts)
    .values({
      teamId,
      from: "sender@example.test",
      subject: "Synthetic",
      html: "<p>private broadcast sentinel</p>",
    })
    .returning();
  if (!b) throw Error("missing broadcast fixture");
  return b;
}
it("broadcast skeleton/copy and kind mismatch fences reject before decrypt, attachments and model", async () => {
  const a = await seed("skeleton-a"),
    b = await seed("skeleton-b");
  const ba = await broadcast(a.teamId),
    bb = await broadcast(b.teamId);
  const blocks: string[] = [];
  const invalid = [
    { kind: "broadcast_skeleton" as const, emailId: null, broadcastId: bb.id },
    { kind: "broadcast_skeleton" as const, emailId: a.emailId, broadcastId: ba.id },
    { kind: "broadcast_copy" as const, emailId: a.emailId, broadcastId: bb.id },
    { kind: "broadcast_copy" as const, emailId: b.emailId, broadcastId: ba.id },
    { kind: "broadcast_copy" as const, emailId: a.emailId, broadcastId: ba.id },
    { kind: "tier" as const, emailId: a.emailId, broadcastId: ba.id },
  ];
  const deniedKeyring = new Proxy(keyring, {
    get() {
      throw Error("decrypt boundary crossed");
    },
  });
  for (const shape of invalid) {
    const [sample] = await db
      .insert(schema.monitorSamples)
      .values({ teamId: a.teamId, ...shape })
      .returning();
    expect(
      await judgeSample(
        db,
        { judge: adapter(100, blocks), keyring: deniedKeyring, settings },
        { sampleId: sample?.id ?? "" },
      ),
    ).toBe("unjudged");
  }
  expect(blocks).toHaveLength(0);
  expect(await monitor(a.teamId)).toBeUndefined();
  expect(await monitor(b.teamId)).toBeUndefined();
});
it("writer rejects inconsistent ownership, deduplicates concurrent capture and fences broadcast planning", async () => {
  const a = await seed("writer-a"),
    b = await seed("writer-b");
  const bb = await broadcast(b.teamId);
  expect(
    await recordMonitorSample(db, monitorDeps, await settings(), {
      teamId: a.teamId,
      emailId: b.emailId,
      broadcastId: null,
      kind: "first_sends",
      now,
    }),
  ).toBeNull();
  expect(
    await planBroadcastSamples(db, monitorDeps, { teamId: a.teamId, broadcastId: bb.id, now }),
  ).toEqual({ skeletonSampleId: null, copies: 0 });
  const captures = await Promise.all([capture(a, []), capture(a, [])]);
  expect(captures.filter((c) => c.sampleId !== null)).toHaveLength(1);
  const ba = await broadcast(a.teamId);
  await Promise.all([
    planBroadcastSamples(db, monitorDeps, { teamId: a.teamId, broadcastId: ba.id, now }),
    planBroadcastSamples(db, monitorDeps, { teamId: a.teamId, broadcastId: ba.id, now }),
  ]);
  const samples = await db
    .select()
    .from(schema.monitorSamples)
    .where(eq(schema.monitorSamples.broadcastId, ba.id));
  expect(samples).toHaveLength(1);
});
it("durable audit failure retains intent and safety; judged replay recovers once without model/risk repeat", async () => {
  vi.stubEnv("OPERATOR_ALERTS_SINK", "audit");
  const f = await seed("durable");
  const blocks: string[] = [];
  const sample = await capture(f, []);
  await db.insert(schema.teamMonitor).values({ teamId: f.teamId }).onConflictDoNothing();
  await db
    .update(schema.teamMonitor)
    .set({ riskNum: 20, riskDen: 20 })
    .where(eq(schema.teamMonitor.teamId, f.teamId));
  await db.execute(
    sql`CREATE FUNCTION fail_operator_alert_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'operator.alert' THEN RAISE EXCEPTION 'fixture sink failure'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER fail_operator_alert_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_operator_alert_fixture()`,
  );
  const deps = { judge: adapter(100, blocks), keyring, settings, now: () => now };
  expect(await judgeSample(db, deps, { sampleId: sample.sampleId ?? "" })).toBe("judged");
  const before = await monitor(f.teamId);
  expect(before?.broadcastsPausedAt).toEqual(now);
  const pending = () =>
    db.select().from(schema.teamNotifications).where(eq(schema.teamNotifications.teamId, f.teamId));
  expect(await pending()).toHaveLength(2);
  expect((await row(sample.sampleId ?? ""))?.status).toBe("judged");
  await db.execute(sql`DROP TRIGGER fail_operator_alert_fixture ON audit_log`);
  await db.execute(sql`DROP FUNCTION fail_operator_alert_fixture()`);
  await Promise.all([
    judgeSample(db, deps, { sampleId: sample.sampleId ?? "" }),
    judgeSample(db, deps, { sampleId: sample.sampleId ?? "" }),
  ]);
  expect(await monitor(f.teamId)).toEqual(before);
  expect(blocks).toHaveLength(1);
  expect((await pending()).filter((n) => n.kind.startsWith("monitor.pending."))).toHaveLength(0);
  const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.teamId, f.teamId));
  expect(audit.filter((a) => a.action === "operator.alert")).toHaveLength(2);
  expect(audit.filter((a) => a.action === "monitor.broadcasts_paused")).toHaveLength(1);
  expect(await flushMonitorAlerts(db, {}, f.teamId)).toBe(0);
  vi.unstubAllEnvs();
});
it("queue failure is bounded by lost terminalization and audit alert even at one sample and judge disabled", async () => {
  vi.stubEnv("OPERATOR_ALERTS_SINK", "audit");
  const f = await seed("lost-single");
  await expect(
    sampleAcceptedEmail(
      db,
      {
        ...monitorDeps,
        enqueueJudge: async () => {
          throw Error("queue down");
        },
      },
      { ...f, broadcast: false, anomalies: 0, now },
    ),
  ).rejects.toThrow("queue down");
  const later = new Date(now.getTime() + 3 * 3600000 + 1);
  await runMonitorHealth(db, { judge: null, state: { degradedMailedAt: null }, now: later });
  const samples = await db
    .select()
    .from(schema.monitorSamples)
    .where(eq(schema.monitorSamples.teamId, f.teamId));
  expect(samples).toHaveLength(1);
  expect(samples[0]).toMatchObject({ status: "unjudged", errorClass: "lost", score: null });
  const alerts = await db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.teamId, f.teamId), eq(schema.auditLog.action, "operator.alert")));
  expect(alerts).toHaveLength(1);
  expect(await markLostSamples(db, later)).toBe(0);
  expect(await flushMonitorAlerts(db, {})).toBe(0);
  vi.unstubAllEnvs();
});

it("email sink failure retries intent without repeating judge, risk or pause", async () => {
  vi.stubEnv("OPERATOR_ALERTS_SINK", "email");
  await db
    .insert(schema.user)
    .values({
      id: "fixture-email-operator",
      name: "Operator",
      email: "operator@example.test",
      createdAt: new Date(0),
    })
    .onConflictDoNothing();
  const f = await seed("email-retry");
  const sample = await capture(f, []);
  await db
    .update(schema.teamMonitor)
    .set({ riskNum: 20, riskDen: 20 })
    .where(eq(schema.teamMonitor.teamId, f.teamId));
  const blocks: string[] = [];
  const mailer = {
    send: vi.fn(async () => {
      throw Error("fixture mail sink unavailable");
    }),
  };
  const deps = { judge: adapter(100, blocks), keyring, settings, mailer, now: () => now };
  expect(await judgeSample(db, deps, { sampleId: sample.sampleId ?? "" })).toBe("judged");
  const before = await monitor(f.teamId);
  expect(before?.broadcastsPausedAt).toEqual(now);
  expect(mailer.send).toHaveBeenCalledTimes(2);
  mailer.send.mockImplementation(async () => {});
  await Promise.all([
    judgeSample(db, deps, { sampleId: sample.sampleId ?? "" }),
    judgeSample(db, deps, { sampleId: sample.sampleId ?? "" }),
  ]);
  expect(blocks).toHaveLength(1);
  expect(await monitor(f.teamId)).toEqual(before);
  const afterSuccess = mailer.send.mock.calls.length;
  expect(await flushMonitorAlerts(db, deps, f.teamId)).toBe(0);
  expect(mailer.send.mock.calls).toHaveLength(afterSuccess);
  vi.unstubAllEnvs();
});
it("valid broadcast rendered copy retains ordinary tenant-scoped judgment", async () => {
  const f = await seed("valid-copy"),
    b = await broadcast(f.teamId);
  await db.update(schema.emails).set({ broadcastId: b.id }).where(eq(schema.emails.id, f.emailId));
  const id = await recordMonitorSample(db, monitorDeps, await settings(), {
    ...f,
    broadcastId: b.id,
    kind: "broadcast_copy",
    now,
  });
  expect(id).not.toBeNull();
  const blocks: string[] = [];
  expect(
    await judgeSample(db, { judge: adapter(0, blocks), keyring, settings }, { sampleId: id ?? "" }),
  ).toBe("judged");
  expect(blocks).toHaveLength(1);
});
it("dead-letter lost transition is atomic, idempotent and notified by the existing health cadence", async () => {
  vi.stubEnv("OPERATOR_ALERTS_SINK", "audit");
  const f = await seed("dead-letter");
  const sample = await capture(f, []);
  expect(await markLostSamples(db, now, sample.sampleId ?? "")).toBe(1);
  expect(await markLostSamples(db, now, sample.sampleId ?? "")).toBe(0);
  expect(await flushMonitorAlerts(db, {}, f.teamId)).toBe(1);
  expect(await flushMonitorAlerts(db, {}, f.teamId)).toBe(0);
  expect(await row(sample.sampleId ?? "")).toMatchObject({
    status: "unjudged",
    errorClass: "lost",
    score: null,
  });
  vi.unstubAllEnvs();
});

it("health intent survives sink failure and restart; concurrent recovery does not duplicate", async () => {
  vi.stubEnv("OPERATOR_ALERTS_SINK", "audit");
  const f = await seed("health-durable");
  await db
    .insert(schema.monitorSamples)
    .values({
      teamId: f.teamId,
      kind: "tier",
      status: "unjudged",
      errorClass: "no_credentials",
      createdAt: new Date("2026-11-20T00:00:00Z"),
    });
  const healthNow = new Date("2026-11-20T00:01:00Z");
  await db.execute(
    sql`CREATE FUNCTION fail_health_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'operator.alert' THEN RAISE EXCEPTION 'fixture sink failure'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER fail_health_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_health_fixture()`,
  );
  const deps = {
    judge: { provider: "fixture", model: "fixture" },
    state: { degradedMailedAt: null },
    now: healthNow,
  };
  await runMonitorHealth(db, deps);
  await db.execute(sql`DROP TRIGGER fail_health_fixture ON audit_log`);
  await db.execute(sql`DROP FUNCTION fail_health_fixture()`);
  await Promise.all([
    runMonitorHealth(db, { ...deps, state: { degradedMailedAt: null } }),
    runMonitorHealth(db, { ...deps, state: { degradedMailedAt: null } }),
  ]);
  const alerts = await db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.teamId, f.teamId), eq(schema.auditLog.action, "operator.alert")));
  expect(alerts.filter((a) => a.data?.kind === "monitor.stalled")).toHaveLength(1);
  vi.unstubAllEnvs();
});
it("lost sweep processes at most 100 and never invents verdicts", async () => {
  const f = await seed("lost-bound");
  const at = new Date("2026-11-01T00:00:00Z");
  await db
    .insert(schema.monitorSamples)
    .values(
      Array.from({ length: 101 }, () => ({
        teamId: f.teamId,
        kind: "tier" as const,
        createdAt: at,
      })),
    );
  expect(await markLostSamples(db, now)).toBe(100);
  expect(await markLostSamples(db, now)).toBe(1);
  expect(await markLostSamples(db, now)).toBe(0);
  const samples = await db
    .select()
    .from(schema.monitorSamples)
    .where(eq(schema.monitorSamples.teamId, f.teamId));
  expect(samples.every((a) => a.status === "unjudged" && a.score === null)).toBe(true);
});
