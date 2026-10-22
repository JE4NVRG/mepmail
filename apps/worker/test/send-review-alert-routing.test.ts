import { holdTeamForReview } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { notifySendReviews } from "../src/handlers/safety-flags.js";
import { mailOperator, mailOwners, type SystemMailer } from "../src/system-mail.js";

const now = new Date("2026-10-17T11:30:00.000Z");
const appBaseUrl = "https://app.example.test";
const alerts = "alerts@example.test";
const operator = "operator@example.test";
const owner = "owner@example.test";
const sends: ({ to: string } & Parameters<SystemMailer["send"]>[1])[] = [];
const mailer: SystemMailer = {
  send: async (to, message) => {
    sends.push({ to, ...message });
  },
};
let db: Db;
let close: () => Promise<void>;
let teamId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  sends.length = 0;
  vi.stubEnv("SIGNUP_ALERT_EMAIL", alerts);
  vi.stubEnv("OPERATOR_ALERTS_SINK", "email");
  vi.stubEnv("AUTH_EMAIL_FROM", undefined);
  vi.stubEnv("NOTIFICATIONS_EMAIL_FROM", undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("network forbidden in synthetic review-alert tests");
    }),
  );
  teamId = await createTeam(db, "held-team");
  await db.insert(schema.user).values([
    { id: "operator", name: "Operator", email: operator, createdAt: new Date(0) },
    { id: "owner", name: "Owner", email: owner, createdAt: now },
  ]);
  await db.insert(schema.teamMembers).values({ teamId, userId: "owner", role: "owner" });
  await holdTeamForReview(db, { teamId, reason: "new_sender", note: "synthetic hold", now });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await close();
});

const notify = () => notifySendReviews(db, { now, mailer, appBaseUrl });

it("routes internal details to signup alerts and a separate safe notice to the owner", async () => {
  expect(await notify()).toBe(1);
  expect(sends).toHaveLength(2);
  expect(sends[0]).toMatchObject({
    to: alerts,
    kind: "review.held",
    subject: "Sending held for review: held-team",
  });
  expect(sends[0]?.text).toContain(`${appBaseUrl}/console/safety/${teamId}`);
  expect(sends[1]).toMatchObject({ to: owner, kind: "review.pending" });
  expect(sends[1]?.text).toContain(`${appBaseUrl}/support`);
  expect(sends[1]?.text).not.toContain("synthetic hold");
  expect(sends[1]?.text).not.toContain("/console/");
  const [held] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  expect(held).toMatchObject({ sendReviewAt: now, sendReviewNotifiedAt: now });
});

it.each([undefined, "", "not-an-email"])(
  "keeps the operator fallback when SIGNUP_ALERT_EMAIL is %s",
  async (configured) => {
    vi.stubEnv("SIGNUP_ALERT_EMAIL", configured);
    expect(await notify()).toBe(1);
    expect(sends.map(({ to, kind }) => ({ to, kind }))).toEqual([
      { to: operator, kind: "review.held" },
      { to: owner, kind: "review.pending" },
    ]);
  },
);

it.each([
  ["pt-BR", "Envio retido para revisão: held-team"],
  ["unknown", "Sending held for review: held-team"],
])("uses the validated alerts-box locale %s", async (locale, subject) => {
  vi.stubEnv("NOTIFICATIONS_EMAIL_FROM", "MepMail <notifications@sender.example.test>");
  const home = await createTeam(db, "system-mail");
  await db.insert(schema.domains).values({
    teamId: home,
    name: "sender.example.test",
    region: "us-east-1",
    status: "verified",
  });
  await db.insert(schema.contacts).values({ teamId: home, email: alerts, properties: { locale } });
  expect(await notify()).toBe(1);
  expect(sends).toHaveLength(2);
  expect(sends[0]).toMatchObject({ to: alerts, kind: "review.held", subject });
});

it("can reach the configured alerts box without an instance operator", async () => {
  await db.delete(schema.user);
  expect(await notify()).toBe(1);
  expect(sends.map(({ to }) => to)).toEqual([alerts]);
});

it("keeps the existing atomic hold claim across concurrent sweeps and replay", async () => {
  expect((await Promise.all([notify(), notify()])).sort()).toEqual([0, 1]);
  expect(await notify()).toBe(0);
  expect(sends.map(({ to, kind }) => ({ to, kind }))).toEqual([
    { to: alerts, kind: "review.held" },
    { to: owner, kind: "review.pending" },
  ]);
  const audits = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, "team.send_review_held"));
  expect(audits).toHaveLength(1);
});

it("keeps owner receipts and other operator alerts on their original routes", async () => {
  await notify();
  for (const kind of ["billing.payment_failed", "api_key.created"] as const) {
    await mailOwners(db, mailer, teamId, kind, () => ({
      subject: "synthetic receipt",
      html: "<p>synthetic receipt</p>",
      text: "synthetic receipt",
    }));
  }
  await mailOperator(db, mailer, "monitor.degraded", "/console/safety", {}, appBaseUrl);
  expect(sends.map(({ to, kind }) => ({ to, kind }))).toEqual([
    { to: alerts, kind: "review.held" },
    { to: owner, kind: "review.pending" },
    { to: owner, kind: "billing.payment_failed" },
    { to: owner, kind: "api_key.created" },
    { to: operator, kind: "monitor.degraded" },
  ]);
});

it("explains a domain hold without sharing the internal sender address or ranking", async () => {
  await db
    .update(schema.teams)
    .set({
      sendReviewNote:
        "Sending domain of PRIVATE-SENDER@example.online is under .online, a TLD abuse feeds rank as mostly malicious",
    })
    .where(eq(schema.teams.id, teamId));
  await notify();
  const notice = sends.find((send) => send.kind === "review.pending");
  expect(notice?.text).toContain(".online");
  expect(notice?.text).toContain("not a finding of phishing or abuse");
  expect(notice?.text).not.toContain("PRIVATE-SENDER");
  expect(notice?.text).not.toContain("mostly malicious");
  const [audit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.teamId, teamId));
  expect(JSON.stringify(audit?.data)).not.toContain("PRIVATE-SENDER");
});

it("preserves the operator audit sink while the owner still receives the review notice", async () => {
  vi.stubEnv("OPERATOR_ALERTS_SINK", "audit");
  expect(await notify()).toBe(1);
  expect(sends.map(({ to, kind }) => ({ to, kind }))).toEqual([
    { to: owner, kind: "review.pending" },
  ]);
  const alerts = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, "operator.alert"));
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.teamId).toBe(teamId);
});

it.each(["phishing", "manual"] as const)(
  "keeps the owner's suspension policy when an active %s suspension is present",
  async (reason) => {
    await db
      .update(schema.teams)
      .set({ suspendedAt: now, suspensionReason: reason })
      .where(eq(schema.teams.id, teamId));
    expect(await notify()).toBe(1);
    expect(sends.map(({ to, kind }) => ({ to, kind }))).toEqual([
      { to: alerts, kind: "review.held" },
    ]);
  },
);
