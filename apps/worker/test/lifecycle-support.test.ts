import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildAccountMail, mailPreferenceOf } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { warnEndingMailboxTrials } from "../src/handlers/mailbox-trial-ending.js";
import { reportPlanMove, sweepActivation, sweepNotifications } from "../src/handlers/notify.js";

const HOUR = 3_600_000;
const created = new Date("2026-10-17T12:00:00Z");
const at = (hours: number) => new Date(created.getTime() + hours * HOUR);
const base = "https://app.example.test";
const cohort = { activationSupportFromISO: created.toISOString() };
let db: Db;
let close: () => Promise<void>;
let teamId: string;
let sends: { to: string; kind: string; subject: string; text: string; html: string }[];
const mailer = {
  send: async (to: string, mail: Omit<(typeof sends)[number], "to">) => {
    sends.push({ to, ...mail });
  },
};
const sweep = (
  hours: number,
  options: { activationSupportFromISO?: string | undefined } = cohort,
) => sweepActivation(db, mailer, base, at(hours), options);
const claims = () => db.select().from(schema.teamNotifications);

async function owner(id: string, overrides: Partial<typeof schema.user.$inferInsert> = {}) {
  await db.insert(schema.user).values({
    id,
    name: id,
    email: `${id}@example.invalid`,
    emailVerified: true,
    ...overrides,
  });
  await db.insert(schema.teamMembers).values({ teamId, userId: id, role: "owner" });
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "support-team");
  await db.update(schema.teams).set({ createdAt: created }).where(eq(schema.teams.id, teamId));
  await owner("owner");
  sends = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("network forbidden in offline lifecycle tests");
    }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await close();
});

it("new notices are off without a valid ISO cutoff; existing generic reminders still work", async () => {
  for (const cutoff of [undefined, "", "not-a-date", "2026-02-30T00:00:00Z"]) {
    await db.delete(schema.teamNotifications);
    sends = [];
    const options = { activationSupportFromISO: cutoff };
    expect(await sweep(2, options)).toBe(0);
    expect(await sweep(21, options)).toBe(1);
    expect(sends.map((m) => m.kind)).toEqual(["activation.add_domain"]);
  }
});

it("enrolls on the cutoff only, never backfills older teams, and replaces generic nudges for the cohort", async () => {
  expect(
    await sweep(2, { activationSupportFromISO: new Date(created.getTime() + 1).toISOString() }),
  ).toBe(0);
  expect(
    await sweep(21, { activationSupportFromISO: new Date(created.getTime() + 1).toISOString() }),
  ).toBe(1);
  expect(sends[0]?.kind).toBe("activation.add_domain");
  sends = [];
  await db.delete(schema.teamNotifications);
  expect(await sweep(21)).toBe(1);
  expect(sends.map((m) => m.kind)).toEqual(["activation.first_email"]);
  expect(await sweep(73)).toBe(0);
});

it("uses the 2–24h and day 7–8 windows once each, including a paid team without domain setup", async () => {
  await db
    .update(schema.teams)
    .set({ plan: "pro", planStatus: "active" })
    .where(eq(schema.teams.id, teamId));
  expect(await sweep(1.99)).toBe(0);
  expect(await sweep(2)).toBe(1);
  expect(await sweep(21)).toBe(0);
  expect(await sweep(24)).toBe(0);
  expect(await sweep(167.99)).toBe(0);
  expect(await sweep(168)).toBe(1);
  expect(await sweep(191)).toBe(0);
  expect(await sweep(192)).toBe(0);
  expect(sends.map((m) => m.kind)).toEqual(["activation.first_email", "activation.day7"]);
  expect(sends.every((m) => m.text.includes(`${base}/onboarding#first-email`))).toBe(true);
  expect((await claims()).map((c) => [c.kind, c.periodKey]).sort()).toEqual([
    ["activation.day7", "once"],
    ["activation.first_email", "once"],
  ]);
});

it("does not backfill missed windows and does not require the first nudge to send the day-7 support", async () => {
  expect(await sweep(25)).toBe(0);
  expect(await sweep(168)).toBe(1);
  expect(sends.map((m) => m.kind)).toEqual(["activation.day7"]);
  await db.delete(schema.teamNotifications);
  sends = [];
  expect(await sweep(192)).toBe(0);
  expect(sends).toEqual([]);
});

