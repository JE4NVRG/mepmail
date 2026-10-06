import type { Db } from "@millionsend/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mailboxBillingOffers } from "@/server/mailbox-billing";
import { mailboxesRouter } from "@/server/routers/mailboxes";
import { type Context, createCallerFactory, router } from "@/server/trpc";

const runtime = vi.hoisted(() => ({
  env: {
    STRIPE_SECRET_KEY: "sk_test_customer_checkout_fixture",
    APP_BASE_URL: "https://mepmail.dev",
  },
  begin: vi.fn(),
  getStripe: vi.fn(),
  stripe: { fixture: "no provider methods" },
}));
vi.mock("@millionsend/config", () => ({ env: runtime.env, isCloudDeployment: () => true }));
vi.mock("@millionsend/billing", () => ({
  isLiveKey: (key: string) => /^[sr]k_live_/.test(key),
  MailboxLifecycleError: class extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  },
  beginMailboxCheckout: runtime.begin,
  manageMailboxSubscription: vi.fn(),
  recoverMailboxCheckoutSession: vi.fn(),
}));
vi.mock("@/server/billing", () => ({ getStripe: runtime.getStripe }));
// Checkout does not touch private content, keys, queues or registry mutations.
// Keep its actual router, middleware, catalog resolver and membership presentation.
vi.mock("@millionsend/core", () => {
  class UnusedMailboxError extends Error {}
  return {
    ...Object.fromEntries(
      [
        "appendMailboxActivity",
        "createMailboxAgentKey",
        "createMailboxRegistry",
        "getMailboxReceivingReadiness",
        "grantMailboxRegistry",
        "listMailboxActivity",
        "listMailboxAgentKeys",
        "listMailboxRegistry",
        "mailboxServiceState",
        "queueMailboxDraft",
        "revokeMailboxAgentKey",
        "revokeMailboxRegistry",
        "setMailboxDeliveryFolder",
        "updateMailboxRegistry",
        "withMailboxRegistryAdmin",
        "mailboxDomainLock",
        "recordSupportViewRead",
      ].map((name) => [name, vi.fn()]),
    ),
    MailboxAgentAccessError: UnusedMailboxError,
    MailboxContentError: UnusedMailboxError,
    MailboxRegistryError: UnusedMailboxError,
    MailboxServiceError: UnusedMailboxError,
  };
});
vi.mock("@/server/auth", () => ({ getAuth: vi.fn(), resolveBaseUrl: (base: string) => base }));
vi.mock("@/server/keyring", () => ({ getKeyring: vi.fn() }));
vi.mock("@/server/queue", () => ({
  getQueue: vi.fn(),
  enqueueEmailSend: vi.fn(),
  enqueueWebhookDeliveries: vi.fn(),
}));
vi.mock("@/server/mailbox-content", () => ({
  getMailboxContent: vi.fn(),
  getMailboxContentList: vi.fn(),
  saveMailboxContentDraft: vi.fn(),
}));
vi.mock("@/server/mailbox-transport", () => ({ mailboxTransportMime: {} }));
vi.mock("@/server/mailbox-receiving", () => ({ mailboxReceivingDeps: vi.fn() }));
vi.mock("@/server/audit", () => ({ recordAudit: vi.fn() }));

// Provisional TEST terms only, never a statement of approved LIVE prices.
const small = {
  priceId: "price_customer_fixture_1g",
  currency: "usd",
  unitAmount: 390,
  interval: "month",
  storageBytesPerMailbox: 1073741824,
  includedOutboundPerMailbox: 500,
};
const large = {
  ...small,
  priceId: "price_customer_fixture_10g",
  unitAmount: 690,
  storageBytesPerMailbox: 10737418240,
  includedOutboundPerMailbox: 2000,
};
const historical = { ...small, priceId: "price_customer_fixture_historical", unitAmount: 100 };
const catalog = {
  livemode: false,
  checkoutPriceId: small.priceId,
  checkoutPriceIds: [small.priceId, large.priceId],
  prices: [small, large, historical],
};
const teamId = "11111111-1111-4111-8111-111111111111";
const userId = "customer_checkout_fixture_owner";
const checkoutUrl = "https://checkout.stripe.com/c/pay/customer_fixture";
const paidSendingMember = {
  role: "owner",
  plan: "starter",
  suspendedAt: null as Date | null,
  planStatus: "active",
  stripeCustomerId: "cus_sending_checkout_fixture",
  stripeSubscriptionId: "sub_sending_checkout_fixture",
  currentPeriodStart: new Date("2020-01-01"),
  currentPeriodEnd: new Date("2030-01-01"),
  cancelAt: null as Date | null,
};
type Member = { role: string; plan: string; suspendedAt: Date | null } & Partial<
  typeof paidSendingMember
