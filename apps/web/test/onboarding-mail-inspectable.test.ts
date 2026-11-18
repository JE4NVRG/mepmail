import { randomBytes, randomUUID } from "node:crypto";
import type { AbuseJudge, JudgeVerdict } from "@millionsend/core";
import { accountMailCard } from "@millionsend/core/html";
import { describe, expect, it, vi } from "vitest";
import { buildOnboardingEmail } from "@/server/onboarding-mail";
import { projectDispatchHtml } from "../../../packages/core/src/dispatch-html-projection.js";
import { rewriteForTracking } from "../../../packages/core/src/link-tracking.js";
import {
  bindDispatchTracking,
  type DispatchContentSnapshot,
  qualifyDispatchContent,
} from "../../../packages/core/src/pre-dispatch-content.js";

/**
 * The first email a Cloud team sends goes through the same pre-dispatch
 * qualification as customer mail: the projection must read the body, or the
 * judge is never consulted and the message is parked as uninspectable. These
 * cases exercise the real builder, the real projection and the real
 * qualifier; only the judge verdict is synthetic.
 */

const cleanVerdict: JudgeVerdict = {
  score: 2,
  verdict: "clean",
  categories: [],
  reasons: [],
  impersonatedBrand: null,
  language: "en",
};

const team = {
  name: "Team",
  plan: "starter" as const,
  ageDays: 2,
  verifiedDomains: [] as string[],
};

function syntheticJudge(verdict: JudgeVerdict = cleanVerdict) {
  const judged = vi.fn(async () => ({ ...verdict }));
  const judge: AbuseJudge = { provider: "openai", model: "synthetic-clean", judge: judged };
  return { judge, calls: () => judged.mock.calls.length };
}

function snapshot(input: {
  html: string;
  text: string;
  subject: string;
  emailId?: string;
  sourceHtml?: string;
}): DispatchContentSnapshot {
  return {
    teamId: randomUUID(),
    emailId: input.emailId ?? randomUUID(),
    from: "MepMail <hello@mepmail.dev>",
    to: ["ada@example.com"],
    cc: null,
    bcc: null,
    replyTo: null,
    subject: input.subject,
    sourceHtml: input.sourceHtml ?? input.html,
    sourceText: input.text,
    html: input.html,
    text: input.text,
    headers: {},
    attachments: false,
    mime: Buffer.from(`Subject: ${input.subject}\r\n\r\n${input.text}`),
  };
}

