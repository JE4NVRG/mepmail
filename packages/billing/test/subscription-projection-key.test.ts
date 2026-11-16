import { describe, expect, it } from "vitest";
import { canonicalProjectionKey } from "../src/subscription-projection-key.js";

describe("projection JSONB semantic identity", () => {
  it("ignores object insertion order recursively without ignoring values", () => {
    const before = ["cus_fixed", { currency: "usd", price: { id: "price_fixed", units: 110000 } }];
    const after = ["cus_fixed", { price: { units: 110000, id: "price_fixed" }, currency: "usd" }];
    expect(JSON.stringify(before)).not.toBe(JSON.stringify(after));
    expect(canonicalProjectionKey(before)).toBe(canonicalProjectionKey(after));
  });
  it.each([
    [
      ["cus_fixed", { id: "price_a" }],
      ["cus_changed", { id: "price_a" }],
    ],
    [
      ["cus_fixed", { id: "price_a" }],
      ["cus_fixed", { id: "price_changed" }],
    ],
    [[{ units: 110000 }], [{ units: 220000 }]],
    [[{ value: 1 }], [{ value: "1" }]],
    [[{ value: null }], [{}]],
    [[[1, 2]], [[2, 1]]],
    [[new Date("2026-11-16T00:00:00.000Z")], [new Date("2026-11-16T00:00:00.001Z")]],
  ])("refuses a semantic projection change %#", (before, after) => {
    expect(canonicalProjectionKey(before)).not.toBe(canonicalProjectionKey(after));
  });
});