>;
type Pending = typeof small & { seats: number; livemode: boolean };

/** Only read rows are synthetic. The real presentation rechecks them; this
 * handle has no transaction or writes, and cannot contact a database/provider.
 */
function customer(options: { member?: Member | null; pending?: Pending } = {}) {
  const rows = [
    options.member === null ? [] : [options.member ?? paidSendingMember],
    [],
    [],
    options.pending ? [{ ...options.pending, priceId: options.pending.priceId }] : [],
    [],
    [],
  ];
  let index = 0;
  const select = vi.fn(() => {
    const query = Object.assign(Promise.resolve(rows[index++]), {
      from: (): unknown => query,
      innerJoin: (): unknown => query,
      where: (): unknown => query,
      orderBy: (): unknown => query,
      limit: (): unknown => query,
    });
    return query;
  });
  const db = { select } as unknown as Db;
  const context: Context = {
    db,
    teamId,
    role: "owner",
    session: { user: { id: userId, name: "Synthetic owner", email: "owner@example.invalid" } },
  };
  const createCaller = createCallerFactory(router({ mailboxes: mailboxesRouter }));
  return { db, select, caller: createCaller(context), createCaller, context };
}
function pending(price = large): Pending {
  return { ...price, seats: 2, livemode: false };
}
function offerFor(storageBytes: number) {
  const offer = mailboxBillingOffers().find(
    (entry) => entry.storageBytesPerMailbox === storageBytes,
  );
  if (!offer) throw new Error("missing_fixture_offer");
  return offer.offerId;
}
function noCheckout() {
  expect(runtime.begin).not.toHaveBeenCalled();
  expect(runtime.getStripe).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.resetAllMocks();
  runtime.getStripe.mockReturnValue(runtime.stripe);
  runtime.begin.mockResolvedValue({ url: checkoutUrl });
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  vi.stubEnv("MAILBOX_PILOT_TEAM_IDS", undefined);
  vi.stubEnv("MAILBOX_PILOT_USER_IDS", undefined);
  vi.stubEnv("MAILBOX_BILLING_PAUSED", "false");
  vi.stubEnv("BILLING_MUTATIONS_PAUSED", undefined);
  vi.stubEnv("MAILBOX_BILLING_CATALOG", JSON.stringify(catalog));
});
afterEach(() => vi.unstubAllEnvs());

