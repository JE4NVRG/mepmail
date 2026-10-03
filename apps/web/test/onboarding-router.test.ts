import { randomBytes } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOnboardingEmail } from "@/server/onboarding-mail";
import { createCaller } from "@/server/routers";
import type { Context } from "@/server/trpc";

process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString("base64");

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

function caller(teamId: string, enqueued: string[] = []) {
  const ctx: Context = {
    db,
    session: { user: { id: "u1", email: "Ada@Example.com", name: "Ada" } },
    teamId,
    role: "owner",
    enqueueEmailSend: async (id) => {
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
