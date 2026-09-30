import { readFileSync } from "node:fs";
import { PLAN_RUNGS } from "@millionsend/core/plans";
import { describe, expect, it } from "vitest";
import { RUNG_PRICE_CENTS } from "../src/lib/console-format";
import { PLANS } from "../src/lib/landing-plans";
import { PRICE_ROWS } from "../src/lib/landing-pricing";

const approved = [
  ["pro_100k", 110000, 2000, 30],
  ["pro_200k", 220000, 3900, 28],
  ["scale_500k", 550000, 9500, 25],
  ["scale_1m", 1100000, 17900, 23],
  ["scale_1_5m", 1650000, 26500, 22],
  ["scale_2_5m", 2750000, 42900, 21],
] as const;
const monthly = PLAN_RUNGS.filter((r) => r.period === "month");
const cost = (r: (typeof monthly)[number], n: number) =>
  r.priceCents + r.overageCentsPer1k * Math.ceil(Math.max(0, n - r.included) / 1000);

describe("approved catalog numerical parity", () => {
  it("preserves exact approved cents, quotas and stable keys", () => {
    expect(monthly.map((r) => [r.key, r.included, r.priceCents, r.overageCentsPer1k])).toEqual(
      approved,
    );
    expect(PLAN_RUNGS.slice(0, 2).map((r) => [r.included, r.priceCents])).toEqual([
      [100, 0],
      [1500, 900],
    ]);
  });
  it.each(["en", "pt-BR"])("keeps %s landing, console, comparison and docs equal", (locale) => {
    const copy = JSON.parse(
      readFileSync(new URL(`../messages/${locale}/landing.json`, import.meta.url), "utf8"),
    );
    const doc = readFileSync(
      new URL(
        `../../docs/content/docs/billing${locale === "en" ? "" : ".pt-BR"}.mdx`,
        import.meta.url,
      ),
      "utf8",
    );
    for (const [index, rung] of PLAN_RUNGS.entries()) {
      expect(PLANS[index]?.rung).toBe(rung.key);
      expect(PLANS[index]?.price).toBe(`US$ ${rung.priceCents / 100}`);
      if (rung.key !== "free") expect(RUNG_PRICE_CENTS[rung.key]).toBe(rung.priceCents);
      if (rung.period !== "month") continue;
      const rate = (rung.overageCentsPer1k / 100)
        .toFixed(2)
        .replace(".", locale === "en" ? "." : ",");
      expect(copy.plans.items[index].overage).toBe(`US$ ${rate}/1k`);
      const row = doc.split("\n").find((line) => line.startsWith(`| \`${rung.key}\` |`));
      expect(row).toContain(`${rung.priceCents / 100} |`);
      expect(row).toContain(`${rate} |`);
      expect(PRICE_ROWS[index - 2]?.mepmail).toBe(rung.priceCents / 100);
      expect(PRICE_ROWS[index - 2]?.volume).toBe(rung.included);
    }
  });
  it("has decreasing unit prices and compares BOTH overage bills at every adjacent boundary", () => {
    for (let i = 1; i < monthly.length; i++) {
      const low = monthly[i - 1];
      const high = monthly[i];
      if (!low || !high) throw new Error("Missing rung");
      expect(low.priceCents * high.included).toBeGreaterThan(high.priceCents * low.included);
      expect(low.overageCentsPer1k).toBeGreaterThan(high.overageCentsPer1k);
      let threshold = low.included;
      while (cost(low, threshold) <= cost(high, threshold)) threshold++;
      for (const n of [
        threshold - 1,
        threshold,
        threshold + 1,
        high.included - 1,
        high.included,
        high.included + 1,
        high.included + 999,
        high.included + 1000,
        high.included + 1001,
        high.included * 2,
      ]) {
        const lowBlocks = Math.floor((Math.max(0, n - low.included) + 999) / 1000);
        const highBlocks = Math.floor((Math.max(0, n - high.included) + 999) / 1000);
        expect(cost(low, n) - cost(high, n)).toBe(
          low.priceCents +
            lowBlocks * low.overageCentsPer1k -
            high.priceCents -
            highBlocks * high.overageCentsPer1k,
        );
      }
      expect(cost(low, threshold - 1)).toBeLessThanOrEqual(cost(high, threshold - 1));
      expect(cost(low, threshold)).toBeGreaterThan(cost(high, threshold));
      expect(cost(low, high.included + 1001)).toBeGreaterThan(cost(high, high.included + 1001));
    }
  });
});
