import { expect, it } from "vitest";
import { requestedFunnelIntent } from "../src/server/funnel";

const cookie = (v: object) => `mm_funnel_intent=${encodeURIComponent(JSON.stringify(v))}`;
it.each(["send", "mail"])("keeps %s intent without inventing a plan when unselected", (product) => {
  expect(
    requestedFunnelIntent(cookie({ version: 1, product, selection_state: "unselected" })),
  ).toEqual({ requested_product: product, requested_selection_state: "unselected" });
  expect(requestedFunnelIntent(cookie({ version: 1, product, plan: "choose" }))).toEqual({
    requested_product: product,
    requested_selection_state: "unselected",
  });
});
it("preserves an unknown selection without inventing a paid plan", () => {
  expect(
    requestedFunnelIntent(cookie({ version: 1, product: "mail", selection_state: "unknown" })),
  ).toEqual({ requested_product: "mail", requested_selection_state: "unknown" });
});
it("retains known Send and Mail machine codes", () => {
  expect(requestedFunnelIntent(cookie({ version: 1, product: "send", plan: "pro_100k" }))).toEqual({
    requested_product: "send",
    requested_plan: "pro_100k",
  });
  expect(requestedFunnelIntent(cookie({ version: 1, product: "mail", plan: "duo" }))).toEqual({
    requested_product: "mail",
    requested_plan: "duo",
  });
});
it("rejects wrong versions, products and noncatalog paid plans", () => {
  for (const v of [
    { version: 2, product: "send", plan: "pro_100k" },
    { version: 1, product: "other", plan: "free" },
    { version: 1, product: "send", plan: "Pro" },
  ])
    expect(requestedFunnelIntent(cookie(v))).toEqual({});
});
