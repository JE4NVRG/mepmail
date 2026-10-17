import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignupReviewPaymentReader } from "../src/signup-review-payments.js";

const sdk = vi.hoisted(() => ({
  constructed: vi.fn(),
  charges: vi.fn(),
  invoices: vi.fn(),
}));
vi.mock("stripe", () => ({
  default: class {
    charges = { list: sdk.charges };
    invoices = { list: sdk.invoices };
    constructor(secret: string, options: unknown) {
      sdk.constructed(secret, options);
    }
  },
}));

const LIVE = "sk_live_synthetic_offline_only";
const customer = "cus_synthetic";
const page = (data: unknown[] = [], has_more = false) => ({ object: "list", data, has_more });
const charge = (over: Record<string, unknown> = {}) => ({
  id: "ch_synthetic",
  customer,
  livemode: true,
  amount: 1900,
  status: "succeeded",
  paid: true,
  captured: true,
  ...over,
});
const invoice = (over: Record<string, unknown> = {}) => ({
  id: "in_synthetic",
  customer,
  livemode: true,
  amount_paid: 0,
  status: "paid",
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  sdk.charges.mockImplementation(async () => page());
  sdk.invoices.mockImplementation(async () => page());
});
afterEach(() => vi.useRealTimers());

describe("bounded read-only signup-review payment evidence", () => {
  it.each([undefined, "", " ", "sk_test_synthetic", "rk_test_synthetic"])(
    "is lazy and unknown without a live existing credential: %s",
    async (secret) => {
      const read = createSignupReviewPaymentReader(secret);
      expect(sdk.constructed).not.toHaveBeenCalled();
      expect(await read([customer])).toEqual({ [customer]: "unknown" });
      expect(sdk.constructed).not.toHaveBeenCalled();
      expect(sdk.charges).not.toHaveBeenCalled();
      expect(sdk.invoices).not.toHaveBeenCalled();
    },
  );

  it("constructs the existing SDK lazily with bounded transport and no retries", async () => {
    const read = createSignupReviewPaymentReader(LIVE);
    expect(sdk.constructed).not.toHaveBeenCalled();
    expect(await read([customer])).toEqual({ [customer]: "not_observed" });
    expect(sdk.constructed).toHaveBeenCalledWith(LIVE, { timeout: 1500, maxNetworkRetries: 0 });
    expect(sdk.charges).toHaveBeenCalledWith(
      { customer, limit: 25 },
      { timeout: 1500, maxNetworkRetries: 0 },
    );
    expect(sdk.invoices).toHaveBeenCalledWith(
      { customer, limit: 25 },
      { timeout: 1500, maxNetworkRetries: 0 },
    );
    await read([customer]);
    expect(sdk.constructed).toHaveBeenCalledTimes(1);
  });

  it("confirms a positive historical live captured payment without requiring a current subscription", async () => {
    sdk.charges.mockResolvedValue(
      page([charge({ description: "PRIVATE ADDRESS private@private.test" })]),
    );
    const result = await createSignupReviewPaymentReader(LIVE)([customer]);
    expect(result).toEqual({ [customer]: "confirmed" });
    expect(sdk.invoices).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/ch_|1900|PRIVATE|private@/);
    expect(Object.keys(result)).toEqual([customer]);
  });

  it.each([
    { amount: 0 },
    { paid: false, status: "failed" },
    { captured: false },
    { status: "pending" },
  ])(
    "does not turn zero, failed, pending or uncaptured charges into payment proof: %j",
    async (over) => {
      sdk.charges.mockResolvedValue(page([charge(over)]));
      expect(await createSignupReviewPaymentReader(LIVE)([customer])).toEqual({
        [customer]: "not_observed",
      });
    },
  );

  it("does not claim that zero-value trial/discount invoices are payments", async () => {
    sdk.invoices.mockResolvedValue(page([invoice()]));
    expect(await createSignupReviewPaymentReader(LIVE)([customer])).toEqual({
      [customer]: "not_observed",
    });
  });

  it.each([
    { amount_paid: 1900 },
    { amount_paid: 1900, paid_out_of_band: true },
    { amount_paid: 1900, status: "open" },
  ])("keeps invoice settlement ambiguous without a verified captured payment: %j", async (over) => {
    sdk.invoices.mockResolvedValue(page([invoice(over)]));
    expect(await createSignupReviewPaymentReader(LIVE)([customer])).toEqual({
      [customer]: "unknown",
    });
  });

  it.each([
    { livemode: false },
    { customer: "cus_other_tenant" },
    { customer: null },
    { amount: Number.NaN },
  ])("returns unknown for test, foreign-customer or malformed provider rows: %j", async (over) => {
    sdk.charges.mockResolvedValue(page([charge(over)]));
    expect(await createSignupReviewPaymentReader(LIVE)([customer])).toEqual({
      [customer]: "unknown",
    });
  });

  it("accepts an expanded customer only when its identifier matches the database binding", async () => {
    sdk.charges.mockResolvedValue(
      page([charge({ customer: { id: customer, email: "private@private.test" } })]),
    );
    expect(await createSignupReviewPaymentReader(LIVE)([customer])).toEqual({
      [customer]: "confirmed",
    });
  });

  it("reads one bounded extra page to find an older actual payment", async () => {
    sdk.charges
      .mockResolvedValueOnce(
        page([charge({ id: "ch_first", status: "failed", paid: false })], true),
      )
      .mockResolvedValueOnce(page([charge({ id: "ch_older" })]));
    expect(await createSignupReviewPaymentReader(LIVE)([customer])).toEqual({
      [customer]: "confirmed",
    });
    expect(sdk.charges).toHaveBeenNthCalledWith(
      2,
      { customer, limit: 25, starting_after: "ch_first" },
      { timeout: expect.any(Number), maxNetworkRetries: 0 },
    );
    expect(sdk.charges).toHaveBeenCalledTimes(2);
  });

  it("returns unknown when an unseen third page could contain payment evidence", async () => {
    sdk.charges.mockImplementation(async (params: { starting_after?: string }) =>
      page([charge({ id: params.starting_after ? "ch_second" : "ch_first", amount: 0 })], true),
    );
    expect(await createSignupReviewPaymentReader(LIVE)([customer])).toEqual({
      [customer]: "unknown",
    });
    expect(sdk.charges).toHaveBeenCalledTimes(2);
    expect(sdk.invoices).toHaveBeenCalledTimes(1);
  });

  it("also treats incomplete invoice history as unknown", async () => {
    sdk.invoices.mockImplementation(async (params: { starting_after?: string }) =>
      page([invoice({ id: params.starting_after ? "in_second" : "in_first" })], true),
    );
    expect(await createSignupReviewPaymentReader(LIVE)([customer])).toEqual({
      [customer]: "unknown",
    });
    expect(sdk.invoices).toHaveBeenCalledTimes(2);
  });

  it("caps each batch at 32 unique database customer identifiers and never expands scope by email", async () => {
    const ids = Array.from({ length: 35 }, (_, i) => `cus_synthetic_${i}`);
    const result = await createSignupReviewPaymentReader(LIVE)([
      ...ids,
      ...ids,
      "owner@private.test",
      "__proto__",
    ]);
    expect(Object.keys(result)).toHaveLength(35);
    expect(ids.slice(0, 32).every((id) => result[id] === "not_observed")).toBe(true);
    expect(ids.slice(32).every((id) => result[id] === "unknown")).toBe(true);
    expect(sdk.charges).toHaveBeenCalledTimes(32);
    expect(sdk.invoices).toHaveBeenCalledTimes(32);
    expect(
      sdk.charges.mock.calls.every(([params]) =>
        Object.keys(params).every((key) => ["customer", "limit", "starting_after"].includes(key)),
      ),
    ).toBe(true);
  });

  it("turns network failures into unknown without returning or logging provider exceptions", async () => {
    sdk.charges.mockRejectedValue(new Error("SECRET CUSTOMER ADDRESS private@private.test"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await createSignupReviewPaymentReader(LIVE)([customer])).toEqual({
        [customer]: "unknown",
      });
      expect(sdk.charges).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("bounds concurrent live operations across invocations and does not replace timed-out unfinished calls", async () => {
    vi.useFakeTimers();
    sdk.charges.mockImplementation(() => new Promise(() => {}));
    const read = createSignupReviewPaymentReader(LIVE);
    const ids = Array.from({ length: 5 }, (_, i) => `cus_timeout_${i}`);
    const first = read(ids);
    await vi.advanceTimersByTimeAsync(0);
    expect(sdk.charges).toHaveBeenCalledTimes(3);
    expect(await read(["cus_concurrent"])).toEqual({ cus_concurrent: "unknown" });
    await vi.advanceTimersByTimeAsync(1501);
    expect(Object.values(await first).every((status) => status === "unknown")).toBe(true);
    expect(await read(["cus_after_timeout"])).toEqual({ cus_after_timeout: "unknown" });
    expect(sdk.charges).toHaveBeenCalledTimes(3);
    expect(sdk.invoices).not.toHaveBeenCalled();
  });

  it("stops the entire batch at eight seconds instead of giving each customer a fresh deadline", async () => {
    vi.useFakeTimers();
    let active = 0;
    let peak = 0;
    const slow = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      active -= 1;
      return page();
    };
    sdk.charges.mockImplementation(slow);
    sdk.invoices.mockImplementation(slow);
    const ids = Array.from({ length: 32 }, (_, i) => `cus_bounded_${i}`);
    const pending = createSignupReviewPaymentReader(LIVE)(ids);
    await vi.advanceTimersByTimeAsync(8001);
    const result = await pending;
    expect(peak).toBeLessThanOrEqual(3);
    expect(Object.values(result)).toContain("unknown");
    expect(sdk.charges.mock.calls.length + sdk.invoices.mock.calls.length).toBeLessThanOrEqual(24);
    expect(Object.keys(result)).toHaveLength(32);
  });
});