describe("customer checkout resolves only server-approved mailbox offers", () => {
  it.each([
    { plan: "free" },
    { planStatus: "trialing" },
    { planStatus: "past_due" },
    { stripeSubscriptionId: "" },
    { currentPeriodEnd: new Date(0) },
  ])("requires confirmed Envio before standalone Correio purchase %j", async (changes) => {
    const options = { member: { ...paidSendingMember, ...changes } };
    expect(await customer(options).caller.mailboxes.billing()).toMatchObject({
      canPurchase: false,
      sendingPlanRequired: true,
      availability: "sending_plan_required",
    });
    await expect(customer(options).caller.mailboxes.checkout({ seats: 1 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "sending_plan_required",
    });
    noCheckout();
  });
  it.each([small, large])(
    "selects $storageBytesPerMailbox bytes from the server catalog",
    async (price) => {
      const { caller, db, select } = customer();
      expect(
        await caller.mailboxes.checkout({
          seats: 2,
          offerId: offerFor(price.storageBytesPerMailbox),
        }),
      ).toEqual({ url: checkoutUrl });
      expect(runtime.begin).toHaveBeenCalledExactlyOnceWith(
        {
          db,
          stripe: runtime.stripe,
          requirePaidSendingPlan: true,
          recoverCheckout: expect.any(Function),
        },
        { ...catalog, checkoutPriceId: price.priceId },
        {
          teamId,
          userId,
          seats: 2,
          successUrl: "https://mepmail.dev/mailboxes?checkout=success",
          cancelUrl: "https://mepmail.dev/mailboxes",
        },
      );
      expect(select).toHaveBeenCalledTimes(6);
      expect(runtime.getStripe).toHaveBeenCalledOnce();
    },
  );

  it("preserves the legacy default when there is no pending purchase or selected offer", async () => {
    vi.stubEnv(
      "MAILBOX_BILLING_CATALOG",
      JSON.stringify({ ...catalog, checkoutPriceIds: undefined }),
    );
    await customer().caller.mailboxes.checkout({ seats: 1 });
    expect(runtime.begin.mock.calls[0]?.[1].checkoutPriceId).toBe(small.priceId);
  });

  it.each([
    { amount: 1 },
    { unitAmount: 1 },
    { storageBytesPerMailbox: 999999999999 },
    { includedOutboundPerMailbox: 999999 },
    { stripePriceId: large.priceId },
    { priceId: large.priceId },
  ])(
    "rejects client-controlled financial/limit fields %j before any lookup or checkout",
    async (extra) => {
      const { caller, select } = customer();
      const input = { seats: 1, ...extra } as Parameters<typeof caller.mailboxes.checkout>[0];
      await expect(caller.mailboxes.checkout(input)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(select).not.toHaveBeenCalled();
      noCheckout();
    },
  );

  it("rejects an unknown opaque offer without dispatching a purchase", async () => {
    await expect(
      customer().caller.mailboxes.checkout({ seats: 1, offerId: `mbo_${"x".repeat(43)}` }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "mailbox_billing_unavailable",
    });
    noCheckout();
  });

  it("does not repurchase a historical offer even though its terms remain in the catalog", async () => {
    vi.stubEnv(
      "MAILBOX_BILLING_CATALOG",
      JSON.stringify({
        ...catalog,
        checkoutPriceIds: [...catalog.checkoutPriceIds, historical.priceId],
      }),
    );
    const priorOffer = mailboxBillingOffers().find(
      (entry) => entry.unitAmount === historical.unitAmount,
    );
    if (!priorOffer) throw new Error("missing_fixture_historical_offer");
    const priorId = priorOffer.offerId;
    vi.stubEnv("MAILBOX_BILLING_CATALOG", JSON.stringify(catalog));
    await expect(
      customer().caller.mailboxes.checkout({ seats: 1, offerId: priorId }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "mailbox_billing_unavailable",
    });
    noCheckout();
  });

  it("resumes pending 10 GiB terms without offerId instead of falling back to the 1 GiB default", async () => {
    const { caller } = customer({ pending: pending() });
    await caller.mailboxes.checkout({ seats: 2 });
    expect(runtime.begin.mock.calls[0]?.[1]).toEqual({
      ...catalog,
      checkoutPriceId: large.priceId,
    });
    expect(runtime.begin.mock.calls[0]?.[2].seats).toBe(2);
  });

  it.each(["seats", "offer"])(
    "refuses a conflicting %s while 10 GiB checkout is pending",
    async (field) => {
      const { caller } = customer({ pending: pending() });
      await expect(
        caller.mailboxes.checkout({
          seats: field === "seats" ? 3 : 2,
          ...(field === "offer" ? { offerId: offerFor(small.storageBytesPerMailbox) } : {}),
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "conflict" });
      noCheckout();
    },
  );

  it("rejects a pending contract whose persisted terms differ from the approved offer", async () => {
    const { caller } = customer({ pending: { ...pending(), unitAmount: 1 } });
    await expect(caller.mailboxes.checkout({ seats: 2 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: "conflict",
    });
    noCheckout();
  });

  it.each(["MAILBOX_BILLING_PAUSED", "BILLING_MUTATIONS_PAUSED"])(
    "does not dispatch Stripe while %s is enabled",
    async (flag) => {
      const offerId = offerFor(large.storageBytesPerMailbox);
      vi.stubEnv(flag, "true");
      await expect(
        customer({ pending: pending() }).caller.mailboxes.checkout({ seats: 2, offerId }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "mailbox_billing_unavailable",
      });
      noCheckout();
    },
  );

  it.each([
    { role: "owner", plan: "system", suspendedAt: null },
    { role: "viewer", plan: "free", suspendedAt: null },
    { role: "owner", plan: "free", suspendedAt: new Date(0) },
    null,
  ])(
    "rechecks the current membership/plan rather than trusting the cached owner context %j",
    async (member) => {
      await expect(
        customer({ member }).caller.mailboxes.checkout({ seats: 1 }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      noCheckout();
    },
  );

  it("denies support views before presentation, despite their cached owner role", async () => {
    const { createCaller, context, select } = customer();
    const caller = createCaller({
      ...context,
      supportView: {
        grantId: "22222222-2222-4222-8222-222222222222",
        expiresAt: new Date("2100-01-01"),
      },
    });
    await expect(caller.mailboxes.checkout({ seats: 1 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(select).not.toHaveBeenCalled();
    noCheckout();
  });
});
