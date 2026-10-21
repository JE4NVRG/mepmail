import { buildAccountMail, holdTeamForReview, recordOperatorAlert } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifySendReviews } from "../src/handlers/safety-flags.js";
import { mailOperator, type SystemMailer } from "../src/system-mail.js";

const now = new Date("2026-10-17T11:30:00.000Z");
const appBaseUrl = "https://app.example.test";
const alerts = "alerts@example.test";
const operator = "operator@example.test";
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
  // The sink is unset by default: every test that wants the audit trail opts in.
  vi.stubEnv("OPERATOR_ALERTS_SINK", undefined);
  vi.stubEnv("SIGNUP_ALERT_EMAIL", alerts);
  vi.stubEnv("AUTH_EMAIL_FROM", undefined);
  vi.stubEnv("NOTIFICATIONS_EMAIL_FROM", undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("network forbidden in operator-alert sink tests");
    }),
  );
  teamId = await createTeam(db, "held-team");
  await db
    .insert(schema.user)
    .values({ id: "operator", name: "Operator", email: operator, createdAt: new Date(0) });
  await holdTeamForReview(db, { teamId, reason: "new_sender", note: "synthetic hold", now });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await close();
});

/** Every row an audit sink writes, newest last. */
const operatorAlerts = () =>
  db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "operator.alert"));

const degradedValues = {
  rate: "25%",
  unjudged: "5",
  samples: "20",
  provider: "typesafe",
  model: "jev-latest",
};

describe("OPERATOR_ALERTS_SINK", () => {
  it("e-mails the operator and writes no operator.alert row while the sink is unset", async () => {
    expect(
      await mailOperator(db, mailer, "monitor.degraded", "/console", degradedValues, appBaseUrl),
    ).toBe(true);
    expect(sends.map(({ to, kind }) => ({ to, kind }))).toEqual([
      { to: operator, kind: "monitor.degraded" },
    ]);
    expect(await operatorAlerts()).toHaveLength(0);
  });

  it("records the same subject, body and link as one row when the sink is audit", async () => {
    vi.stubEnv("OPERATOR_ALERTS_SINK", "audit");
    const expected = buildAccountMail({
      kind: "monitor.degraded",
      locale: "en",
      url: `${appBaseUrl}/console`,
      values: degradedValues,
    });
    expect(
      await mailOperator(db, mailer, "monitor.degraded", "/console", degradedValues, appBaseUrl),
    ).toBe(true);
    expect(sends).toHaveLength(0);
    const rows = await operatorAlerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: "system",
      // An instance-wide alert belongs to no team: the schema allows null.
      teamId: null,
      target: null,
      data: {
        kind: "monitor.degraded",
        subject: expected.subject,
        // The row keeps the mail's plain text, without the card's trailing blank lines.
        text: expected.text.trim(),
        url: `${appBaseUrl}/console`,
      },
    });
  });

  it("keeps the team an alert is about, and never inlines HTML", async () => {
    vi.stubEnv("OPERATOR_ALERTS_SINK", "audit");
    await mailOperator(
      db,
      mailer,
      "monitor.alert",
      `/console/safety/${teamId}`,
      { team: "held-team", risk: "0.90", tier: "high", samples: "12", flagged: "3" },
      appBaseUrl,
      { teamId },
    );
    const [row] = await operatorAlerts();
    expect(row).toMatchObject({
      teamId,
      data: { kind: "monitor.alert", url: `${appBaseUrl}/console/safety/${teamId}` },
    });
    expect(String(row?.data?.text)).not.toContain("<p>");
  });

  it("clips a body past the plain-text ceiling instead of storing a mail", async () => {
    await recordOperatorAlert(db, {
      kind: "review.held",
      subject: "synthetic",
      text: "x".repeat(4000),
      url: "",
      teamId: null,
    });
    const [row] = await operatorAlerts();
    const stored = String(row?.data?.text);
    expect(stored).toHaveLength(1500);
    expect(stored.endsWith("…")).toBe(true);
  });

  it("turns a held-review notice into one row, keeping the hold's own audit and claim", async () => {
    vi.stubEnv("OPERATOR_ALERTS_SINK", "audit");
    expect(await notifySendReviews(db, { now, mailer, appBaseUrl })).toBe(1);
    expect(sends).toHaveLength(0);
    const expected = buildAccountMail({
      kind: "review.held",
      locale: "en",
      url: `${appBaseUrl}/console/safety/${teamId}`,
      values: { team: "held-team", note: "synthetic hold" },
    });
    const rows = await operatorAlerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      teamId,
      data: {
        kind: "review.held",
        subject: expected.subject,
        // The row keeps the mail's plain text, without the card's trailing blank lines.
        text: expected.text.trim(),
        url: `${appBaseUrl}/console/safety/${teamId}`,
      },
    });
    // The hold's own trail and its once-only claim are untouched.
    const holds = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "team.send_review_held"));
    expect(holds).toHaveLength(1);
    const [held] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(held).toMatchObject({ sendReviewNotifiedAt: now });
    // A replay marks nothing and records nothing twice.
    expect(await notifySendReviews(db, { now, mailer, appBaseUrl })).toBe(0);
    expect(await operatorAlerts()).toHaveLength(1);
  });

  it("records the operator fallback branch the same way when no alerts box is set", async () => {
    vi.stubEnv("OPERATOR_ALERTS_SINK", "audit");
    vi.stubEnv("SIGNUP_ALERT_EMAIL", undefined);
    expect(await notifySendReviews(db, { now, mailer, appBaseUrl })).toBe(1);
    expect(sends).toHaveLength(0);
    const rows = await operatorAlerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      teamId,
      data: { kind: "review.held", subject: "Sending held for review: held-team" },
    });
  });

  it("leaves the alerts-box e-mail and its trail alone while the sink is unset", async () => {
    expect(await notifySendReviews(db, { now, mailer, appBaseUrl })).toBe(1);
    expect(sends.map(({ to, kind }) => ({ to, kind }))).toEqual([
      { to: alerts, kind: "review.held" },
    ]);
    expect(await operatorAlerts()).toHaveLength(0);
  });
});
