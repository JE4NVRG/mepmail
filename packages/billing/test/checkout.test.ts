import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCheckoutSession } from "../src/checkout.js";
import { priceId, teamRow } from "./helpers.js";
import { checkoutFixture } from "./send-checkout-fixture.js";

let fixture: Awaited<ReturnType<typeof checkoutFixture>>;
beforeEach(async () => {
  fixture = await checkoutFixture();
});
afterEach(async () => {
  await fixture.close();
});

describe("createCheckoutSession", () => {
  it("a monthly rung carries its plan and metered price and binds exactly one Customer", async () => {
    const { db, deps, input, state, posts } = fixture;
    expect(await createCheckoutSession(deps, input)).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(state.customers).toHaveLength(1);
    expect(state.customers[0]).toMatchObject({
      name: "acme",
      email: input.email,
      metadata: { team_id: input.team.id },
    });
    expect(posts[0]?.key).toMatch(/^send-customer:/);
    expect(state.checkouts[0]).toMatchObject({
      mode: "subscription",
      customer: "cus_1",
      client_reference_id: input.team.id,
      line_items: [
        { price: priceId("millionsend_pro_100k_monthly"), quantity: 1 },
        { price: priceId("millionsend_pro_100k_overage") },
      ],
    });
    expect((await teamRow(db, input.team.id))?.stripeCustomerId).toBe("cus_1");
  });
  it("a daily rung only carries its plan price", async () => {
    await createCheckoutSession(fixture.deps, { ...fixture.input, rung: "starter" });
    expect(fixture.state.checkouts[0]?.line_items).toEqual([
      { price: priceId("millionsend_starter_monthly"), quantity: 1 },
    ]);
  });
  it("automaticTax off leaves checkout untaxed", async () => {
    await createCheckoutSession(fixture.deps, { ...fixture.input, rung: "pro_200k" });
    expect(fixture.state.checkouts[0]).toMatchObject({
      automatic_tax: { enabled: false },
      tax_id_collection: { enabled: false },
    });
  });
  it("refuses free before any provider call", async () => {
    await expect(
      createCheckoutSession(fixture.deps, { ...fixture.input, rung: "free" }),
    ).rejects.toThrow("not for sale");
    expect(fixture.posts).toEqual([]);
  });
});
