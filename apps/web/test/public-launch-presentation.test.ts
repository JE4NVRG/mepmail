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
  // The v2 home counts the real deliverability checks it advertises.
  CHECKS: (await import("../../../packages/core/src/email-insights")).CHECKS,
}));
// Pages read the language a URL names (?lang=) from the proxy header; none here.
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
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
  DocsLink: ({ href, children }: { href: string; children: unknown }) =>
    createElement("a", { href }, children as string),
  GithubLink: ({ href, children }: { href: string; children: unknown }) =>
    createElement("a", { href }, children as string),
}));
vi.mock("@/components/public-starter-gallery", () => ({ PublicStarterGallery: () => null }));
vi.mock("@/components/stack-logos", () => ({ StackLogoRow: () => null }));
vi.mock("@/components/code-demo", () => ({ CodeDemo: () => null }));

const { default: Home, generateMetadata: homeMetadata } = await import("../src/app/page");
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
      // The legacy Pro rung: US$ 20, or R$ 99 on Brazil's price list.
      expect(html).toContain(locale === "pt-BR" ? '<p class="gtm-price">R$ 99<span>' : "US$ 20");
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
      expect(html.includes(locale === "pt-BR" ? "R$ 149" : "US$ 29")).toBe(true);
      expect(html.includes(locale === "pt-BR" ? "R$ 99" : "US$ 20")).toBe(true);
      expect(html).toContain(messages(locale).landing.plans.launchPriceNote);
      expect(html).toContain(messages(locale).landing.compare.intro);
      expect(html).toContain(messages(locale).landing.calc.note);
      const alternative = await render(Alternative);
      expect(alternative).toContain(messages(locale).alternatives.claim.body);
      expect(alternative.includes("2026-10-16") || alternative.includes("16/10/2026")).toBe(true);
      expect(alternative).not.toContain("78%");
    });

    it("presents Correio on the home and on /pricing only while Mail is open", async () => {
      current.locale = locale;
      const landing = messages(locale).landing.correio;
      const pricing = messages(locale).pricing.correio;
      const [small, large] = locale === "en" ? ["US$ 5.90", "US$ 9.90"] : ["US$ 5,90", "US$ 9,90"];

      vi.stubEnv("MAILBOX_EARLY_ACCESS_OPEN", "false");
      expect(await render(Home)).not.toContain('id="correio"');
      expect(await render(Pricing)).not.toContain('id="correio"');

      vi.stubEnv("MAILBOX_EARLY_ACCESS_OPEN", "true");
      const home = await render(Home);
      expect(home).toContain('id="correio"');
      expect(home).toContain(landing.title);
      expect(home).toContain(small);
      expect(home).toContain('href="/correio"');
      expect(home).toContain('href="/pricing#correio"');
      expect(home).toContain(messages(locale).correio.demo.awaiting);
      const page = await render(Pricing);
      expect(page).toContain('id="correio"');
      expect(page).toContain(pricing.title);
      expect(page).toContain(small);
      expect(page).toContain(large);
    });

    it("shows starting prices in the hero and puts Mail before Send unless a Send campaign leads", async () => {
      current.locale = locale;
      vi.stubEnv("MAILBOX_EARLY_ACCESS_OPEN", "true");
      vi.stubEnv("MAILBOX_STANDALONE_OPEN", "true");
      const html = await render(Pricing);
      const intro = html.slice(html.indexOf('<main id="conteudo">'), html.indexOf("</section>"));
      expect(intro.includes(locale === "pt-BR" ? "R$ 14,90" : "US$ 2.90")).toBe(true);
      expect(intro.includes(locale === "pt-BR" ? "R$ 0" : "US$ 0")).toBe(true);
      expect(html.indexOf('id="correio"')).toBeLessThan(html.indexOf('id="planos"'));
      expect(html.includes('<details class="pricing-usage-details">')).toBe(true);
      const send = await render(() =>
        Pricing({ searchParams: Promise.resolve({ focus: "send" }) }),
      );
      expect(send.indexOf('id="planos"')).toBeLessThan(send.indexOf('id="correio"'));
    });

    it("splits the v2 home between Correio and Envio while Mail sells on its own", async () => {
      current.locale = locale;
      const copy = messages(locale).landing;
      const home2 = copy.home;
      vi.stubEnv("MAILBOX_EARLY_ACCESS_OPEN", "true");
      vi.stubEnv("MAILBOX_STANDALONE_OPEN", "true");
      const home = await render(Home);
      const headings = home.match(/<h1[\s>][\s\S]*?<\/h1>/g) ?? [];
      expect(headings).toHaveLength(1);
      // One headline, Correio's, with a non-breaking hyphen in "e-mail".
      const title = (headings[0] ?? "").replace(/<[^>]+>/g, "");
      expect(title).not.toMatch(/\p{L}-\p{L}/u);
      expect(title.replace(/‑/g, "-")).toBe(home2.correio.title);
      // Two doors: Correio first, then Envio, each with its own pitch.
      expect(home.match(/class="v2-door[ "]/g)).toHaveLength(2);
      expect(home.indexOf(home2.correio.lead)).toBeLessThan(home.indexOf(home2.envio.title));
      expect(home).toContain(home2.envio.title);
      // Portuguese readers get Brazil's price list: the Correio from R$ 14,90.
      expect(home).toContain(locale === "en" ? "US$ 2.90" : "R$ 14,90");
      expect(home).toContain(messages(locale).correio.demo.awaiting);
      // The first screen prices Equipe against AgentMail's dated Developer tier.
      const hero = home.slice(0, home.indexOf('aria-label="' + home2.doorsAria + '"'));
      expect(hero).toContain("AgentMail");
      expect(hero).toContain(locale === "en" ? "US$ 12.90" : "R$ 64,90");
      expect(hero).toContain(locale === "en" ? "US$ 20" : "R$ 101");
      // The counts come from the code they describe, never typed into the copy.
      const { CHECKS } = await import("../../../packages/core/src/email-insights");
      const { MCP_TOOLS } = await import("../../../packages/core/src/mcp-tools");
      expect(home).toContain(`<span class="v2-stat-num">${CHECKS.length}</span>`);
      expect(home).toContain(`<span class="v2-stat-num">${MCP_TOOLS.length}</span>`);
      expect(JSON.stringify(home2)).not.toMatch(/\b(?:21|79)\b/);
      // Correio before Envio, both before the two price ladders.
      expect(home.indexOf('id="correio"')).toBeLessThan(home.indexOf('id="envio"'));
      expect(home.indexOf('id="envio"')).toBeLessThan(home.indexOf('id="planos"'));
      const ladders = home.slice(home.indexOf('id="planos"'));
      for (const price of locale === "en"
        ? ["US$ 2.90", "US$ 5.90", "US$ 12.90", "US$ 0"]
        : ["R$ 14,90", "R$ 29,90", "R$ 64,90", "R$ 0"])
        expect(ladders).toContain(price);
      for (const href of ["#envio", "/correio", "/envio", "/pricing#correio", "/pricing#cenarios"])
        expect(home).toContain(`href="${href}"`);
      // The anchors earlier links and campaigns point at still land somewhere.
      for (const id of ["product", "mcp", "planos", "comparativo", "como-funciona"])
        expect(home).toContain(`id="${id}"`);
      expect(home.match(/id="correio"/g)).toHaveLength(1);
      expect(home).not.toContain(copy.correio.title);
      expect(home).not.toContain("200 OK");
      expect((await homeMetadata()).title).toEqual({ absolute: copy.meta.domainTitle });

      vi.stubEnv("MAILBOX_STANDALONE_OPEN", "false");
      const earlier = await render(Home);
      expect(earlier).not.toContain(home2.correio.title);
      expect(earlier).not.toContain('id="envio"');
      expect((await homeMetadata()).title).toEqual({ absolute: copy.meta.title });
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
      // Correio is its own app at /mail (the old /mailboxes path redirects there).
      expect(html).toContain('href="/mail"');
      expect(html).not.toContain(messages(locale).correio.hero.status);
      expect(html).not.toContain(messages(locale).correio.preview.status);
      expect(html).not.toMatch(/MAILBOX_EARLY_ACCESS_OPEN|teamId|customerId|subscriptionId/);
      expect((await mailMetadata()).robots).toEqual({ index: true, follow: true });
    });
  });
}
