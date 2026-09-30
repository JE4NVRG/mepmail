import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UmamiAnalytics } from "../src/components/umami-analytics";

const page = readFileSync(fileURLToPath(new URL("../src/app/page.tsx", import.meta.url)), "utf8");

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

  it("never loads production analytics in explicit local preview", () => {
    vi.stubEnv("MEPMAIL_LOCAL_PREVIEW", "1");
    expect(UmamiAnalytics()).toBeNull();
  });

  it("preserves production analytics by default", () => {
    vi.stubEnv("MEPMAIL_LOCAL_PREVIEW", "");
    expect(UmamiAnalytics()?.type).toBe("script");
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
        locale === "en"
          ? "Switch your email. Know your costs."
          : "Migre seus e-mails. Saiba o custo.",
      );
      expect(JSON.stringify([copy.hero, copy.deliverability, copy.how])).not.toMatch(
        /reputation.{0,10}isolated|reputação isolada|one minute|1 minuto|15 minutes|15 minutos/i,
      );
      expect(copy.plans.featuredBadge).not.toMatch(/popular/i);
      expect(copy.productProof.caption).toMatch(/English|inglês/);
      expect(copy.integration.example).toMatch(/no email|não envia/);
    });
  }
});
