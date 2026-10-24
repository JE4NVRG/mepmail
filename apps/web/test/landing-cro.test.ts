import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UmamiAnalytics } from "../src/components/umami-analytics";
import { UMAMI_SCRIPT_URL, UMAMI_WEBSITE_ID } from "../src/lib/analytics";

vi.mock("next-intl/server", () => ({
  getLocale: async () => "pt-BR",
  getTranslations: async () => (key: string) => key,
}));

const source = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
// The home before v2 still renders while Correio is not sold on its own.
const page = source("../src/app/home-legacy.tsx");
const v2 = source("../src/app/home-v2.tsx");

describe("landing CRO contract", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the product and MCP before pricing, comparison after pricing", () => {
    expect(page.indexOf('id="product"')).toBeLessThan(page.indexOf('id="mcp"'));
    expect(page.indexOf('id="mcp"')).toBeLessThan(page.indexOf('id="planos"'));
    expect(page.indexOf('id="planos"')).toBeLessThan(page.indexOf('id="comparativo"'));
    expect(page).toContain("allPlans.slice(0, 3)");
    expect(page).toContain("allPlans.slice(3)");
    expect(page).toContain("PLAN_RUNGS.find");
    expect(page).toContain("<ArrivalTracker");
    expect(page).toContain("<McpConfigCopy");
    expect(page).not.toContain("200 OK");
  });

  it("the v2 home prices from the catalog, counts from the code and shows the live gallery", () => {
    expect(v2).toContain("PLAN_RUNGS.find");
    expect(v2).toContain("plansWithCopy(");
    expect(v2).toContain("LAUNCH_OFFER.correioPlans");
    expect(v2).toContain("CHECKS.length");
    expect(v2).toContain("MCP_TOOLS.length");
    expect(v2).toContain("comparisonRowsForLocale(");
    expect(v2).toContain("<ArrivalTracker");
    expect(v2).toContain("<PublicStarterGallery");
    expect(v2).not.toContain("200 OK");
    const entry = source("../src/app/page.tsx");
    expect(entry).toContain("standaloneMailOpen() ? HomeV2() : LegacyHome()");
  });

  it("never loads production analytics in explicit local preview", () => {
    vi.stubEnv("MEPMAIL_LOCAL_PREVIEW", "1");
    const html = renderToStaticMarkup(UmamiAnalytics());
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toContain(UMAMI_SCRIPT_URL);
    expect(html).not.toContain("data-website-id");
  });

  it("preserves production analytics by default", () => {
    vi.stubEnv("MEPMAIL_LOCAL_PREVIEW", "");
    const html = renderToStaticMarkup(UmamiAnalytics());
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).toContain(`src="${UMAMI_SCRIPT_URL}"`);
    expect(html).toContain(`data-website-id="${UMAMI_WEBSITE_ID}"`);
    expect(html).toContain('defer=""');
  });

  it("the proof gallery follows the visitor's language", () => {
    const gallery = readFileSync(
      fileURLToPath(new URL("../src/components/public-starter-gallery.tsx", import.meta.url)),
      "utf8",
    );
    expect(gallery).toContain("listStarters(locale)");
  });

  it("keeps fictional email content outside SSR and preserves the starter through signup", async () => {
    const { PublicStarterGallery } = await import("../src/components/public-starter-gallery");
    const html = renderToStaticMarkup(await PublicStarterGallery({}));
    expect(html).not.toMatch(/<iframe|srcdoc=|VOLTEI10|4242|<script/i);
    expect(html).toContain('aria-hidden="true" inert=""');
    expect(html).toContain("/signup?next=%2Ftemplates%2Fnew%3Fstarter%3Dwelcome");
    expect(html.match(/href="\/signup\?next=/g)).toHaveLength(10);
  });

  for (const locale of ["en", "pt-BR"]) {
    it(`${locale}: no isolated reputation, time promise or popularity claim`, () => {
      const copy = JSON.parse(
        readFileSync(
          fileURLToPath(new URL(`../messages/${locale}/landing.json`, import.meta.url)),
          "utf8",
        ),
      );
      expect(copy.hero.title).toBe(
        locale === "en" ? "Send emails. Keep building." : "Envie e-mails. Continue construindo.",
      );
      expect(JSON.stringify([copy.hero, copy.deliverability, copy.how])).not.toMatch(
        /reputation.{0,10}isolated|reputação isolada|one minute|1 minuto|15 minutes|15 minutos/i,
      );
      expect(copy.plans.featuredBadge).not.toMatch(/popular/i);
      // The proof gallery renders the starters in the visitor's language, so the
      // caption names them as real templates instead of warning they are English.
      expect(copy.productProof.caption).toMatch(/real MepMail templates|Modelos reais do MepMail/i);
      expect(copy.integration.example).toMatch(/no email|não envia/);
    });
  }
});
