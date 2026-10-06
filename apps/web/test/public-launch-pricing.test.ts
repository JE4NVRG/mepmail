import { describe, expect, it } from "vitest";
import { PLAN_RUNGS } from "../../../packages/core/src/plans";
import enLanding from "../messages/en/landing.json";
import { plansWithCopy } from "../src/lib/landing-plans";
import { PRICE_ROWS, priceRowsForOffer } from "../src/lib/landing-pricing";
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
      "US$ 100",
      "US$ 199",
      "US$ 319",
      "US$ 429",
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
});
