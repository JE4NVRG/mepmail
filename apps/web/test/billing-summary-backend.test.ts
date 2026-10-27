import type { BillingStripe } from "@millionsend/billing";
import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { emptyBillingSummary, readBillingSummary } from "@/server/billing-summary";

// Synthetic fixtures only; no customer/provider/DB IO.
const sec = (value: string) => Date.parse(`${value}T00:00:00Z`) / 1000;
const start = sec("2026-10-26");
const renewal = sec("2026-11-26");
const end = sec("2026-12-26");
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing synthetic fixture element");
  return value;
}
function fixture() {
  const coupon = {
    id: "coupon_synthetic",
    valid: true,
    percent_off: 100,
    amount_off: null,
    duration: "once",
    applies_to: { products: ["prod_base"] },
  };
  const discount = {
    id: "di_synthetic",
    customer: "cus_synthetic",
    subscription: "sub_synthetic",
    start,
    end: null,
    source: { type: "coupon", coupon: coupon.id },
  };
  const subscription = {
    id: "sub_synthetic",
    customer: "cus_synthetic",
    status: "active",
    cancel_at: null,
    cancel_at_period_end: false,
    pause_collection: null,
    schedule: null,
    items: {
      has_more: false,
      data: [
        {
          id: "si_base",
          quantity: 1,
          current_period_start: start,
          current_period_end: renewal,
          price: {
            id: "price_base",
            unit_amount: 2900,
            currency: "usd",
            product: "prod_base",
            recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
          },
        },
        {
          id: "si_meter",
          price: { id: "price_meter", product: "prod_meter", recurring: { usage_type: "metered" } },
        },
      ],
    },
  };
  const line = {
    amount: 2900,
    subtotal: 2900,
    currency: "usd",
    quantity: 1,
    period: { start: renewal, end },
    pricing: { price_details: { price: "price_base" } },
    parent: {
      subscription_item_details: {
        subscription_item: "si_base",
        subscription: "sub_synthetic",
        proration: false,
      },
    },
    discount_amounts: [{ amount: 2900, discount: discount.id }],
  };
  const invoice = {
    customer: "cus_synthetic",
    parent: { subscription_details: { subscription: "sub_synthetic" } },
    currency: "usd",
    amount_due: 93,
    total: 93,
    discounts: [discount],
    lines: { has_more: false, data: [line] },
  };
  const createPreview = vi.fn(async () => invoice);
  const retrieve = vi.fn(async () => coupon);
  const stripe = { invoices: { createPreview }, coupons: { retrieve } } as unknown as BillingStripe;
  const read = () => readBillingSummary(stripe, subscription as unknown as Stripe.Subscription);
  return { coupon, discount, subscription, line, invoice, createPreview, retrieve, stripe, read };
}

