import { describe, expect, it } from "vitest";
import { COMPETITORS, PRICE_ROWS, formatUsd } from "../src/lib/landing-pricing";
import { computeSavings, savingsForIndex } from "../src/lib/landing-savings";

// The exact cells the public table shipped before the calculator refactor; the
// formatter must reproduce them cell for cell so the copy never drifts.
const ORIGINAL_TABLE = [
  ["100k", "US$ 20", "US$ 35", "US$ 34,95", "US$ 115", "US$ 90", "43%"],
  ["200k", "US$ 100", "US$ 160", "US$ 249", "US$ 245", "US$ 215", "38–60%"],
  ["500k", "US$ 199", "US$ 350", "US$ 499", "US$ 455", "US$ 400", "43–60%"],
  ["1M", "US$ 319", "US$ 650", "US$ 799", "US$ 775", "US$ 700", "51–60%"],
  ["1,5M", "US$ 429", "US$ 825", "US$ 799", "US$ 775", "US$ 700", "39–48%"],
  ["2,5M", "US$ 549", "US$ 1.150", "US$ 1.099", "(vendas)", "US$ 1.250", "50–56%"],
] as const;

describe("landing pricing data", () => {
  it("reproduces the published table cell for cell", () => {
    const rendered = PRICE_ROWS.map((row) => [
      row.label,
      formatUsd(row.mepmail),
      formatUsd(row.resend),
      formatUsd(row.sendgrid),
      formatUsd(row.postmark),
      formatUsd(row.mailgun),
      row.savings,
    ]);
    expect(rendered).toEqual(ORIGINAL_TABLE);
  });

  it("keeps MepMail below every public competitor price", () => {
    for (const row of PRICE_ROWS) {
      for (const competitor of COMPETITORS) {
        const price = row[competitor.key];
        if (price !== null) {
          expect(row.mepmail, `${row.label} vs ${competitor.name}`).toBeLessThan(price);
        }
      }
    }
  });

  it("lists volumes in ascending order", () => {
    const volumes = PRICE_ROWS.map((row) => row.volume);
    expect([...volumes].sort((a, b) => a - b)).toEqual(volumes);
  });
});

describe("computeSavings", () => {
  it("uses the cheapest competitor with a public price", () => {
    const first = computeSavings(PRICE_ROWS[0]!);
    expect(first.competitor.name).toBe("SendGrid"); // 34,95 < 35 (Resend)
    expect(first.savingsUsd).toBeCloseTo(14.95);
    expect(first.savingsPct).toBe(43);
    expect(first.savingsYearUsd).toBeCloseTo(179.4);

    const top = computeSavings(PRICE_ROWS[5]!);
    expect(top.competitor.name).toBe("SendGrid"); // 1.099 < 1.150 (Resend)
    expect(top.savingsPct).toBe(50);
  });

  it("skips rows without a public competitor price", () => {
    // 2,5M has Postmark as "(vendas)" — null must not win or crash the walk.
    const savings = computeSavings(PRICE_ROWS[5]!);
    expect(savings.competitor.price).toBeGreaterThan(0);
    expect(COMPETITORS.map((c) => c.key)).not.toContain(undefined);
  });

  it("resolves every index the calculator can reach", () => {
    for (let index = 0; index < PRICE_ROWS.length; index += 1) {
      const savings = savingsForIndex(index);
      expect(savings.savingsPct).toBeGreaterThan(30);
      expect(savings.savingsUsd).toBeGreaterThan(0);
    }
  });
});