describe("onboarding first email reaches the content judge", () => {
  it.each(["en", "pt-BR"] as const)(
    "%s: real body is inspectable and judged with and without the dashboard link",
    async (locale) => {
      for (const dashboardUrl of ["https://mepmail.dev/emails", null]) {
        const mail = buildOnboardingEmail({ locale, team: "Team", dashboardUrl });
        // The projection is the gate that decides inspectability: no partial read.
        expect(projectDispatchHtml(mail.html)).not.toBeNull();
        const judge = syntheticJudge();
        const decision = await qualifyDispatchContent(
          snapshot({ html: mail.html, text: mail.text, subject: mail.subject }),
          team,
          judge.judge,
        );
        expect(decision).toMatchObject({ allowed: true });
        expect(judge.calls()).toBe(1);
      }
    },
  );

  it("keeps the product copy, the dashboard link and the team footer in the judged text", async () => {
    const mail = buildOnboardingEmail({
      locale: "pt-BR",
      team: "Equipe Aurora",
      dashboardUrl: "https://mepmail.dev/emails",
    });
    const projected = projectDispatchHtml(mail.html);
    expect(projected).not.toBeNull();
    expect(projected).toContain("Seu e-mail de teste está aqui.");
    expect(projected).toContain("Acompanhe o status no painel.");
    expect(projected).toContain("Abrir o painel");
    expect(projected).toContain("Equipe Aurora");
    expect(projected).toContain("Link destination: https://mepmail.dev/emails");
    expect(projected).toContain("Link destination: https://mepmail.dev/");
    expect(mail.text).toContain("Abrir o painel: https://mepmail.dev/emails");
  });

  it("stays inspectable through the worker's click and open rewrite", async () => {
    const mail = buildOnboardingEmail({
      locale: "en",
      team: "Team",
      dashboardUrl: "https://mepmail.dev/emails",
    });
    const emailId = randomUUID();
    const options = {
      emailId,
      trackingBaseUrl: "https://track.mepmail.dev",
      click: true,
      open: true,
      secretKey: randomBytes(32),
    };
    const tracked = rewriteForTracking(mail.html, options);
    // The worker snapshots the pre-tracking body as sourceHtml and the rewritten
    // one as html; the projection binds the exact pair it rewrote.
    const value = snapshot({
      html: tracked,
      sourceHtml: mail.html,
      text: mail.text,
      subject: mail.subject,
      emailId,
    });
    bindDispatchTracking(value, mail.html, options);
    const judge = syntheticJudge();
    const decision = await qualifyDispatchContent(value, team, judge.judge);
    expect(decision).toMatchObject({ allowed: true });
    expect(judge.calls()).toBe(1);
  });

  it("escapes the team name and the dashboard URL without losing inspectability", async () => {
    const mail = buildOnboardingEmail({
      locale: "en",
      team: '<img src=x onerror="alert(1)"> $& {team}',
      dashboardUrl: "https://mepmail.dev/emails?team=1&tab=all",
    });
    expect(mail.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; $&amp; {team}");
    expect(mail.html).not.toContain("<img src=x");
    expect(mail.html).toContain('href="https://mepmail.dev/emails?team=1&amp;tab=all"');
    // Canonical interpolation: the placeholder is filled once, `$&` stays literal.
    expect(mail.text).toContain('<img src=x onerror="alert(1)"> $& {team}');
    const projected = projectDispatchHtml(mail.html);
    expect(projected).not.toBeNull();
    expect(projected).toContain('<img src=x onerror="alert(1)"> $& {team}');
    const judge = syntheticJudge();
    const decision = await qualifyDispatchContent(
      snapshot({ html: mail.html, text: mail.text, subject: mail.subject }),
      team,
      judge.judge,
    );
    expect(decision).toMatchObject({ allowed: true });
    expect(judge.calls()).toBe(1);
  });

  it("drops an unverifiable dashboard base instead of making the body uninspectable", async () => {
    const mail = buildOnboardingEmail({
      locale: "en",
      team: "Team",
      dashboardUrl: 'https://mepmail.dev/emails?a=1&b="two"',
    });
    expect(mail.html).not.toContain('class="ms-btn"');
    expect(mail.text).not.toContain("Open the dashboard:");
    const judge = syntheticJudge();
    const decision = await qualifyDispatchContent(
      snapshot({ html: mail.html, text: mail.text, subject: mail.subject }),
      team,
      judge.judge,
    );
    expect(decision).toMatchObject({ allowed: true });
    expect(judge.calls()).toBe(1);
  });

  it("control: the shared account-mail card is uninspectable, so the judge is never called", async () => {
    const card = accountMailCard({
      locale: "en",
      homeUrl: "https://mepmail.dev",
      assetBaseUrl: "https://mepmail.dev",
      heading: "Your test email is here.",
      paragraphs: ["You requested this test in MepMail."],
      button: "Open the dashboard",
      url: "https://mepmail.dev/emails",
      muted: ["Test requested in MepMail."],
    });
    expect(projectDispatchHtml(card.html)).toBeNull();
    const judge = syntheticJudge();
    const decision = await qualifyDispatchContent(
      snapshot({ html: card.html, text: card.text, subject: "Your MepMail test email" }),
      team,
      judge.judge,
    );
    expect(decision).toMatchObject({ allowed: false, reason: "uninspectable" });
    expect(judge.calls()).toBe(0);
  });
});
