import { describe, expect, it } from "vitest";
import { PLAN_RUNGS } from "../../../packages/core/src/plans";
import enLanding from "../messages/en/landing.json";
import { plansWithCopy } from "../src/lib/landing-plans";
import {
  COMPARISON_FX,
  comparisonRowsForLocale,
  formatComparisonPrice,
  PRICE_ROWS,
  priceRowsForOffer,
} from "../src/lib/landing-pricing";
import { computeSavings } from "../src/lib/landing-savings";
import { LAUNCH_OFFER } from "../src/lib/launch-offer";

describe("public offer selection preserves the legacy contract", () => {
  it("changes only the public 110K presentation when selected, without mutating either catalog", () => {
    const copies = enLanding.plans.items;
    const legacy = plansWithCopy(copies);
    const launch = plansWithCopy(copies, true, enLanding.plans.launchPriceNote);
    expect(legacy.map((plan) => plan.price)).toEqual([
      "US$ 0",
      "US$ 9",
      "US$ 20",
      "US$ 55",
      "US$ 129",
      "US$ 239",
      "US$ 349",
      "US$ 549",
    ]);
    expect(launch.find((plan) => plan.rung === "pro_100k")?.price).toBe(
      `US$ ${LAUNCH_OFFER.sending.monthlyCents / 100}`,
    );
    expect(launch.filter((plan) => plan.rung !== "pro_100k")).toEqual(
      legacy.filter((plan) => plan.rung !== "pro_100k"),
    );
    expect(PLAN_RUNGS.find((plan) => plan.key === "pro_100k")?.priceCents).toBe(2000);
    expect(plansWithCopy(copies)).toEqual(legacy);
  });

  it("keeps calculator and comparison on the same recurring price, with no intro in savings", () => {
    const before = PRICE_ROWS.map((row) => ({ ...row }));
    const rows = priceRowsForOffer(true);
    expect(rows[0]?.mepmail).toBe(29);
    for (const row of rows) expect(row.savings).toBe(`${computeSavings(row).savingsPct}%`);
    expect(rows.slice(1)).toEqual(PRICE_ROWS.slice(1));
    expect(priceRowsForOffer(false)).toEqual(before);
  });

  it("uses charged BRL catalog prices and a dated BCB conversion only for foreign providers", () => {
    const before = PRICE_ROWS.map((row) => ({ ...row }));
    const brl = comparisonRowsForLocale(true, "pt-BR");
    expect(brl.map((row) => row.mepmail)).toEqual([149, 279, 649, 1199, 1749, 2749]);
    expect(brl[0]?.resend).toBeCloseTo(44 * COMPARISON_FX.brlPerUsd);
    expect(COMPARISON_FX.date).toBe("2026-10-15");
    expect(COMPARISON_FX.url).toContain("bcb.gov.br");
    for (const row of brl) expect(row.savings).toBe(`${computeSavings(row).savingsPct}%`);
    expect(formatComparisonPrice(brl[0]?.mepmail ?? null, "pt-BR")).toBe("R$ 149,00");
    expect(comparisonRowsForLocale(true, "en")[0]?.mepmail).toBe(29);
    expect(PRICE_ROWS).toEqual(before);
  });
});
