import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECKS } from "../../../packages/core/src/email-insights";
import { MCP_TOOLS } from "../../../packages/core/src/mcp-tools";
import { WEBHOOK_EVENT_TYPES } from "../../../packages/core/src/webhooks";
import enEnvio from "../messages/en/envio.json";
import enLanding from "../messages/en/landing.json";
import ptEnvio from "../messages/pt-BR/envio.json";
import ptLanding from "../messages/pt-BR/landing.json";
import { comparisonRowsForLocale, formatWholeComparisonPrice } from "../src/lib/landing-pricing";

type Locale = "en" | "pt-BR";
const current = vi.hoisted(() => ({ locale: "en" as Locale }));
const messages = (locale: Locale) =>
  locale === "en" ? { envio: enEnvio, landing: enLanding } : { envio: ptEnvio, landing: ptLanding };

// Framework, chrome and measurement boundaries only; the page, its cards, tabs and the
// real catalogs (plans, checks, MCP tools, webhook events, comparison) render below.
vi.mock("@millionsend/core", async () => ({
  CHECKS: (await import("../../../packages/core/src/email-insights")).CHECKS,
  WEBHOOK_EVENT_TYPES: (await import("../../../packages/core/src/webhooks")).WEBHOOK_EVENT_TYPES,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next-intl/server", () => ({
  getLocale: async () => current.locale,
  getTranslations: async (namespace: "envio" | "landing") =>
    createTranslator({ locale: current.locale, messages: messages(current.locale), namespace }),
}));
vi.mock("@/lib/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/components/signup-cta", async () => {
  const intent = await import("../src/lib/public-intent");
  return {
    SignupCta: ({ label, rung }: { label: string; rung?: string }) =>
      createElement("a", { href: intent.signupHref(rung) }, label),
  };
});
vi.mock("@/components/site-chrome", () => ({
  PublicHeader: () => createElement("header", null, "MepMail"),
  PublicFooter: () => createElement("footer", null, "MepMail"),
  SignupLink: ({ label }: { label: string }) => createElement("a", { href: "/signup" }, label),
}));
vi.mock("@/components/public-events", () => ({
  McpConfigCopy: () => createElement("button", { type: "button" }, "copy"),
  DocsLink: ({ href, children }: { href: string; children: unknown }) =>
    createElement("a", { href }, children as string),
  GithubLink: ({ href, children }: { href: string; children: unknown }) =>
    createElement("a", { href }, children as string),
}));
vi.mock("@/components/public-starter-gallery", () => ({ PublicStarterGallery: () => null }));

const { default: Envio, generateMetadata } = await import("../src/app/envio/page");

async function render() {
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: current.locale,
      messages: messages(current.locale),
      // biome-ignore lint/correctness/noChildrenProp: This provider requires children in its createElement props type.
      children: await Envio(),
    }),
  ).replace(/ /g, " ");
}
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

afterEach(() => vi.unstubAllEnvs());

for (const locale of ["en", "pt-BR"] as const) {
  describe(`/envio in ${locale}`, () => {
    it("leads with one headline and prices the entry plans from the catalog", async () => {
      current.locale = locale;
      vi.stubEnv("SEND_LAUNCH_OFFER_ENABLED", "true");
      const html = await render();
      const copy = messages(locale).envio;
      const headings = html.match(/<h1[\s>][\s\S]*?<\/h1>/g) ?? [];
      expect(headings).toHaveLength(1);
      expect(text(headings[0] ?? "").trim()).toBe(`${copy.hero.titleStart} ${copy.hero.titleEnd}`);
      const body = text(html);
      // Free 100 a day, Starter at its catalog price, Pro 110K at the launch price.
      expect(body).toContain(
        locale === "en" ? "100 emails a day free" : "100 e-mails por dia grátis",
      );
      expect(body).toContain(locale === "en" ? "US$ 9/month" : "R$ 49/mês");
      expect(body).toContain(locale === "en" ? "US$ 29" : "R$ 149");
      for (const rung of ["starter", "pro_100k"])
        expect(html).toContain(`href="/signup?next=%2Fsettings%2Fbilling%3Fplan%3D${rung}"`);
      expect(html).toContain('href="/pricing#planos"');
      expect(html).not.toMatch(/<form\b|200 OK/);
    });

    it("counts checks and tools from the code and quotes the dated comparison", async () => {
      current.locale = locale;
      vi.stubEnv("SEND_LAUNCH_OFFER_ENABLED", "true");
      const html = await render();
      expect(html).toContain(`<span class="v2-stat-num">${CHECKS.length}</span>`);
      expect(text(html)).toContain(String(MCP_TOOLS.length));
      // Every webhook chip is a real event type.
      const chips = [...html.matchAll(/<li class="v2-chip">([^<]+)<\/li>/g)].map((m) => m[1]);
      expect(chips.length).toBeGreaterThan(3);
      for (const chip of chips) expect(WEBHOOK_EVENT_TYPES as readonly string[]).toContain(chip);
      const row = comparisonRowsForLocale(true, locale).find((r) => r.volume === 550_000);
      expect(row).toBeDefined();
      expect(html).toContain(formatWholeComparisonPrice(row?.mepmail ?? 0, locale));
      expect(html).toContain(locale === "en" ? "US$ 129" : "R$ 649");
      expect(html).toContain(formatWholeComparisonPrice(row?.resend ?? 0, locale));
      // The footnote dates the competitor's price; Portuguese also names the exchange rate.
      expect(text(html)).toMatch(locale === "en" ? /2026-10-16/ : /16\/10\/2026.*PTAX/);
    });

    it("shows the migration with the real CLI and the localized guide", async () => {
      current.locale = locale;
      const html = await render();
      expect(html).toContain('id="migrar"');
      expect(html).toContain("mepmail migrate plan --from resend");
      expect(html).toContain("mepmail migrate apply plan.json");
      expect(html).toContain("RESEND_BASE_URL=https://api.mepmail.dev");
      const docs = locale === "en" ? "https://docs.mepmail.dev" : "https://docs.mepmail.dev/pt-BR";
      expect(html).toContain(`href="${docs}/migrate-from-resend"`);
      expect(html).toContain(`href="${docs}/self-hosting"`);
    });

    it("indexes the page with its own canonical and the language alternates", async () => {
      current.locale = locale;
      const metadata = await generateMetadata();
      expect(metadata.title).toEqual({ absolute: messages(locale).envio.meta.title });
      expect(String(metadata.description)).toContain(String(CHECKS.length));
      expect(metadata.robots).toEqual({ index: true, follow: true });
      expect(metadata.alternates?.canonical).toBe("/envio");
      expect(metadata.alternates?.languages).toEqual({
        en: "/envio",
        "pt-BR": "/envio?lang=pt-BR",
        "x-default": "/envio",
      });
    });

    it("keeps the copy free of em dashes, one-click claims and typed counts", () => {
      const raw = readFileSync(
        fileURLToPath(new URL(`../messages/${locale}/envio.json`, import.meta.url)),
        "utf8",
      );
      expect(raw).not.toContain("—");
      expect(raw).not.toMatch(/one.click|1 clique|um clique/i);
      // The counts are rendered from CHECKS and MCP_TOOLS, never typed into the copy.
      expect(raw).not.toMatch(/\b(?:21|79)\b/);
    });
  });
}
