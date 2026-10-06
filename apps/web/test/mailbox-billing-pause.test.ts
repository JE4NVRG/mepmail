import type { Db } from "@millionsend/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mailboxBillingCatalog,
  mailboxBillingCatalogForOffer,
  mailboxBillingMutationsPaused,
  mailboxBillingOffer,
  mailboxBillingOffers,
  mailboxBillingPresentation,
  mailboxManagementEnabled,
} from "@/server/mailbox-billing";

const runtime = vi.hoisted(() => ({
  env: { STRIPE_SECRET_KEY: "sk_test_mail_pause_fixture" },
  cloud: true,
  getStripe: vi.fn(),
}));
vi.mock("@millionsend/config", () => ({
  env: runtime.env,
  isCloudDeployment: () => runtime.cloud,
}));
vi.mock("@millionsend/billing", () => ({
  isLiveKey: (key: string) => /^[sr]k_live_/.test(key),
  MailboxLifecycleError: class extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  },
  recoverMailboxCheckoutSession: vi.fn(),
}));
vi.mock("@/server/billing", () => ({ getStripe: runtime.getStripe }));

// Synthetic operator terms; these are not an approved public price or allowance.
const price = {
  priceId: "price_mail_pause_fixture",
  currency: "usd",
  unitAmount: 123,
  interval: "month",
  storageBytesPerMailbox: 4096,
  includedOutboundPerMailbox: 17,
};
const catalog = { livemode: false, checkoutPriceId: price.priceId, prices: [price] };
const actor = { teamId: "fixture-team", userId: "fixture-owner" };
const subscription = {
  status: "active",
  stripeCustomerId: "cus_pause_fixture",
  stripeSubscriptionId: "sub_pause_fixture",
  stripeSubscriptionItemId: "si_pause_fixture",
  livemode: false,
  periodEnd: new Date("2030-01-01T00:00:00Z"),
  cancelAtPeriodEnd: false,
  lastEventCreated: 1,
};

/** Only the selected read rows are stubbed; production presentation and flag logic run.
 * Writes/transactions/provider methods are deliberately absent from this handle.
 */
function presentationDb(
  options: {
    member?: { role: string; suspendedAt: Date | null; plan: string } | null;
    subscription?: typeof subscription | null;
    checkout?: {
      priceId: string;
      seats: number;
      livemode: boolean;
      currency: string;
      unitAmount: number;
      interval: string;
      storageBytesPerMailbox: number;
      includedOutboundPerMailbox: number;
    } | null;
    managementRequest?: {
      action: string;
      status: string;
      seats: number;
      effectiveAt: Date;
    } | null;
  } = {},
) {
  const rows = [
    options.member === null
      ? []
      : [
          options.member ?? {
            role: "owner",
            suspendedAt: null,
            plan: "starter",
            planStatus: "active",
            stripeCustomerId: "cus_sending_pause_fixture",
            stripeSubscriptionId: "sub_sending_pause_fixture",
            currentPeriodStart: new Date("2020-01-01"),
            currentPeriodEnd: new Date("2030-01-01"),
            cancelAt: null,
          },
        ],
    options.subscription === null ? [] : [options.subscription ?? subscription],
    [],
    options.checkout ? [options.checkout] : [],
    [],
    options.managementRequest ? [options.managementRequest] : [],
  ];
  let index = 0;
  const select = vi.fn(() => {
    const result = Promise.resolve(rows[index++]);
    const query = Object.assign(result, {
      from: (): unknown => query,
      innerJoin: (): unknown => query,
      where: (): unknown => query,
      orderBy: (): unknown => query,
      limit: (): unknown => query,
    });
    return query;
  });
  return { db: { select } as unknown as Db, select };
}

beforeEach(() => {
  runtime.env.STRIPE_SECRET_KEY = "sk_test_mail_pause_fixture";
  runtime.cloud = true;
  runtime.getStripe.mockReset();
  vi.stubEnv("MAILBOX_BILLING_PAUSED", undefined);
  vi.stubEnv("BILLING_MUTATIONS_PAUSED", undefined);
  vi.stubEnv("MAILBOX_BILLING_MANAGEMENT_ENABLED", "true");
  vi.stubEnv("MAILBOX_BILLING_CATALOG", JSON.stringify(catalog));
});
afterEach(() => vi.unstubAllEnvs());

