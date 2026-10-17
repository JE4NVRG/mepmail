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

it("sends a held-review notice only to the configured signup alerts box", async () => {
  expect(await notify()).toBe(1);
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({
    to: alerts,
    kind: "review.held",
    subject: "Sending held for review: held-team",
  });
  expect(sends[0]?.text).toContain(`${appBaseUrl}/console/safety/${teamId}`);
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
  expect(sends).toHaveLength(1);
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
    { to: owner, kind: "billing.payment_failed" },
    { to: owner, kind: "api_key.created" },
    { to: operator, kind: "monitor.degraded" },
  ]);
});