describe("customer-safe billing summary", () => {
  it("separates paid period, courtesy next period, variable usage and regular resumption", async () => {
    const f = fixture();
    expect(await f.read()).toEqual({
      state: "confirmed",
      currentPeriodStart: "2026-10-26T00:00:00.000Z",
      currentPeriodEnd: "2026-11-26T00:00:00.000Z",
      renewalAt: "2026-11-26T00:00:00.000Z",
      accessEndsAt: null,
      nextInvoice: {
        at: "2026-11-26T00:00:00.000Z",
        currency: "usd",
        baseAmountCents: 2900,
        baseDiscountCents: 2900,
        baseNetCents: 0,
        totalEstimateCents: 93,
        usageMayChange: true,
        periodStart: "2026-11-26T00:00:00.000Z",
        periodEnd: "2026-12-26T00:00:00.000Z",
      },
      benefit: {
        kind: "courtesy",
        periodStart: "2026-11-26T00:00:00.000Z",
        periodEnd: "2026-12-26T00:00:00.000Z",
        baseDiscountCents: 2900,
        regularBillingResumesAt: "2026-12-26T00:00:00.000Z",
      },
    });
    expect(f.createPreview).toHaveBeenCalledWith(
      {
        customer: "cus_synthetic",
        subscription: "sub_synthetic",
        preview_mode: "next",
        expand: ["discounts"],
      },
      { timeout: 4000, maxNetworkRetries: 0 },
    );
    expect(f.retrieve).toHaveBeenCalledWith(
      "coupon_synthetic",
      { expand: ["applies_to"] },
      { timeout: 4000, maxNetworkRetries: 0 },
    );
  });
  it.each(["scheduled", "period_end"])(
    "cancellation %s exposes actual access end, never next charge",
    async (kind) => {
      const f = fixture();
      if (kind === "scheduled") f.subscription.cancel_at = renewal as never;
      else f.subscription.cancel_at_period_end = true;
      expect(await f.read()).toMatchObject({
        state: "confirmed",
        renewalAt: null,
        accessEndsAt: "2026-11-26T00:00:00.000Z",
        nextInvoice: null,
        benefit: null,
      });
      expect(f.createPreview).not.toHaveBeenCalled();
    },
  );
  it("does not mistake customer credit for a free base", async () => {
    const f = fixture();
    f.line.discount_amounts = [];
    f.invoice.amount_due = 0;
    expect(await f.read()).toMatchObject({
      state: "confirmed",
      benefit: null,
      nextInvoice: { baseNetCents: 2900, baseDiscountCents: 0, totalEstimateCents: 0 },
    });
    expect(f.retrieve).not.toHaveBeenCalled();
  });
  it.each([
    "partial",
    "repeating",
    "amount_off",
    "annual",
    "expired",
    "unexpanded_scope",
    "wrong_product",
    "metered_product",
    "schedule",
  ])("%s never becomes one courtesy month or invented resume date", async (kind) => {
    const f = fixture();
    if (kind === "partial") {
      present(f.line.discount_amounts[0]).amount = 900;
      f.coupon.percent_off = 31;
    }
    if (kind === "repeating") f.coupon.duration = "repeating";
    if (kind === "amount_off") {
      f.coupon.percent_off = null as never;
      f.coupon.amount_off = 2900 as never;
    }
    if (kind === "annual") {
      present(f.subscription.items.data[0]).price.recurring.interval = "year";
      f.line.period.end = sec("2027-11-26");
    }
    if (kind === "expired") f.discount.end = start as never;
    if (kind === "unexpanded_scope") f.coupon.applies_to = undefined as never;
    if (kind === "wrong_product") f.coupon.applies_to.products = ["prod_other"];
    if (kind === "metered_product")
      present(f.subscription.items.data[1]).price.product = "prod_base";
    if (kind === "schedule") f.subscription.schedule = "sched_synthetic" as never;
    expect(await f.read()).toMatchObject({
      state: "confirmed",
      benefit: { kind: "discount", regularBillingResumesAt: null },
    });
  });
  it.each([
    "customer",
    "subscription",
    "currency",
    "truncated",
    "negative_total",
    "fractional",
    "unbound_base",
    "price",
    "proration",
    "bad_period",
    "duplicate",
    "line_currency",
    "discount_overflow",
    "next_start",
  ])("fails closed for preview %s", async (kind) => {
    const f = fixture();
    if (kind === "customer") f.invoice.customer = "cus_other";
    if (kind === "subscription") f.invoice.parent.subscription_details.subscription = "sub_other";
    if (kind === "currency") f.invoice.currency = "brl";
    if (kind === "truncated") f.invoice.lines.has_more = true;
    if (kind === "negative_total") f.invoice.total = -1;
    if (kind === "fractional") f.invoice.amount_due = 1.5;
    if (kind === "unbound_base")
      f.line.parent.subscription_item_details.subscription_item = "si_other";
    if (kind === "price") f.line.pricing.price_details.price = "price_other";
    if (kind === "proration") f.line.parent.subscription_item_details.proration = true;
    if (kind === "bad_period") f.line.period.end = Number.NaN;
    if (kind === "duplicate") f.invoice.lines.data.push(f.line);
    if (kind === "line_currency") f.line.currency = "eur";
    if (kind === "discount_overflow") present(f.line.discount_amounts[0]).amount = 3000;
    if (kind === "next_start") f.line.period.start = start;
    expect(await f.read()).toMatchObject({
      state: "unavailable",
      nextInvoice: null,
      benefit: null,
      renewalAt: null,
    });
  });
  it("bounds an unresponsive provider and strips raw error details", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.createPreview.mockImplementation(() => new Promise(() => {}));
      const pending = f.read();
      await vi.advanceTimersByTimeAsync(4501);
      expect(await pending).toEqual(emptyBillingSummary("unavailable"));
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not expose IDs, raw errors, metadata or coupon notes", async () => {
    const f = fixture();
    expect(JSON.stringify(await f.read())).not.toMatch(
      /cus_|sub_|si_|price_|prod_|coupon_|di_|metadata/,
    );
    f.createPreview.mockRejectedValue(new Error("secret_operator_note"));
    expect(JSON.stringify(await f.read())).not.toContain("secret_operator_note");
  });
  it("missing read-only preview capability is unavailable, never catalog estimates", async () => {
    const f = fixture();
    delete (f.stripe as { invoices?: unknown }).invoices;
    expect(await f.read()).toMatchObject({ state: "unavailable", nextInvoice: null });
  });
  it.each(["free", "system", "selfhost"])(
    "not applicable DTO for %s has no financial claims",
    () => {
      expect(emptyBillingSummary("not_applicable")).toEqual({
        state: "not_applicable",
        currentPeriodStart: null,
        currentPeriodEnd: null,
        renewalAt: null,
        accessEndsAt: null,
        nextInvoice: null,
        benefit: null,
      });
    },
  );
});

describe("billing summary financial edge states", () => {
  it("recognizes an attached single-redemption courtesy even when NEW redemption is invalid", async () => {
    const f = fixture();
    Object.assign(f.coupon, { valid: false, max_redemptions: 1, times_redeemed: 1 });
    expect(await f.read()).toMatchObject({
      state: "confirmed",
      benefit: { kind: "courtesy", regularBillingResumesAt: "2026-12-26T00:00:00.000Z" },
      nextInvoice: { baseNetCents: 0 },
    });
  });

  it.each(["past_due", "unpaid", "incomplete", "trialing"])(
    "%s makes no paid-period or next-payment claim",
    async (status) => {
      const f = fixture();
      f.subscription.status = status;
      expect(await f.read()).toEqual(emptyBillingSummary("unavailable"));
      expect(f.createPreview).not.toHaveBeenCalled();
    },
  );
  it("manual collection does not invent a Pix invoice due date", async () => {
    const f = fixture();
    Object.assign(f.subscription, { collection_method: "send_invoice" });
    expect(await f.read()).toEqual(emptyBillingSummary("unavailable"));
    expect(f.createPreview).not.toHaveBeenCalled();
  });
  it("discount customer identity remains bound", async () => {
    const f = fixture();
    f.discount.customer = "cus_other";
    expect(await f.read()).toMatchObject({
      state: "unavailable",
      nextInvoice: null,
      benefit: null,
    });
  });
});
