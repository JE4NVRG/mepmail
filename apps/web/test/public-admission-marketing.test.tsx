import { createTranslator } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import enCorreio from "../messages/en/correio.json";
import enEnvio from "../messages/en/envio.json";
import enLanding from "../messages/en/landing.json";
import enPricing from "../messages/en/pricing.json";
import ptCorreio from "../messages/pt-BR/correio.json";
import ptEnvio from "../messages/pt-BR/envio.json";
import ptLanding from "../messages/pt-BR/landing.json";
import ptPricing from "../messages/pt-BR/pricing.json";
import { publicMarketingMessages } from "../src/lib/public-message-scope";
import { publicSignupCopy } from "../src/lib/public-signup-copy";

const context = vi.hoisted(() => ({ locale: "en", availability: "open" }));
vi.mock("next-intl/server", () => ({
  getLocale: async () => context.locale,
  getTranslations: async (namespace: "pricing" | "landing" | "envio" | "correio" | "correio.v2") =>
    createTranslator({
      locale: context.locale,
      messages:
        context.locale === "pt-BR"
          ? { landing: ptLanding, pricing: ptPricing, envio: ptEnvio, correio: ptCorreio }
          : { landing: enLanding, pricing: enPricing, envio: enEnvio, correio: enCorreio },
      namespace,
    }),
}));
vi.mock("@/server/public-signup", () => ({
  publicSignupAvailability: async () => context.availability,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/pricing" }));
vi.mock("@/lib/analytics", () => ({
  trackEvent: () => {
    throw new Error("SSR must not emit analytics");
  },
}));
vi.mock("@/components/site-chrome", async () => {
  const { SignupCta } = await import("../src/components/signup-cta");
  return {
    PublicHeader: () => null,
    PublicFooter: () => null,
    SignupLink: (props: { label: string }) => createElement(SignupCta, props),
  };
});
vi.mock("@/components/public-events", () => ({
  DocsLink: "a",
  GithubLink: "a",
  McpConfigCopy: () => null,
}));
vi.mock("@/components/public-starter-gallery", () => ({ PublicStarterGallery: () => null }));
vi.mock("@/components/integration-tabs", () => ({ IntegrationTabs: () => null }));
vi.mock("@/components/structured-data", () => ({ StructuredData: () => null }));
vi.mock("@/server/public-seo", () => ({
  publicPageUrls: async () => ({ url: "/pricing", alternates: {}, ogLocale: "en_US" }),
}));

import { CorreioV2 } from "../src/app/correio/correio-v2";
import EnvioPage from "../src/app/envio/page";
import PricingPage from "../src/app/pricing/page";
import { publicMarketingAdmission } from "../src/server/public-marketing-admission";

const pages = [
  ["pricing-send", () => PricingPage({ searchParams: Promise.resolve({}) })],
  ["pricing-mail", () => PricingPage({ searchParams: Promise.resolve({ focus: "mail" }) })],
  ["send", EnvioPage],
  ["mail", CorreioV2],
] as const;

describe("public admission: actual public consumers", () => {
  afterEach(() => vi.unstubAllEnvs());
  for (const locale of ["en", "pt-BR"]) {
    for (const [page, render] of pages) {
      it(`${locale} ${page}: purchase pause and signup pause close every acquisition link`, async () => {
        context.locale = locale;
        for (const [purchasePaused, signup] of [
          ["true", "open"],
          ["false", "paused"],
        ]) {
          context.availability = signup;
          vi.stubEnv("NEW_SUBSCRIPTIONS_PAUSED", purchasePaused);
          vi.stubEnv("MAILBOX_EARLY_ACCESS_OPEN", "true");
          vi.stubEnv("MAILBOX_STANDALONE_OPEN", "true");
          const html = renderToStaticMarkup(await render());
          const copy = publicSignupCopy(locale);
          expect(html).toContain(copy.check);
          expect(html).toContain(copy.admissionBody);
          expect(html).not.toContain('href="/signup');
          expect(html).not.toContain('data-funnel-signup="1"');
          expect(html).toContain('href="/status#admission"');
          expect(html).not.toMatch(
            />\s*(Start free|Start on|Choose|Subscribe to Mail|Começar grátis|Começar no|Escolher|Assinar o Correio)\s*</,
          );
        }
      });
      it(`${locale} ${page}: open admission retains signup and the published catalog`, async () => {
        context.locale = locale;
        context.availability = "open";
        vi.stubEnv("NEW_SUBSCRIPTIONS_PAUSED", "false");
        vi.stubEnv("MAILBOX_EARLY_ACCESS_OPEN", "true");
        vi.stubEnv("MAILBOX_STANDALONE_OPEN", "true");
        const html = renderToStaticMarkup(await render());
        expect(html).toContain('href="/signup');
        expect(html).not.toContain(publicSignupCopy(locale).admissionBody);
        expect(html).toContain(locale === "pt-BR" ? "R$" : "US$");
      });
    }
  }
  it("paused serialization omits inactive marketing without mutating open messages", () => {
    for (const locale of ["en", "pt-BR"]) {
      const open = publicMarketingMessages("/pricing", locale)!;
      const closed = publicMarketingMessages("/pricing", locale, true)!;
      expect(closed.landing).toHaveProperty("account");
      expect(closed.landing).not.toHaveProperty("plans");
      expect(closed.correio).toEqual({});
      expect(open.landing).toHaveProperty("plans");
      expect(closed.auth).toEqual(open.auth);
    }
  });
  it("the server combines independent authoritative gates without changing either", async () => {
    context.availability = "open";
    vi.stubEnv("NEW_SUBSCRIPTIONS_PAUSED", "1");
    expect((await publicMarketingAdmission("en")).closed).toBe(true);
    vi.stubEnv("NEW_SUBSCRIPTIONS_PAUSED", "false");
    expect((await publicMarketingAdmission("en")).closed).toBe(false);
    context.availability = "full";
    expect((await publicMarketingAdmission("en")).closed).toBe(true);
  });
});
