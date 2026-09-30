import { describe, expect, it } from "vitest";
import { COMPETITORS, formatUsd, formatVolume, PRICE_ROWS } from "../src/lib/landing-pricing";
import { computeSavings, savingsForIndex } from "../src/lib/landing-savings";

// The exact cells the public table publishes, cell for cell, on the release
// v.44 rungs (110K…2.75M, +10% volume at the same prices). The numbers are
// shared across locales; the separators and the quote cell are not. English is
// the default audience (US separators) and pt-BR mirrors it ("1,65M",
// "US$ 1.265").
const EN_TABLE = [
  ["110k", "US$ 20", "US$ 44", "US$ 43.95", "US$ 115", "US$ 86", "54%"],
  ["220k", "US$ 39", "US$ 143", "US$ 142.95", "US$ 245", "US$ 207", "73%"],
  ["550k", "US$ 95", "US$ 385", "US$ 439.95", "US$ 455", "US$ 437.50", "75%"],
  ["1.1M", "US$ 179", "US$ 715", "US$ 799", "US$ 775", "US$ 750", "75%"],
  ["1.65M", "US$ 265", "US$ 903", "US$ 889", "US$ 1,037.50", "US$ 1,025", "70%"],
  ["2.75M", "US$ 429", "US$ 1,265", "US$ 1,224", "US$ 2,962.50", "US$ 1,350", "65%"],
] as const;

const PT_TABLE = [
  ["110k", "US$ 20", "US$ 44", "US$ 43,95", "US$ 115", "US$ 86", "54%"],
  ["220k", "US$ 39", "US$ 143", "US$ 142,95", "US$ 245", "US$ 207", "73%"],
  ["550k", "US$ 95", "US$ 385", "US$ 439,95", "US$ 455", "US$ 437,50", "75%"],
  ["1,1M", "US$ 179", "US$ 715", "US$ 799", "US$ 775", "US$ 750", "75%"],
  ["1,65M", "US$ 265", "US$ 903", "US$ 889", "US$ 1.037,50", "US$ 1.025", "70%"],
  ["2,75M", "US$ 429", "US$ 1.265", "US$ 1.224", "US$ 2.962,50", "US$ 1.350", "65%"],
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
    // No published row is a quote today; the branch stays so a future one can
    // never leak the pt-BR word into the English table.
    expect(formatUsd(null, "en")).toBe("(sales)");
    expect(formatUsd(null, "pt-BR")).toBe("(vendas)");
  });

  it("never mixes the two locales' separators", () => {
    const en = JSON.stringify(renderTable("en"));
    const pt = JSON.stringify(renderTable("pt-BR"));
    // English cells: no pt-BR thousands dot ("1.265") nor decimal comma ("43,95").
    expect(en).not.toMatch(/\d+\.\d{3}\b/);
    expect(en).not.toMatch(/\d+,\d{2}\b/);
    // pt-BR cells mirror it: no US thousands comma ("1,265") nor decimal dot ("43.95").
    expect(pt).not.toMatch(/\d+,\d{3}\b/);
    expect(pt).not.toMatch(/\d+\.\d{2}\b/);
  });

  it("renders the volume label from the row volume in each locale", () => {
    expect(PRICE_ROWS.map((row) => formatVolume(row.volume, "en"))).toEqual([
      "110k",
      "220k",
      "550k",
      "1.1M",
      "1.65M",
      "2.75M",
    ]);
    expect(PRICE_ROWS.map((row) => formatVolume(row.volume, "pt-BR"))).toEqual([
      "110k",
      "220k",
      "550k",
      "1,1M",
      "1,65M",
      "2,75M",
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

  it("publishes exactly the advantage the calculator computes", () => {
    // The Advantage column is data, not copy: it must be the same number the
    // slider shows for that rung, so a table edit cannot outrun the arithmetic.
    for (const row of PRICE_ROWS) {
      expect(row.savings, `advantage at ${row.volume}`).toBe(`${computeSavings(row).savingsPct}%`);
    }
  });
});

describe("computeSavings", () => {
  it("uses the cheapest competitor with a public price", () => {
    const first = computeSavings(priceRow(0));
    expect(first.competitor.name).toBe("SendGrid"); // US$ 43.95 < US$ 44 (Resend)
    expect(first.savingsUsd).toBeCloseTo(23.95);
    expect(first.savingsPct).toBe(54);
    expect(first.savingsYearUsd).toBeCloseTo(287.4);

    const top = computeSavings(priceRow(5));
    expect(top.competitor.name).toBe("SendGrid"); // US$ 1,224 < US$ 1,265 (Resend)
    expect(top.savingsPct).toBe(65);
  });

  it("skips a row whose cheapest competitor is a quote without a price", () => {
    // A null cell must not win the walk nor crash it.
    const savings = computeSavings({ ...priceRow(0), postmark: null });
    expect(savings.competitor.name).toBe("SendGrid");
    expect(COMPETITORS.map((c) => c.key)).not.toContain(undefined);
  });

  it("resolves every index the calculator can reach", () => {
    for (let index = 0; index < PRICE_ROWS.length; index += 1) {
      const savings = savingsForIndex(index);
      // O piso deriva do catálogo aprovado e da base concorrente preservada.
      expect(savings.savingsPct).toBeGreaterThanOrEqual(54);
      expect(savings.savingsUsd).toBeGreaterThan(0);
    }
  });
});