it.each(["sent", "accepted", "funnel", "email"] as const)(
  "all-time %s evidence suppresses support independently of the current period or email retention",
  async (evidence) => {
    if (evidence === "sent" || evidence === "accepted") {
      await db.insert(schema.usageCounters).values({ teamId, day: "2025-01-01", [evidence]: 1 });
    } else if (evidence === "funnel") {
      await db.insert(schema.funnelEvents).values({
        teamId,
        name: "first_email_sent",
        dedupeKey: `first_email_sent:${teamId}`,
        createdAt: at(-1000),
      });
    } else {
      await db.insert(schema.emails).values({
        teamId,
        from: "sender@example.invalid",
        to: ["owner@example.invalid"],
        subject: "Synthetic prior send",
        sentAt: at(-1000),
        createdAt: at(-1000),
        latestStatus: "sent",
        bodyPurgedAt: at(-500),
      });
    }
    await db
      .insert(schema.usageCounters)
      .values({ teamId, day: "2026-10-17", sent: 0, accepted: 0 });
    // The query must correlate to this team, not exclude every team because one has history.
    const fresh = await createTeam(db, "fresh-free");
    await db.update(schema.teams).set({ createdAt: created }).where(eq(schema.teams.id, fresh));
    await db.insert(schema.teamMembers).values({ teamId: fresh, userId: "owner", role: "owner" });
    expect(await sweep(2)).toBe(1);
    expect((await claims()).map((claim) => claim.teamId)).toEqual([fresh]);
    expect(await sweep(168)).toBe(1);
    expect((await claims()).every((claim) => claim.teamId === fresh)).toBe(true);
  },
);

it("stops the day-7 reminder when a first send is accepted after the first support", async () => {
  expect(await sweep(2)).toBe(1);
  await db.insert(schema.usageCounters).values({ teamId, day: "2026-10-18", accepted: 1 });
  expect(await sweep(168)).toBe(0);
  expect(sends).toHaveLength(1);
});

it.each(["suspendedAt", "sendReviewAt", "broadcastsPausedByOperatorAt", "system"] as const)(
  "skips %s for both support windows and pending-domain reminders",
  async (guard) => {
    await db
      .update(schema.teams)
      .set(guard === "system" ? { plan: "system" } : { [guard]: at(1) })
      .where(eq(schema.teams.id, teamId));
    await db.insert(schema.domains).values({
      teamId,
      name: "mail.example.invalid",
      region: "us-east-1",
      status: "pending",
      createdAt: at(-5),
    });
    expect(await sweep(2)).toBe(0);
    expect(await sweep(21)).toBe(0);
    expect(await sweep(168)).toBe(0);
    expect(sends).toEqual([]);
    expect(await claims()).toEqual([]);
  },
);

it("filters verification and activation preference per recipient, without consuming a claim for no recipients", async () => {
  await db.update(schema.user).set({ emailVerified: false }).where(eq(schema.user.id, "owner"));
  await owner("optedout", { mailOptOuts: ["activation"] });
  expect(await sweep(2)).toBe(0);
  expect(await claims()).toEqual([]);
  await owner("verified");
  expect(await sweep(3)).toBe(1);
  expect(sends.map((m) => m.to)).toEqual(["verified@example.invalid"]);
  expect(mailPreferenceOf("activation.first_email")).toBe("activation");
  expect(mailPreferenceOf("activation.day7")).toBe("activation");
});

it("renders PT-BR support with the real own-recipient route and preserves the existing DNS reminder", async () => {
  vi.stubEnv("AUTH_EMAIL_FROM", "MepMail <account@mail.example.invalid>");
  const home = await createTeam(db, "home");
  await db.insert(schema.domains).values({
    teamId: home,
    name: "mail.example.invalid",
    region: "us-east-1",
    status: "verified",
  });
  await db
    .insert(schema.contacts)
    .values({ teamId: home, email: "owner@example.invalid", properties: { locale: "pt-BR" } });
  expect(await sweep(2)).toBe(1);
  expect(sends[0]?.subject).toBe("Seu primeiro e-mail com o MepMail em 2 minutos");
  expect(sends[0]?.text).toContain("Não precisa ativar o Free nem mudar o plano");
  expect(sends[0]?.html).toContain(`${base}/onboarding#first-email`);
  await db.insert(schema.domains).values({
    teamId,
    name: "pending.example.invalid",
    region: "us-east-1",
    status: "pending",
    createdAt: at(2),
  });
  expect(await sweep(9)).toBe(1);
  expect(sends.at(-1)?.kind).toBe("activation.finish_domain");
});

