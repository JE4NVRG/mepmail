import { createTranslator } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import enCorreio from "../messages/en/correio.json";
import enEnvio from "../messages/en/envio.json";
import enLanding from "../messages/en/landing.json";
import enPricing from "../messages/en/pricing.json";
import enStatus from "../messages/en/status.json";
import ptCorreio from "../messages/pt-BR/correio.json";
import ptEnvio from "../messages/pt-BR/envio.json";
import ptLanding from "../messages/pt-BR/landing.json";
import ptPricing from "../messages/pt-BR/pricing.json";
import ptStatus from "../messages/pt-BR/status.json";
import { publicMarketingMessages } from "../src/lib/public-message-scope";
import { publicSignupCopy } from "../src/lib/public-signup-copy";

const context = vi.hoisted(() => ({ locale: "en", availability: "open", signupUnavailable: false }));
vi.mock("next-intl/server", () => ({
  getLocale: async () => context.locale,
  getTranslations: async (namespace: "pricing" | "landing" | "envio" | "correio" | "correio.v2" | "status") =>
    createTranslator({
      locale: context.locale,
      messages:
        context.locale === "pt-BR"
          ? { landing: ptLanding, pricing: ptPricing, envio: ptEnvio, correio: ptCorreio, status: ptStatus }
          : { landing: enLanding, pricing: enPricing, envio: enEnvio, correio: enCorreio, status: enStatus },
      namespace,
    }),
}));
vi.mock("@/server/public-signup", () => ({
  publicSignupAvailability: async () => {
    if (context.signupUnavailable) throw new Error("Signup availability unavailable");
    return context.availability;
  },
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
    SignupLink: (props: Parameters<typeof SignupCta>[0]) => createElement(SignupCta, props),
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

vi.mock("@/lib/public-status", () => ({
  readPublicStatus: async () => ({ checkedAt: "2026-11-17T12:00:00Z", checks: [] }),
}));

import { CorreioV2 } from "../src/app/correio/correio-v2";
import EnvioPage from "../src/app/envio/page";
import PricingPage from "../src/app/pricing/page";
import StatusPage from "../src/app/status/page";
import { publicMarketingAdmission } from "../src/server/public-marketing-admission";

const pages = [
  ["pricing-send", () => PricingPage({ searchParams: Promise.resolve({}) })],
  ["pricing-mail", () => PricingPage({ searchParams: Promise.resolve({ focus: "mail" }) })],
  ["send", EnvioPage],
  ["mail", CorreioV2],
] as const;

const signupHrefs = (html: string) =>
  [...html.matchAll(/href="(\/signup[^"]*)"/g)].map((match) => match[1]);

describe("public admission: actual public consumers", () => {
  afterEach(() => {
    context.signupUnavailable = false;
    vi.unstubAllEnvs();
  });
  for (const locale of ["en", "pt-BR"]) {
    const marketingPages = [
      ...pages.map(([page, render]) => ({ page, render })),
      { page: "status", render: StatusPage },
    ];
    for (const { page, render } of marketingPages) {
      it(`${locale} ${page}: purchase pause keeps only plain Free signup on entry pages`, async () => {
        context.locale = locale;
        context.availability = "open";
        vi.stubEnv("NEW_SUBSCRIPTIONS_PAUSED", "true");
        vi.stubEnv("MAILBOX_EARLY_ACCESS_OPEN", "true");
        vi.stubEnv("MAILBOX_STANDALONE_OPEN", "true");
        vi.stubEnv("SEND_LAUNCH_OFFER_ENABLED", "true");
        const html = renderToStaticMarkup(await render());
        const entryPage = page !== "send" && page !== "mail";
        expect([...new Set(signupHrefs(html))]).toEqual(entryPage ? ["/signup"] : []);
        if (entryPage) {
          expect(html).toContain(
            locale === "pt-BR" ? "Criar conta gratuita" : "Create a free account",
          );
        }
        expect(html).toContain(
          locale === "pt-BR"
            ? "Novas assinaturas e testes estão pausados."
            : "New subscriptions and trials are paused.",
        );
        expect(html).not.toContain(publicSignupCopy(locale).admissionBody);
        expect(html).not.toMatch(/data-funnel-product="mail"|data-funnel-plan="(?!free")/);
        expect(html).not.toMatch(/href="[^"]*(?:checkout|settings(?:%2F|\/)billing|setup(?:%3D|=)correio)/i);
      });
      it.each([
        ["true", "paused"],
        ["false", "paused"],
        ["true", "full"],
      ])(
        `${locale} ${page}: no signup link with purchases paused=%s and signup=%s`,
        async (purchasePaused, signup) => {
          context.locale = locale;
          context.availability = signup;
          vi.stubEnv("NEW_SUBSCRIPTIONS_PAUSED", purchasePaused);
          vi.stubEnv("MAILBOX_EARLY_ACCESS_OPEN", "true");
          vi.stubEnv("MAILBOX_STANDALONE_OPEN", "true");
          const html = renderToStaticMarkup(await render());
          expect(signupHrefs(html)).toEqual([]);
          expect(html).not.toContain('data-funnel-signup="1"');
          const copy = publicSignupCopy(locale);
          if (purchasePaused === "true" && signup === "paused") {
            expect(html).toContain(copy.admissionBody);
          } else if (purchasePaused === "false") {
            expect(html).toContain(copy.pausedBody);
          }
        },
      );
    }
    it(`${locale} status: stays readable without an authoritative signup hint`, async () => {
      context.locale = locale;
      context.signupUnavailable = true;
      vi.stubEnv("NEW_SUBSCRIPTIONS_PAUSED", "true");
      const html = renderToStaticMarkup(await StatusPage());
      expect(signupHrefs(html)).toEqual([]);
      expect(html).toContain('id="admission"');
      expect(html).toContain('href="/login"');
      expect(html).not.toContain(publicSignupCopy(locale).admissionBody);
    });
    for (const [page, render] of pages) {
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
  it("the server keeps paid acquisition closed independently of Free eligibility", async () => {
    context.availability = "open";
    vi.stubEnv("NEW_SUBSCRIPTIONS_PAUSED", "1");
    expect(await publicMarketingAdmission("en")).toMatchObject({ closed: true });
    expect((await publicMarketingAdmission("en")).freeLabel).toBe("Create a free account");
    vi.stubEnv("NEW_SUBSCRIPTIONS_PAUSED", "false");
    expect((await publicMarketingAdmission("en")).closed).toBe(false);
    context.availability = "full";
    expect(await publicMarketingAdmission("en")).toMatchObject({ closed: true });
  });
});
