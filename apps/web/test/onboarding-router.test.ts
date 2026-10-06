import { randomBytes } from "node:crypto";
import { hashRecipient } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOnboardingEmail } from "@/server/onboarding-mail";
import { createCaller } from "@/server/routers";
import type { Context } from "@/server/trpc";

process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString("base64");

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  vi.stubEnv("UMAMI_ENDPOINT", "");
  vi.stubEnv("UMAMI_WEBSITE_ID", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await close();
});

function caller(teamId: string, enqueued: string[] = [], enqueue?: Context["enqueueEmailSend"]) {
  const ctx: Context = {
    db,
    session: { user: { id: "u1", email: "Ada@Example.com", name: "Ada" } },
    teamId,
    role: "owner",
    enqueueEmailSend: async (id) => {
      await enqueue?.(id);
      enqueued.push(id);
    },
  };
  return createCaller(ctx);
}

describe("onboarding.sendFirstEmail", () => {
  it("accepts the shared sender to the member's own inbox in the asked locale", async () => {
    vi.stubEnv("ONBOARDING_EMAIL_FROM", "MillionSend <onboarding@ms.example>");
    const teamId = await createTeam(db, "team-a");
    const enqueued: string[] = [];

    const { id } = await caller(teamId, enqueued).onboarding.sendFirstEmail({ locale: "pt-BR" });

    const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
    expect(row).toMatchObject({
      teamId,
      domainId: null,
      apiKeyId: null,
      from: "MillionSend <onboarding@ms.example>",
      to: ["Ada@Example.com"],
      subject: "Seu e-mail de teste do MepMail",
      latestStatus: "queued",
    });
    expect(enqueued).toEqual([id]);
  });

  it("caps onboarding sends per team and refuses a missing captcha token when Turnstile is on", async () => {
    vi.stubEnv("ONBOARDING_EMAIL_FROM", "MillionSend <onboarding@ms.example>");
    const teamId = await createTeam(db, "team-a");
    const c = caller(teamId);
    for (let i = 0; i < 5; i++) await c.onboarding.sendFirstEmail({ locale: "en" });
    await expect(c.onboarding.sendFirstEmail({ locale: "en" })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });

    vi.stubEnv("TURNSTILE_SITE_KEY", "0x4AAA");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "0x4BBB");
    await expect(
      caller(await createTeam(db, "team-b")).onboarding.sendFirstEmail({ locale: "en" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("is unavailable when no shared sender is configured", async () => {
    vi.stubEnv("ONBOARDING_EMAIL_FROM", "");
    const teamId = await createTeam(db, "team-a");
    await expect(caller(teamId).onboarding.sendFirstEmail({ locale: "en" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("accepts only the remaining hourly slot under concurrent same-team requests", async () => {
    vi.stubEnv("ONBOARDING_EMAIL_FROM", "MillionSend <onboarding@ms.example>");
    const teamId = await createTeam(db, "hour-race");
    const enqueued: string[] = [];
    const c = caller(teamId, enqueued);
    for (let i = 0; i < 4; i++) await c.onboarding.sendFirstEmail({ locale: "en" });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => c.onboarding.sendFirstEmail({ locale: "en" })),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    }
    expect(
      await db.select().from(schema.emails).where(eq(schema.emails.teamId, teamId)),
    ).toHaveLength(5);
    expect(enqueued).toHaveLength(5);
  });

  it("serializes the daily limit while different teams keep their own allowance", async () => {
    vi.stubEnv("ONBOARDING_EMAIL_FROM", "MillionSend <onboarding@ms.example>");
    const teamId = await createTeam(db, "day-race");
    const c = caller(teamId);
    for (let i = 0; i < 19; i++) {
      await c.onboarding.sendFirstEmail({ locale: "en" });
      await db
        .update(schema.emails)
        .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
        .where(eq(schema.emails.teamId, teamId));
    }
    const otherTeam = await createTeam(db, "independent");
    const results = await Promise.allSettled([
      ...Array.from({ length: 4 }, () => c.onboarding.sendFirstEmail({ locale: "en" })),
      caller(otherTeam).onboarding.sendFirstEmail({ locale: "en" }),
    ]);
    expect(results.slice(0, 4).filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results[4]?.status).toBe("fulfilled");
    for (const result of results.slice(0, 4)) {
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    }
    expect(
      await db.select().from(schema.emails).where(eq(schema.emails.teamId, teamId)),
    ).toHaveLength(20);
    expect(
      await db.select().from(schema.emails).where(eq(schema.emails.teamId, otherTeam)),
    ).toHaveLength(1);
  });

  it("rolls back the quota and email when the insert fails, without enqueueing", async () => {
    vi.stubEnv("ONBOARDING_EMAIL_FROM", "MillionSend <onboarding@ms.example>");
    const teamId = await createTeam(db, "rollback");
    const enqueued: string[] = [];
    await db.execute(sql`
      create function onboarding_fixture_reject_insert() returns trigger language plpgsql as $$
      begin raise exception 'onboarding fixture insert rejected'; end; $$
    `);
    await db.execute(sql`
      create trigger onboarding_fixture_reject_insert before insert on public.emails
      for each row execute function onboarding_fixture_reject_insert()
    `);
    const failure = await caller(teamId, enqueued)
      .onboarding.sendFirstEmail({ locale: "en" })
      .catch((error: unknown) => error);
    const messages: string[] = [];
    let cause: unknown = failure;
    for (let i = 0; i < 6 && cause instanceof Error; i++) {
      messages.push(cause.message);
      cause = cause.cause;
    }
    expect(messages.join(" ")).toContain("onboarding fixture insert rejected");
    expect(
      await db.select().from(schema.emails).where(eq(schema.emails.teamId, teamId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(schema.usageCounters).where(eq(schema.usageCounters.teamId, teamId)),
    ).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
    await db.execute(sql`drop trigger onboarding_fixture_reject_insert on public.emails`);
    await db.execute(sql`drop function onboarding_fixture_reject_insert()`);
    await expect(
      caller(teamId, enqueued).onboarding.sendFirstEmail({ locale: "en" }),
    ).resolves.toHaveProperty("id");
    expect(enqueued).toHaveLength(1);
  });

  it("hands the committed email to the queue only after the owning transaction resolves", async () => {
    vi.stubEnv("ONBOARDING_EMAIL_FROM", "MillionSend <onboarding@ms.example>");
    const teamId = await createTeam(db, "commit-before-enqueue");
    const originalTransaction = db.transaction.bind(db);
    let committed = false;
    vi.spyOn(db, "transaction").mockImplementation(async (...args) => {
      const result = await originalTransaction(...args);
      committed = true;
      return result;
    });
    const enqueued: string[] = [];
    const { id } = await caller(teamId, enqueued, async (emailId) => {
      expect(committed).toBe(true);
      expect(
        await db.select().from(schema.emails).where(eq(schema.emails.id, emailId)),
      ).toHaveLength(1);
    }).onboarding.sendFirstEmail({ locale: "en" });
    expect(enqueued).toEqual([id]);
  });

  it("preserves a committed accept when enqueue fails so reconcile can recover it", async () => {
    vi.stubEnv("ONBOARDING_EMAIL_FROM", "MillionSend <onboarding@ms.example>");
    const teamId = await createTeam(db, "queue-failure");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = vi.fn(async () => {
      throw new Error("fixture queue unavailable");
    });
    const { id } = await caller(teamId, [], queue).onboarding.sendFirstEmail({ locale: "en" });
    const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, id));
    expect(row).toMatchObject({ teamId, latestStatus: "queued" });
    expect(queue).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      "onboarding email enqueue failed; reconcile sweep will recover",
    );
    const [usage] = await db
      .select()
      .from(schema.usageCounters)
      .where(eq(schema.usageCounters.teamId, teamId));
    expect(usage?.accepted).toBe(1);
  });

  it("keeps suppression and team suspension effective without spending quota or enqueueing", async () => {
    vi.stubEnv("ONBOARDING_EMAIL_FROM", "MillionSend <onboarding@ms.example>");
    const teamId = await createTeam(db, "suppressed");
    const enqueued: string[] = [];
    await db.insert(schema.suppressions).values({
      teamId,
      email: "Ada@Example.com",
      emailHash: hashRecipient("Ada@Example.com"),
      reason: "manual",
    });
    await expect(
      caller(teamId, enqueued).onboarding.sendFirstEmail({ locale: "en" }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "all_suppressed",
    });
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.teams.id, teamId));
    await expect(
      caller(teamId, enqueued).onboarding.sendFirstEmail({ locale: "en" }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "team suspended",
    });
    expect(
      await db.select().from(schema.emails).where(eq(schema.emails.teamId, teamId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(schema.usageCounters).where(eq(schema.usageCounters.teamId, teamId)),
    ).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });
});

describe("buildOnboardingEmail", () => {
  it("uses the requested language and MepMail links without claiming inbox placement", () => {
    for (const locale of ["en", "pt-BR"] as const) {
      const mail = buildOnboardingEmail({
        locale,
        team: "Team",
        dashboardUrl: "https://mepmail.dev/emails",
      });
      expect(mail.subject).toContain("MepMail");
      expect(mail.html).toContain(`<html lang="${locale}">`);
      expect(mail.html).toContain('href="https://mepmail.dev/"');
      expect(mail.html).toContain('href="https://mepmail.dev/emails"');
      for (const name of ["wordmark-ink", "wordmark-bone", "white"]) {
        expect(mail.html).toContain(`https://mepmail.dev/email/${name}.png`);
      }
      expect(mail.html).not.toContain("mepmail.je4ndev.com");
      expect(mail.html).not.toContain("mail.je4ndev.com");
      expect(mail.text).not.toMatch(/inbox|caixa de entrada/i);
    }
  });

  it("escapes the team and dashboard link while preserving plain text and a missing CTA", () => {
    const mail = buildOnboardingEmail({
      locale: "pt-BR",
      team: '<img src=x onerror="alert(1)">',
      dashboardUrl: 'https://mepmail.dev/emails?a=1&b="two"',
    });
    expect(mail.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(mail.html).not.toContain("<img src=x");
    expect(mail.html).toContain('href="https://mepmail.dev/emails?a=1&amp;b=&quot;two&quot;"');
    expect(mail.text).toContain('<img src=x onerror="alert(1)">');
    const withoutUrl = buildOnboardingEmail({ locale: "en", team: "Team", dashboardUrl: null });
    expect(withoutUrl.html).not.toContain('class="ms-btn"');
    expect(withoutUrl.html).not.toContain('class="ms-gmail"');
  });
});
