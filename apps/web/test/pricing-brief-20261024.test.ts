import { readFileSync } from "node:fs";
import { createTranslator } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enLanding from "../messages/en/landing.json";
import enPricing from "../messages/en/pricing.json";
import ptLanding from "../messages/pt-BR/landing.json";
import ptPricing from "../messages/pt-BR/pricing.json";

const context = vi.hoisted(() => ({ locale: "en" }));
vi.mock("next-intl/server", () => ({
  getLocale: async () => context.locale,
  getTranslations: async (namespace: "pricing" | "landing") => {
    const messages =
      context.locale === "pt-BR"
        ? { pricing: ptPricing, landing: ptLanding }
        : { pricing: enPricing, landing: enLanding };
    return createTranslator({ locale: context.locale, messages, namespace });
  },
}));
// Render the page's SSR composition without client analytics or account state.
vi.mock("@/components/plan-card", () => ({
  PlanCard: ({ plan }: { plan: { name: string; price: string; copy: { volume: string } } }) =>
    createElement("article", null, plan.name, " ", plan.price, " ", plan.copy.volume),
}));
vi.mock("@/components/signup-cta", () => ({
  SignupCta: ({ label, rung }: { label: string; rung: string }) =>
    createElement("a", { href: rung === "free" ? "/signup" : `/signup?plan=${rung}` }, label),
}));
vi.mock("@/components/site-chrome", () => ({
  PublicHeader: () => null,
  PublicFooter: () => null,
  SignupLink: ({ label }: { label: string }) => createElement("a", { href: "/signup" }, label),
}));
vi.mock("@/components/structured-data", () => ({ StructuredData: () => null }));
vi.mock("@/server/public-seo", () => ({
  publicPageUrls: async () => ({
    url: "https://mepmail.dev/pricing",
    alternates: {},
    ogLocale: "en_US",
  }),
}));

import PricingPage from "../src/app/pricing/page";
import { ENTRY_PLAN_COMPARISON } from "../src/lib/entry-plan-comparison";

type Params = Record<string, string | string[] | undefined>;
async function render(params: Params = {}) {
  return renderToStaticMarkup(await PricingPage({ searchParams: Promise.resolve(params) }));
}
const source = readFileSync(new URL("../src/app/pricing/page.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/app/pricing/pricing.css", import.meta.url), "utf8");

describe("pricing brief 2026-10-24: server-rendered product choice", () => {
  beforeEach(() => {
    context.locale = "en";
    vi.stubEnv("MAILBOX_EARLY_ACCESS_OPEN", "true");
    vi.stubEnv("MAILBOX_STANDALONE_OPEN", "true");
    vi.stubEnv("SEND_LAUNCH_OFFER_ENABLED", "false");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([{}, { focus: "send" }, { focus: "unknown" }, { focus: ["mail", "send"] }])(
    "defaults to Send unless Mail is explicitly requested: %j",
    async (params) => {
      const html = await render(params);
      expect(html.indexOf('id="planos"')).toBeLessThan(html.indexOf('id="correio"'));
      expect(html).toContain('href="/pricing?focus=send#planos" aria-current="true"');
      expect(html).toContain(enPricing.choice.freeCta);
      expect(html).toContain("Starter: US$ 9/month for 1,500 emails/day");
    },
  );

  it("places Mail first for focus=mail, without hiding Send or changing its limits", async () => {
    const html = await render({ focus: "mail" });
    expect(html.indexOf('id="correio"')).toBeLessThan(html.indexOf('id="planos"'));
    expect(html).toContain('href="/pricing?focus=mail#correio" aria-current="true"');
    expect(html).toContain("Mail starts at US$ 2.90/month");
    expect(html).toContain("7-day trial needs a card");
    expect(html).toContain("100 emails/day with no card");
  });

  it("keeps locale and campaign query values when switching, with existing anchors", async () => {
    const html = await render({ lang: "pt-BR", utm_campaign: "send_launch", focus: "mail" });
    expect(html).toContain(
      "/pricing?lang=pt-BR&amp;utm_campaign=send_launch&amp;focus=send#planos",
    );
    expect(html).toContain(
      "/pricing?lang=pt-BR&amp;utm_campaign=send_launch&amp;focus=mail#correio",
    );
  });

  it.each(["en", "pt-BR"])(
    "has one collapsed queue/overage rule and working FAQ anchors in %s",
    async (locale) => {
      context.locale = locale;
      const html = await render();
      expect(html.match(/50%/g)).toHaveLength(1);
      expect(html.match(/3×/g)).toHaveLength(1);
      expect(html).toContain('href="#pricing-usage"');
      expect(html).toContain('id="pricing-usage"');
      expect(html).toContain('id="faq"');
      expect(html).toContain('id="pricing-faq-title"');
      expect(html).toContain('id="pricing-faq-4"');
    },
  );

  it("separates the Brazilian Mail/Pix price from Send and from the card-only trial", async () => {
    context.locale = "pt-BR";
    const html = await render({ focus: "mail" });
    expect(html).toContain("Correio a partir de R$ 14,90/mês no Pix ou cartão");
    expect(html).toContain("não de um plano de Envio");
    expect(html).toContain("O teste de 7 dias é só no cartão");
    expect(html).toContain("Starter: R$ 49/mês (US$ 9 em dólar)");
  });

  it("retains a real Mail anchor without bypassing the closed availability gate", async () => {
    vi.stubEnv("MAILBOX_EARLY_ACCESS_OPEN", "false");
    vi.stubEnv("MAILBOX_STANDALONE_OPEN", "false");
    const html = await render({ focus: "mail" });
    expect(html).toContain('id="correio"');
    expect(html).toContain(enPricing.choice.mailClosed);
    expect(html).not.toContain('href="/signup?next=%2Fsettings%2Fbilling%3FmailboxPlan');
    expect(html).not.toContain("Mail starts at US$ 2.90/month");
  });

  it("preserves eligible launch prices and annual/overage terms without creating a promotion", async () => {
    vi.stubEnv("SEND_LAUNCH_OFFER_ENABLED", "true");
    const html = await render();
    expect(html).toContain("US$ 29");
    expect(html).toContain("US$ 290");
    expect(html).toContain("110,000 allowance renews monthly");
    expect(html.match(/3×/g)).toHaveLength(1);
  });

  it("compares only cataloged recurring prices and does not sell Starter as a 50K plan", async () => {
    expect(ENTRY_PLAN_COMPARISON.map((row) => [row.volume, row.mepmailUsd, row.resendUsd])).toEqual(
      [
        [10_000, 9, 20],
        [50_000, 29, 20],
      ],
    );
    expect(ENTRY_PLAN_COMPARISON[0].minimumSendingDays).toBe(7);
    vi.stubEnv("SEND_LAUNCH_OFFER_ENABLED", "true");
    const html = await render();
    expect(html).toContain("https://resend.com/pricing.md");
    expect(html).toContain("2026-10-24");
    expect(html).toContain("Starter cannot promise 50k/month");
    expect(html).toContain("lower than MepMail Pro");
  });

  it("adds native links, not client tabs, with visible focus and responsive targets", () => {
    expect(source).not.toContain('"use client"');
    expect(source).not.toContain('role="tab"');
    expect(source).not.toContain("onClick=");
    expect(css).toContain(".pricing-focus a:focus-visible");
    expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(source.indexOf('className="v2-dark pricing-choice"')).toBeLessThan(
      source.indexOf("{sendFirst ? ("),
    );
  });
});
