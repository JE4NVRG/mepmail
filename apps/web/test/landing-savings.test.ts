import { describe, expect, it } from "vitest";
import { COMPETITORS, formatUsd, formatVolume, PRICE_ROWS } from "../src/lib/landing-pricing";
import { computeSavings, savingsForIndex } from "../src/lib/landing-savings";

// The exact cells the public table publishes, cell for cell. The numbers are
// shared across locales; the separators and the quote cell are not. English is
// the default audience (US separators, "(sales)") and pt-BR mirrors it
// ("1,5M", "US$ 1.150", "(vendas)").
const EN_TABLE = [
  ["100k", "US$ 20", "US$ 35", "US$ 34.95", "US$ 115", "US$ 90", "43%"],
  ["200k", "US$ 100", "US$ 160", "US$ 249", "US$ 245", "US$ 215", "38–60%"],
  ["500k", "US$ 199", "US$ 350", "US$ 499", "US$ 455", "US$ 400", "43–60%"],
  ["1M", "US$ 319", "US$ 650", "US$ 799", "US$ 775", "US$ 700", "51–60%"],
  ["1.5M", "US$ 429", "US$ 825", "US$ 799", "US$ 775", "US$ 700", "39–48%"],
  ["2.5M", "US$ 549", "US$ 1,150", "US$ 1,099", "(sales)", "US$ 1,250", "50–56%"],
] as const;

const PT_TABLE = [
  ["100k", "US$ 20", "US$ 35", "US$ 34,95", "US$ 115", "US$ 90", "43%"],
  ["200k", "US$ 100", "US$ 160", "US$ 249", "US$ 245", "US$ 215", "38–60%"],
  ["500k", "US$ 199", "US$ 350", "US$ 499", "US$ 455", "US$ 400", "43–60%"],
  ["1M", "US$ 319", "US$ 650", "US$ 799", "US$ 775", "US$ 700", "51–60%"],
  ["1,5M", "US$ 429", "US$ 825", "US$ 799", "US$ 775", "US$ 700", "39–48%"],
  ["2,5M", "US$ 549", "US$ 1.150", "US$ 1.099", "(vendas)", "US$ 1.250", "50–56%"],
] as const;

// TS-safe accessor so the tests never need the non-null assertion operator.
const priceRow = (index: number) => {
  const row = PRICE_ROWS[index];
  if (!row) throw new Error(`missing PRICE_ROWS[${index}]`);
  return row;
};

const renderTable = (locale: string) =>
  PRICE_ROWS.map((row) => [
    formatVolume(row.volume, locale),
    formatUsd(row.mepmail, locale),
    formatUsd(row.resend, locale),
    formatUsd(row.sendgrid, locale),
    formatUsd(row.postmark, locale),
    formatUsd(row.mailgun, locale),
    row.savings,
  ]);

describe("landing pricing data", () => {
  it("reproduces the published table cell for cell in English", () => {
    expect(renderTable("en")).toEqual(EN_TABLE);
  });

  it("reproduces the published table cell for cell in pt-BR", () => {
    expect(renderTable("pt-BR")).toEqual(PT_TABLE);
  });

  it("keeps the quote cell inside the reader's locale", () => {
    const en = JSON.stringify(renderTable("en"));
    const pt = JSON.stringify(renderTable("pt-BR"));
    expect(en).toContain("(sales)");
    expect(en).not.toContain("(vendas)");
    expect(pt).toContain("(vendas)");
  });

  it("never mixes the two locales' separators", () => {
    const en = JSON.stringify(renderTable("en"));
    const pt = JSON.stringify(renderTable("pt-BR"));
    // English cells: no pt-BR thousands dot ("1.150") nor decimal comma ("34,95").
    expect(en).not.toMatch(/\d+\.\d{3}\b/);
    expect(en).not.toMatch(/\d+,\d{2}\b/);
    // pt-BR cells mirror it: no US thousands comma ("1,150") nor decimal dot ("34.95").
    expect(pt).not.toMatch(/\d+,\d{3}\b/);
    expect(pt).not.toMatch(/\d+\.\d{2}\b/);
  });

  it("renders the volume label from the row volume in each locale", () => {
    expect(PRICE_ROWS.map((row) => formatVolume(row.volume, "en"))).toEqual([
      "100k",
      "200k",
      "500k",
      "1M",
      "1.5M",
      "2.5M",
    ]);
    expect(PRICE_ROWS.map((row) => formatVolume(row.volume, "pt-BR"))).toEqual([
      "100k",
      "200k",
      "500k",
      "1M",
      "1,5M",
      "2,5M",
    ]);
  });

  it("keeps MepMail below every public competitor price", () => {
    for (const row of PRICE_ROWS) {
      for (const competitor of COMPETITORS) {
        const price = row[competitor.key];
        if (price !== null) {
          expect(row.mepmail, `${row.volume} vs ${competitor.name}`).toBeLessThan(price);
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
    const first = computeSavings(priceRow(0));
    expect(first.competitor.name).toBe("SendGrid"); // US$ 34.95 < US$ 35 (Resend)
    expect(first.savingsUsd).toBeCloseTo(14.95);
    expect(first.savingsPct).toBe(43);
    expect(first.savingsYearUsd).toBeCloseTo(179.4);

    const top = computeSavings(priceRow(5));
    expect(top.competitor.name).toBe("SendGrid"); // US$ 1,099 < US$ 1,150 (Resend)
    expect(top.savingsPct).toBe(50);
  });

  it("skips rows without a public competitor price", () => {
    // 2.5M has Postmark as "(sales)"/"(vendas)" — null must not win or crash the walk.
    const savings = computeSavings(priceRow(5));
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
