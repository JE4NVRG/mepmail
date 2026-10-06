import { createTranslator, NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import enAlternatives from "../messages/en/alternatives.json";
import enCorreio from "../messages/en/correio.json";
import enLanding from "../messages/en/landing.json";
import enPricing from "../messages/en/pricing.json";
import ptAlternatives from "../messages/pt-BR/alternatives.json";
import ptCorreio from "../messages/pt-BR/correio.json";
import ptLanding from "../messages/pt-BR/landing.json";
import ptPricing from "../messages/pt-BR/pricing.json";

type Locale = "en" | "pt-BR";
const current = vi.hoisted(() => ({ locale: "en" as Locale }));
const messages = (locale: Locale) =>
  locale === "en"
    ? { landing: enLanding, pricing: enPricing, alternatives: enAlternatives, correio: enCorreio }
    : { landing: ptLanding, pricing: ptPricing, alternatives: ptAlternatives, correio: ptCorreio };

// Framework/chrome/measurement boundaries only; the real pages, cards,
// calculator, approved offer and core legacy ladder all render below.
vi.mock("@millionsend/core", async () => ({
  PLAN_RUNGS: (await import("../../../packages/core/src/plans")).PLAN_RUNGS,
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => current.locale,
  getTranslations: async (namespace: "landing" | "pricing" | "alternatives" | "correio") =>
    createTranslator({ locale: current.locale, messages: messages(current.locale), namespace }),
}));
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/components/signup-cta", () => ({
  SignupCta: ({ label }: { label: string }) => createElement("a", { href: "/signup" }, label),
}));
vi.mock("@/components/site-chrome", () => ({
  PublicHeader: () => createElement("header", null, "MepMail"),
  PublicFooter: () => createElement("footer", null, "MepMail"),
  SignupLink: ({ label }: { label: string }) => createElement("a", { href: "/signup" }, label),
}));
vi.mock("@/components/landing-motion", () => ({ LandingMotion: () => null }));
vi.mock("@/components/integration-tabs", () => ({ IntegrationTabs: () => null }));
vi.mock("@/components/public-events", () => ({
  ArrivalTracker: () => null,
  McpConfigCopy: () => null,
}));
vi.mock("@/components/public-starter-gallery", () => ({ PublicStarterGallery: () => null }));
vi.mock("@/components/stack-logos", () => ({ StackLogoRow: () => null }));
vi.mock("@/components/code-demo", () => ({ CodeDemo: () => null }));

const { default: Home } = await import("../src/app/page");
const { default: Pricing, generateMetadata: pricingMetadata } = await import(
  "../src/app/pricing/page"
);
const { default: Alternative } = await import("../src/app/alternatives/resend/page");
const { default: Mail, generateMetadata: mailMetadata } = await import("../src/app/correio/page");

async function render(page: () => Promise<ReturnType<typeof createElement>>) {
  const providerProps = {
    locale: current.locale,
    messages: messages(current.locale),
    children: await page(),
  };
  return renderToStaticMarkup(createElement(NextIntlClientProvider, providerProps)).replace(
    /\u00a0/g,
    " ",
  );
}
afterEach(() => vi.unstubAllEnvs());

for (const locale of ["en", "pt-BR"] as const) {
  describe(`public pages in ${locale}`, () => {
    it("keeps the legacy monthly offer when launch is not enabled", async () => {
      current.locale = locale;
      vi.stubEnv("SEND_LAUNCH_OFFER_ENABLED", "false");
      const html = await render(Pricing);
      expect(html).toContain("US$ 20");
      expect(html).not.toContain('id="pro110k"');
      expect((await pricingMetadata()).description).toBe(messages(locale).pricing.meta.description);
    });

    it("renders 29 recurring, a qualified 20 introduction, and annual upfront monthly limits", async () => {
      current.locale = locale;
      vi.stubEnv("SEND_LAUNCH_OFFER_ENABLED", "true");
      const html = await render(Pricing);
      expect(html).toContain("US$ 29");
      expect(html).toContain("US$ 290");
      const copy = messages(locale).pricing.launch;
      expect(html).toContain(copy.yearQuota);
      expect(html).toContain(copy.preserved);
      expect(html).toContain(copy.monthIntro);
      expect((await pricingMetadata()).description).toBe(
        messages(locale).pricing.meta.launchDescription,
      );
      expect(html).not.toMatch(
        /price_[\w]+|sk_(?:live|test)|MAILBOX_EARLY_ACCESS_OPEN|SEND_LAUNCH_OFFER_ENABLED/,
      );
    });

    it("qualifies the landing introduction and labels competitor comparison as historical", async () => {
      current.locale = locale;
      vi.stubEnv("SEND_LAUNCH_OFFER_ENABLED", "true");
      const html = await render(Home);
      expect(html).toContain("US$ 29");
      expect(html).toContain("US$ 20");
      expect(html).toContain(messages(locale).landing.plans.launchPriceNote);
      expect(html).toContain(messages(locale).landing.compare.intro);
      expect(html).toContain(messages(locale).landing.calc.note);
      const alternative = await render(Alternative);
      expect(alternative).toContain(messages(locale).alternatives.claim.body);
      expect(alternative).toContain("2026-09-27");
      expect(alternative).not.toContain("78%");
    });

    it("holds Mail presentation closed by default, independent of registry availability", async () => {
      current.locale = locale;
      vi.stubEnv("MAILBOX_EARLY_ACCESS_OPEN", "false");
      vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "true");
      const html = await render(Mail);
      expect(html).toContain(messages(locale).correio.hero.status);
      expect(html).not.toContain(messages(locale).correio.release.checkAccess);
      expect((await mailMetadata()).robots).toEqual({ index: false, follow: true });
    });

    it("opens only the presentation flag, retaining account and domain activation requirements", async () => {
      current.locale = locale;
      vi.stubEnv("MAILBOX_EARLY_ACCESS_OPEN", "true");
      const html = await render(Mail);
      const copy = messages(locale).correio.release;
      expect(html).toContain(copy.heroStatus);
      expect(html).toContain(copy.mailNote);
      expect(html).toContain(copy.restStatus);
      expect(html).toContain(copy.checkAccess);
      expect(html).toContain('href="/mailboxes"');
      expect(html).not.toContain(messages(locale).correio.hero.status);
      expect(html).not.toContain(messages(locale).correio.preview.status);
      expect(html).not.toMatch(/MAILBOX_EARLY_ACCESS_OPEN|teamId|customerId|subscriptionId/);
      expect((await mailMetadata()).robots).toEqual({ index: true, follow: true });
    });
  });
}