it("only runs support on cloud sweeps and deduplicates concurrent passes", async () => {
  const deps = { mailer, enqueueWebhook: async () => {}, appBaseUrl: base, now: at(2), ...cohort };
  expect(await sweepNotifications(db, { ...deps, isCloud: false })).toEqual({ sent: 0 });
  const results = await Promise.all([
    sweepNotifications(db, { ...deps, isCloud: true }),
    sweepNotifications(db, { ...deps, isCloud: true }),
  ]);
  expect(results.reduce((sum, result) => sum + result.sent, 0)).toBe(1);
  expect(sends.map((m) => m.kind)).toEqual(["activation.first_email"]);
});

it("existing Correio trial notice warns within 2 days once per actual end date, not for active or ended trials", async () => {
  const extension = fileURLToPath(
    new URL("../../../packages/db/mailbox-drizzle/", import.meta.url),
  );
  for (const file of readdirSync(extension)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    for (const statement of readFileSync(`${extension}/${file}`, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean)) {
      await db.execute(sql.raw(statement));
    }
  }
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "trialing",
    seats: 1,
    storageBytesPerMailbox: 1024,
    includedOutboundPerMailbox: 100,
    periodStart: created,
    periodEnd: at(7 * 24),
  });
  const run = (hours: number) =>
    warnEndingMailboxTrials(db, { mailer, appBaseUrl: base, now: at(hours) });
  expect(await run(24 * 5 - 0.01)).toEqual({ sent: 0 });
  expect(await run(24 * 5)).toEqual({ sent: 1 });
  expect(await run(24 * 6)).toEqual({ sent: 0 });
  expect(sends[0]?.kind).toBe("mailbox.trial_ending");
  expect(sends[0]?.text).toContain(`${base}/settings/billing`);
  expect(sends[0]?.text).toContain("cancel Mail in Billing");
  expect(await run(24 * 7)).toEqual({ sent: 0 });
  await db
    .update(schema.mailboxSubscriptions)
    .set({ status: "active", periodEnd: at(24 * 8) })
    .where(eq(schema.mailboxSubscriptions.teamId, teamId));
  expect(await run(24 * 6)).toEqual({ sent: 0 });
  await db
    .update(schema.mailboxSubscriptions)
    .set({ status: "trialing" })
    .where(eq(schema.mailboxSubscriptions.teamId, teamId));
  expect(await run(24 * 6)).toEqual({ sent: 1 });
});

it("existing paid activation is claimed once and states Stripe owns receipts, with no fiscal-document or delivery deadline claim", async () => {
  const before = { plan: "free" as const, planQuota: null, currentPeriodEnd: null, cancelAt: null };
  const after = {
    plan: "pro" as const,
    planQuota: null,
    currentPeriodEnd: at(24 * 30),
    cancelAt: null,
  };
  const team = { id: teamId, name: "support-team" };
  expect(await reportPlanMove(db, mailer, base, team, before, after)).toBe(true);
  expect(await reportPlanMove(db, mailer, base, team, before, after)).toBe(false);
  expect(sends.map((m) => m.kind)).toEqual(["billing.plan_activated"]);
  expect(sends[0]?.text).toContain("Receipts and invoices come from Stripe");
  for (const locale of ["en", "pt-BR"] as const) {
    const reinstated = buildAccountMail({
      kind: "team.reinstated",
      locale,
      url: base,
      values: { team: "Example" },
    });
    const held = buildAccountMail({
      kind: "review.held",
      locale,
      url: base,
      values: { team: "Example", note: "synthetic review" },
    });
    expect(`${reinstated.text} ${held.text}`).not.toMatch(
      /15 minut|resume on their own|retomam sozinhos/,
    );
    expect(reinstated.text).toMatch(
      locale === "en"
        ? /Revoked credentials are not restored/
        : /Credenciais revogadas não são restauradas/,
    );
    expect(held.text).toMatch(
      locale === "en"
        ? /other sending blocks may still apply/
        : /outros bloqueios de envio ainda podem se aplicar/,
    );
  }
});