describe("Mail-only billing pause and read-only contract presentation", () => {
  it.each([undefined, "0", "false"])("permits explicit known unpaused state %s", (value) => {
    vi.stubEnv("MAILBOX_BILLING_PAUSED", value);
    expect(mailboxBillingMutationsPaused()).toBe(false);
    expect(mailboxBillingOffer()).toMatchObject({ unitAmount: price.unitAmount });
  });

  it.each(["1", "true", "", "False", "unknown"])(
    "fails closed for enabled or unrecognized Mail pause %s without hiding the catalog",
    (value) => {
      vi.stubEnv("MAILBOX_BILLING_PAUSED", value);
      expect(mailboxBillingMutationsPaused()).toBe(true);
      expect(mailboxBillingOffer()).toBeNull();
      expect(mailboxBillingCatalog()).toEqual(catalog);
    },
  );

  it.each(["1", "true"])("preserves the existing global pause %s", (value) => {
    vi.stubEnv("MAILBOX_BILLING_PAUSED", "false");
    vi.stubEnv("BILLING_MUTATIONS_PAUSED", value);
    expect(mailboxBillingMutationsPaused()).toBe(true);
    expect(mailboxBillingOffer()).toBeNull();
    expect(mailboxManagementEnabled()).toBe(false);
  });

  it("blocks a new purchase and preserves read access when no subscription exists", async () => {
    vi.stubEnv("MAILBOX_BILLING_PAUSED", "true");
    const { db, select } = presentationDb({ subscription: null });
    expect(await mailboxBillingPresentation(db, actor)).toMatchObject({
      canManage: true,
      canPurchase: false,
      availability: "unavailable",
      offer: null,
    });
    expect(select).toHaveBeenCalledTimes(6);
    expect(runtime.getStripe).not.toHaveBeenCalled();
  });

  it("keeps current contract reconciliation visible while blocking adjustment/cancellation", async () => {
    vi.stubEnv("MAILBOX_BILLING_PAUSED", "true");
    expect(await mailboxBillingPresentation(presentationDb().db, actor)).toMatchObject({
      availability: "existing_subscription",
      canPurchase: false,
      management: {
        canReconcile: true,
        canCancel: false,
        canResume: false,
        canAdjust: false,
      },
    });
    expect(runtime.getStripe).not.toHaveBeenCalled();
  });

  it("does not let a paused canceled-renewal contract resume, and keeps pending quantities readable", async () => {
    vi.stubEnv("MAILBOX_BILLING_PAUSED", "true");
    const { db } = presentationDb({
      subscription: { ...subscription, cancelAtPeriodEnd: true },
      managementRequest: {
        action: "increase",
        status: "pending",
        seats: 3,
        effectiveAt: subscription.periodEnd,
      },
    });
    expect(await mailboxBillingPresentation(db, actor)).toMatchObject({
      management: {
        canReconcile: true,
        canResume: false,
        pending: true,
        requestedSeats: 3,
      },
    });
  });

  it("restores normal financial controls only after an explicit unpause", async () => {
    vi.stubEnv("MAILBOX_BILLING_PAUSED", "false");
    expect(await mailboxBillingPresentation(presentationDb().db, actor)).toMatchObject({
      management: { canReconcile: true, canCancel: true, canResume: false, canAdjust: true },
    });
    expect(
      await mailboxBillingPresentation(
        presentationDb({ subscription: { ...subscription, cancelAtPeriodEnd: true } }).db,
        actor,
      ),
    ).toMatchObject({ management: { canResume: true, canCancel: false, canAdjust: false } });
  });

  it("does not widen System, ordinary member, suspended or missing-member authority", async () => {
    vi.stubEnv("MAILBOX_BILLING_PAUSED", "true");
    for (const member of [
      { role: "owner", plan: "system", suspendedAt: null },
      { role: "member", plan: "free", suspendedAt: null },
      { role: "owner", plan: "free", suspendedAt: new Date() },
    ]) {
      expect(await mailboxBillingPresentation(presentationDb({ member }).db, actor)).toMatchObject({
        canPurchase: false,
        availability: "forbidden",
        management: { canReconcile: false, canCancel: false, canResume: false, canAdjust: false },
      });
    }
    await expect(
      mailboxBillingPresentation(presentationDb({ member: null }).db, actor),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("operator catalog changes stay bounded and do not create entitlements", () => {
  it("selects one new approved offer while keeping historical storage/price terms intact", () => {
    const next = { ...price, priceId: "price_mail_next_fixture", storageBytesPerMailbox: 8192 };
    vi.stubEnv(
      "MAILBOX_BILLING_CATALOG",
      JSON.stringify({ ...catalog, checkoutPriceId: next.priceId, prices: [price, next] }),
    );
    expect(mailboxBillingCatalog()?.prices).toEqual([price, next]);
    expect(mailboxBillingOffer()).toEqual({
      currency: next.currency,
      unitAmount: next.unitAmount,
      interval: next.interval,
      storageBytesPerMailbox: next.storageBytesPerMailbox,
      includedOutboundPerMailbox: next.includedOutboundPerMailbox,
    });
    expect(runtime.getStripe).not.toHaveBeenCalled();
  });

  it("rejects ambiguous IDs, mode mismatches, unsafe limits and unknown catalog fields", () => {
    for (const invalid of [
      { ...catalog, prices: [price, price] },
      { ...catalog, livemode: true },
      { ...catalog, prices: [{ ...price, storageBytesPerMailbox: 0 }] },
      { ...catalog, prices: [{ ...price, storageBytesPerMailbox: 10995116277761 }] },
      { ...catalog, prices: [{ ...price, includedOutboundPerMailbox: 1000001 }] },
      { ...catalog, prices: [{ ...price, unlimitedSeats: true }] },
      { ...catalog, publicLaunch: true },
    ]) {
      vi.stubEnv("MAILBOX_BILLING_CATALOG", JSON.stringify(invalid));
      expect(mailboxBillingCatalog()).toBeNull();
      expect(mailboxBillingOffer()).toBeNull();
    }
    vi.stubEnv("MAILBOX_BILLING_CATALOG", JSON.stringify({ ...catalog, checkoutPriceId: null }));
    expect(mailboxBillingCatalog()).toEqual({ ...catalog, checkoutPriceId: null });
    expect(mailboxBillingOffer()).toBeNull();
  });
});

describe("server-owned selectable offers and immutable pending purchases", () => {
  const larger = {
    ...price,
    priceId: "price_mail_ten_gib_fixture",
    unitAmount: 690,
    storageBytesPerMailbox: 10737418240,
    includedOutboundPerMailbox: 2000,
  };
  const historical = { ...price, priceId: "price_mail_historical_fixture", unitAmount: 100 };
  const multiple = {
    ...catalog,
    checkoutPriceIds: [price.priceId, larger.priceId],
    prices: [price, larger, historical],
  };
  function useMultiple() {
    vi.stubEnv("MAILBOX_BILLING_CATALOG", JSON.stringify(multiple));
    return mailboxBillingOffers();
  }
  function pendingLarger() {
    const { priceId, ...value } = larger;
    return { ...value, priceId, seats: 2, livemode: false };
  }

  it("falls back to the single legacy default and keeps archived prices unpurchasable", () => {
    vi.stubEnv(
      "MAILBOX_BILLING_CATALOG",
      JSON.stringify({ ...catalog, prices: [price, historical] }),
    );
    const offers = mailboxBillingOffers();
    expect(offers).toHaveLength(1);
    expect(offers[0]?.offerId).toMatch(/^mbo_[A-Za-z0-9_-]{43}$/);
    expect(mailboxBillingCatalogForOffer()?.checkoutPriceId).toBe(price.priceId);
    expect(mailboxBillingCatalogForOffer(offers[0]?.offerId)?.checkoutPriceId).toBe(price.priceId);
    expect(mailboxBillingCatalogForOffer(historical.priceId)).toBeNull();
    expect(JSON.stringify(offers)).not.toContain("price_");
    vi.stubEnv(
      "MAILBOX_BILLING_CATALOG",
      JSON.stringify({
        ...catalog,
        checkoutPriceIds: [price.priceId, historical.priceId],
        prices: [price, historical],
      }),
    );
    const archivedId = mailboxBillingOffers().find(
      (entry) => entry.unitAmount === historical.unitAmount,
    )?.offerId;
    expect(archivedId).toBeDefined();
    vi.stubEnv(
      "MAILBOX_BILLING_CATALOG",
      JSON.stringify({ ...catalog, prices: [price, historical] }),
    );
    expect(mailboxBillingCatalogForOffer(archivedId)).toBeNull();
  });

  it("selects 10GiB only by a stable opaque server offer and retains the legacy default DTO", () => {
    const offers = useMultiple();
    expect(offers).toHaveLength(2);
    const large = offers.find(
      (entry) => entry.storageBytesPerMailbox === larger.storageBytesPerMailbox,
    );
    expect(large).toMatchObject({ unitAmount: 690, includedOutboundPerMailbox: 2000 });
    expect(mailboxBillingCatalogForOffer(large?.offerId)?.checkoutPriceId).toBe(larger.priceId);
    expect(mailboxBillingOffers()).toEqual(offers);
    expect(mailboxBillingCatalogForOffer()?.checkoutPriceId).toBe(price.priceId);
    expect(mailboxBillingOffer()).toEqual({
      currency: price.currency,
      unitAmount: price.unitAmount,
      interval: price.interval,
      storageBytesPerMailbox: price.storageBytesPerMailbox,
      includedOutboundPerMailbox: price.includedOutboundPerMailbox,
    });
    expect(mailboxBillingCatalogForOffer(larger.priceId)).toBeNull();
    expect(mailboxBillingCatalogForOffer(`mbo_${"x".repeat(43)}`)).toBeNull();
    expect(JSON.stringify(offers)).not.toMatch(/price_|checkoutPrice|livemode|unlimited/);
  });

  it("rejects duplicate, unreferenced, malformed, oversized or default-inconsistent offer lists", () => {
    for (const checkoutPriceIds of [
      [price.priceId, price.priceId],
      [price.priceId, "price_missing_fixture"],
      [price.priceId, "invalid"],
      Array.from({ length: 11 }, () => price.priceId),
      [larger.priceId],
      [],
    ]) {
      vi.stubEnv("MAILBOX_BILLING_CATALOG", JSON.stringify({ ...multiple, checkoutPriceIds }));
      expect(mailboxBillingCatalog()).toBeNull();
      expect(mailboxBillingOffers()).toEqual([]);
      expect(mailboxBillingCatalogForOffer()).toBeNull();
    }
    vi.stubEnv(
      "MAILBOX_BILLING_CATALOG",
      JSON.stringify({ ...multiple, checkoutPriceId: null, checkoutPriceIds: [] }),
    );
    expect(mailboxBillingCatalog()).not.toBeNull();
    expect(mailboxBillingOffers()).toEqual([]);
  });

  it("permits explicit offers without silently inventing a default selection", () => {
    vi.stubEnv("MAILBOX_BILLING_CATALOG", JSON.stringify({ ...multiple, checkoutPriceId: null }));
    const [selected] = mailboxBillingOffers();
    expect(selected).toBeDefined();
    expect(mailboxBillingOffer()).toBeNull();
    expect(mailboxBillingCatalogForOffer()).toBeNull();
    expect(mailboxBillingCatalogForOffer(selected?.offerId)?.checkoutPriceId).toBe(price.priceId);
  });

  it("resumes the allowed pending 10GiB purchase even when the default is the smaller offer", async () => {
    const offers = useMultiple();
    const pending = offers.find(
      (entry) => entry.storageBytesPerMailbox === larger.storageBytesPerMailbox,
    );
    expect(
      await mailboxBillingPresentation(
        presentationDb({ subscription: null, checkout: pendingLarger() }).db,
        actor,
      ),
    ).toMatchObject({
      canPurchase: true,
      availability: "available",
      defaultOfferId: offers[0]?.offerId,
      pendingCheckoutSeats: 2,
      pendingOfferId: pending?.offerId,
      pendingOffer: pending,
      offer: { storageBytesPerMailbox: price.storageBytesPerMailbox },
    });
    expect(runtime.getStripe).not.toHaveBeenCalled();
  });

  it("keeps an altered, wrong-mode or no-longer-purchasable pending offer in recovery", async () => {
    useMultiple();
    for (const checkout of [
      { ...pendingLarger(), unitAmount: 1 },
      { ...pendingLarger(), storageBytesPerMailbox: 1 },
      { ...pendingLarger(), includedOutboundPerMailbox: 1 },
      { ...pendingLarger(), livemode: true },
      { ...pendingLarger(), priceId: historical.priceId },
    ]) {
      expect(
        await mailboxBillingPresentation(
          presentationDb({ subscription: null, checkout }).db,
          actor,
        ),
      ).toMatchObject({
        canPurchase: false,
        availability: "recovery_required",
        pendingOfferId: null,
        pendingOffer: null,
      });
    }
    vi.stubEnv(
      "MAILBOX_BILLING_CATALOG",
      JSON.stringify({ ...multiple, checkoutPriceIds: [price.priceId] }),
    );
    expect(
      await mailboxBillingPresentation(
        presentationDb({ subscription: null, checkout: pendingLarger() }).db,
        actor,
      ),
    ).toMatchObject({
      canPurchase: false,
      availability: "recovery_required",
      pendingOfferId: null,
      pendingOffer: null,
    });
  });

  it("keeps pending 10GiB terms readable during pause while closing selection and preserving reconciliation", async () => {
    const offers = useMultiple();
    const pending = offers.find(
      (entry) => entry.storageBytesPerMailbox === larger.storageBytesPerMailbox,
    );
    vi.stubEnv("MAILBOX_BILLING_PAUSED", "true");
    expect(mailboxBillingOffers()).toEqual([]);
    expect(mailboxBillingCatalogForOffer(pending?.offerId)).toBeNull();
    expect(
      await mailboxBillingPresentation(presentationDb({ checkout: pendingLarger() }).db, actor),
    ).toMatchObject({
      canPurchase: false,
      offers: [],
      defaultOfferId: null,
      pendingOfferId: pending?.offerId,
      pendingOffer: pending,
      management: { canReconcile: true, canAdjust: false, canCancel: false, canResume: false },
    });
  });
});
