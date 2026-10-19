import { createTranslator, NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enChangelog from "../messages/en/changelog.json";
import enCorreio from "../messages/en/correio.json";
import enIntegrations from "../messages/en/integrations.json";
import enLanding from "../messages/en/landing.json";
import enPricing from "../messages/en/pricing.json";
import ptChangelog from "../messages/pt-BR/changelog.json";
import ptCorreio from "../messages/pt-BR/correio.json";
import ptIntegrations from "../messages/pt-BR/integrations.json";
import ptLanding from "../messages/pt-BR/landing.json";
import ptPricing from "../messages/pt-BR/pricing.json";

// MepMail as one offer (2026-10-11): each integration names its credential, the Correio
// trial says it takes a card, pricing sums the separate plans by scenario, the home
// opens three ways in, and the changelog says what it actually shows.
type Locale = "en" | "pt-BR";
const current = vi.hoisted(() => ({ locale: "en" as Locale }));
const messages = (locale: Locale) =>
  locale === "en"
    ? {
        landing: enLanding,
        pricing: enPricing,
        correio: enCorreio,
        integrations: enIntegrations,
        changelog: enChangelog,
      }
    : {
        landing: ptLanding,
        pricing: ptPricing,
        correio: ptCorreio,
        integrations: ptIntegrations,
        changelog: ptChangelog,
      };

vi.mock("@millionsend/core", async () => ({
  PLAN_RUNGS: (await import("../../../packages/core/src/plans")).PLAN_RUNGS,
  // The v2 home counts the real deliverability checks it advertises.
  CHECKS: (await import("../../../packages/core/src/email-insights")).CHECKS,
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => current.locale,
  getTranslations: async (namespace: string) =>
    createTranslator({
      locale: current.locale,
      messages: messages(current.locale),
      namespace: namespace as never,
    }),
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
  DocsLink: ({ href, children }: { href: string; children: unknown }) =>
    createElement("a", { href }, children as string),
  GithubLink: ({ href, children }: { href: string; children: unknown }) =>
    createElement("a", { href }, children as string),
}));
vi.mock("@/components/public-starter-gallery", () => ({ PublicStarterGallery: () => null }));
vi.mock("@/components/stack-logos", () => ({ StackLogoRow: () => null }));
vi.mock("@/components/code-demo", () => ({ CodeDemo: () => null }));

const { default: Home } = await import("../src/app/page");
const { default: Pricing } = await import("../src/app/pricing/page");
const { default: Integrations } = await import("../src/app/integrations/page");
const { default: Changelog } = await import("../src/app/changelog/page");

async function render(page: () => Promise<ReturnType<typeof createElement>>) {
  const providerProps = {
    locale: current.locale,
    messages: messages(current.locale),
    children: await page(),
  };
  return renderToStaticMarkup(createElement(NextIntlClientProvider, providerProps)).replace(
    / /g,
    " ",
  );
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

beforeEach(() => {
  // The production switches on 2026-10-11.
  vi.stubEnv("SEND_LAUNCH_OFFER_ENABLED", "true");
  vi.stubEnv("MAILBOX_EARLY_ACCESS_OPEN", "true");
  vi.stubEnv("MAILBOX_STANDALONE_OPEN", "true");
});
afterEach(() => vi.unstubAllEnvs());

for (const locale of ["en", "pt-BR"] as const) {
  const pt = locale === "pt-BR";
  describe(`one offer in ${locale}`, () => {
    it("names the credential of every integration instead of one key for all", async () => {
      current.locale = locale;
      const html = await render(Integrations);
      const body = text(html);
      expect(body).not.toMatch(pt ? /Uma API key/ : /One API key/);
      for (const credential of ["ms_", "mmb_", "mmt_", "OAuth"]) expect(body).toContain(credential);
      const cards = messages(locale).integrations.cards.items.length;
      expect(html.match(/<article class="gtm-integration"/g)).toHaveLength(cards);
      expect(html.match(/<dl class="integration-access"/g)).toHaveLength(cards);
      expect(body).toContain("smtp.mepmail.dev");
      expect(body).not.toMatch(pt ? /Nenhum plugin/ : /No plugin/);
    });

    it("opens the home on two doors, Correio and Envio, and states the trial's card", async () => {
      current.locale = locale;
      const html = await render(Home);
      expect(html.match(/class="v2-door[ "]/g)).toHaveLength(2);
      expect(html).toContain('href="/pricing#cenarios"');
      const body = text(html);
      expect(body).toMatch(pt ? /7 dias grátis no cartão/ : /7 days free with a card/);
      expect(body).not.toMatch(pt ? /Uma API key/ : /One API key/);
    });

    it("sums the separate plans by scenario, explains counting and hides internal wording", async () => {
      current.locale = locale;
      const html = await render(Pricing);
      expect(html).toContain('id="cenarios"');
      const body = text(html);
      // Equipe + Envio Pro 110K: US$ 12.90 + US$ 29.00, or R$ 64,90 + R$ 149,00 in Brazil.
      expect(body).toContain(pt ? "R$ 213,90" : "US$ 41.90");
      expect(body).toMatch(pt ? /Como o uso é contado\?/ : /How is usage counted\?/);
      expect(body).toMatch(pt ? /Para, Cc e Cco/ : /To, Cc and Bcc/);
      expect(body).toMatch(
        pt ? /cobrança começa no fim do teste/ : /billing starts when the trial ends/,
      );
      expect(body).not.toMatch(/\bSystem\b|isent|exempt/i);
    });

    it("opens the latest releases and folds the rest, as its text says", async () => {
      current.locale = locale;
      const html = await render(Changelog);
      const releases = messages(locale).changelog.releases.length;
      expect(html.match(/<section class="gtm-section[^"]*" id="v/g)).toHaveLength(10);
      expect(html.match(/<details id="v/g)).toHaveLength(releases - 10);
      const body = text(html);
      expect(body).not.toMatch(pt ? /seis releases/ : /six most recent/);
      expect(body).not.toContain("CHANGELOG.md");
    });
  });
}
