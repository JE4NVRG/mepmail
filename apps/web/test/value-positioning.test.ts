import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLAN_RUNGS } from "@millionsend/core";
import { describe, expect, it } from "vitest";
import { PRICE_ROWS } from "../src/lib/landing-pricing";

// The landing leads with what is ours (own infrastructure, agent-ready MCP,
// price) and names the competitor it is drop-in compatible with only where a
// migration question needs it: the hero, the eyebrow and the metadata must never
// open with it. Pinned here so a future copy pass cannot quietly turn the page
// back into a "same API as X" pitch.
const messages = fileURLToPath(new URL("../messages", import.meta.url));
const LOCALES = ["en", "pt-BR"] as const;

function landing(locale: string): {
  meta: { title: string; description: string };
  hero: { eyebrow: string; title: string; lead: string; migrate: string; trust: string[] };
  plans: { items: { volume: string }[] };
  stack: { eyebrow: string; note: string };
} {
  return JSON.parse(readFileSync(join(messages, locale, "landing.json"), "utf8"));
}

/**
 * The card quotas after the +10% bump. The comparison table publishes the same
 * rungs (it prices each MepMail volume against the cheapest competitor path);
 * the cards show what the MepMail plan includes.
 */
const PAID_CARD_QUOTAS: Record<(typeof LOCALES)[number], string[]> = {
  en: ["110,000", "220,000", "550,000", "1,100,000", "1,650,000", "2,750,000"],
  "pt-BR": ["110.000", "220.000", "550.000", "1.100.000", "1.650.000", "2.750.000"],
};

const digits = (value: string) => value.replace(/\D/g, "");

describe("landing value-first positioning", () => {
  for (const locale of LOCALES) {
    it(`${locale}: hero, eyebrow and metadata never name the competitor`, () => {
      const copy = landing(locale);
      expect(copy.meta.title).not.toMatch(/resend/i);
      expect(copy.meta.description).not.toMatch(/resend/i);
      expect(copy.hero.eyebrow).not.toMatch(/resend/i);
      expect(copy.hero.title).not.toMatch(/resend/i);
      expect(copy.hero.lead).not.toMatch(/resend/i);
      for (const item of copy.hero.trust) expect(item, item).not.toMatch(/resend/i);
    });

    it(`${locale}: the compatibility survives only as the migration line`, () => {
      expect(landing(locale).hero.migrate).toMatch(/resend/i);
      const raw = readFileSync(join(messages, locale, "landing.json"), "utf8");
      expect(raw.match(/resend/gi)?.length ?? 0).toBeLessThanOrEqual(5);
    });

    it(`${locale}: the hero leads with sending and separates the offer from the lead`, () => {
      const copy = landing(locale);
      expect(copy.hero.trust.join(" ")).toMatch(/MCP/);
      expect(copy.hero.lead).toMatch(/API, SMTP/);
      expect(copy.hero.lead).not.toMatch(/US\$/);
      expect(copy.stack.eyebrow.trim().length).toBeGreaterThan(0);
      expect(copy.stack.note).toMatch(/n8n/);
    });

    it(`${locale}: paid plan cards carry the +10% quotas`, () => {
      const volumes = landing(locale).plans.items.map((item) => item.volume);
      expect(volumes).toHaveLength(8);
      // Free and Starter keep their daily caps; the six paid rungs follow.
      expect(volumes[0]).toContain("100");
      expect(volumes[0]).toContain("3k");
      expect(volumes[1]).toContain("45k");
      expect(volumes.slice(2).map(digits)).toEqual(PAID_CARD_QUOTAS[locale].map(digits));
    });
  }

  it("keeps the comparison table on the published MepMail rungs", () => {
    // The rows are the plan ladder of release v.44 (+10% volume, same prices),
    // not the competitors' own tier labels: the table prices each rung we sell,
    // at the price the ladder charges for it.
    const monthlyRungs = PLAN_RUNGS.filter((rung) => rung.period === "month");
    expect(PRICE_ROWS.map((row) => row.volume)).toEqual(monthlyRungs.map((r) => r.included));
    expect(PRICE_ROWS.map((row) => row.mepmail)).toEqual(
      monthlyRungs.map((rung) => rung.priceCents / 100),
    );
  });
});
