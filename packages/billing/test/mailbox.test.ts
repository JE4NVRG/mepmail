import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMailboxCheckoutSession,
  isMailboxSubscription,
  type MailboxCatalog,
  type MailboxCheckoutInput,
  type MailboxIncreaseEvidence,
  type MailboxPriceTerms,
  mailboxIncreaseInvoiceMatches,
  mailboxIncreasePaymentConfirmed,
  projectMailboxSubscription,
} from "../src/mailbox.js";
import type { BillingStripe } from "../src/stripe.js";
import { applySubscription, reconcileTeamPlan } from "../src/subscription.js";
import { handleWebhook } from "../src/webhook.js";
import { fakeStripe, PERIOD_END, PERIOD_START, subscription, webhooks } from "./helpers.js";

// Synthetic contract values only. No launch price or external Stripe resource is configured.
const TERMS: MailboxPriceTerms = {
  priceId: "price_mailbox_fixture",
  currency: "usd",
  unitAmount: 123,
  interval: "month",
  storageBytesPerMailbox: 4096,
  includedOutboundPerMailbox: 7,
};
const CATALOG: MailboxCatalog = {
  livemode: false,
  checkoutPriceId: TERMS.priceId,
  prices: [TERMS],
};
/** US$12.90 covering 3 mailboxes, US$3.90 each above them, one shared allowance. */
const TIERED: MailboxPriceTerms = {
  priceId: "price_mailbox_tiered_fixture",
  currency: "usd",
  unitAmount: 1290,
  interval: "month",
  storageBytesPerMailbox: 10 * 1024 ** 3,
  includedOutboundPerMailbox: 2000,
  quotaScope: "team",
  includedMailboxes: 3,
  extraUnitAmount: 390,
  trialDays: 7,
  localCurrency: { currency: "brl", unitAmount: 6490, extraUnitAmount: 1990 },
};
const OWNER = { teamId: "team_fixture", customerId: "cus_1" };

function mailSubscription(
  id = "sub_mail",
  status: Stripe.Subscription.Status = "active",
  terms = TERMS,
): Stripe.Subscription {
  const sub = subscription(id, OWNER.customerId, status);
  sub.metadata = { mepmail_service: "mailbox", team_id: "untrusted_metadata_team" };
  sub.created = PERIOD_START - 100;
  sub.livemode = false;
  sub.cancel_at_period_end = false;
  const item = sub.items.data[0]!;
  item.quantity = 3;
  item.price = {
    ...item.price,
    id: terms.priceId,
    currency: terms.currency,
    unit_amount: terms.unitAmount,
    billing_scheme: "per_unit",
    transform_quantity: null,
    recurring: {
      ...item.price.recurring!,
      interval: terms.interval,
      interval_count: 1,
      usage_type: "licensed",
    },
  };
  return sub;
}

describe("Mailbox increase invoice evidence", () => {
  function fixture(unitAmount: Stripe.Decimal | null | undefined = null) {
    const sub = mailSubscription();
    sub.pending_update = null;
    const item = sub.items.data[0]!;
    const owner: MailboxIncreaseEvidence = {
      customerId: OWNER.customerId,
      livemode: false,
      seats: 3,
      periodStart: new Date(PERIOD_START * 1000),
      periodEnd: new Date(PERIOD_END * 1000),
      prorationAt: new Date((PERIOD_START + 10) * 1000),
      previousInvoiceId: "in_previous",
      invoiceId: "in_proration",
    };
    const line = {
      invoice: owner.invoiceId,
      livemode: false,
      currency: TERMS.currency,
      quantity: 3,
      quantity_decimal: "3",
      amount: TERMS.unitAmount * 3,
      pricing: {
        type: "price_details",
        price_details: { price: TERMS.priceId },
        ...(unitAmount === undefined ? {} : { unit_amount_decimal: unitAmount }),
      },
      period: { start: PERIOD_START + 10, end: PERIOD_END },
      parent: {
        type: "subscription_item_details",
        subscription_item_details: {
          subscription: sub.id,
          subscription_item: item.id,
          proration: true,
          proration_details: null,
        },
      },
    };
    const invoice = {
      id: owner.invoiceId,
      customer: OWNER.customerId,
      livemode: false,
      currency: TERMS.currency,
      billing_reason: "subscription_update",
      status: "paid",
      amount_remaining: 0,
      parent: { subscription_details: { subscription: sub.id } },
      lines: {
        has_more: false,
        data: [
          {
            ...line,
            amount: -TERMS.unitAmount * 2,
            quantity: 2,
            parent: {
              ...line.parent,
              subscription_item_details: {
                ...line.parent.subscription_item_details,
                proration_details: {
                  credited_items: { invoice: "in_previous", invoice_line_items: ["il_previous"] },
                },
              },
            },
          },
          line,
        ],
      },
    } as unknown as Stripe.Invoice;
    return { sub, owner, invoice, debit: invoice.lines.data[1]! };
  }

  it.each(["null", "absent"])(
    "confirms a paid credit/debit proration with %s unit amount and its canonical price",
    (kind) => {
      const { sub, owner, invoice, debit } = fixture();
      if (kind === "absent") Reflect.deleteProperty(debit.pricing!, "unit_amount_decimal");
      expect(mailboxIncreaseInvoiceMatches(sub, owner, invoice)).toBe(true);
      expect(mailboxIncreasePaymentConfirmed(sub, owner, invoice)).toBe(true);
    },
  );

  it("retains exact unit amount validation when Stripe supplies it", () => {
    const { sub, owner, invoice, debit } = fixture(Stripe.Decimal.from(TERMS.unitAmount));
    expect(mailboxIncreasePaymentConfirmed(sub, owner, invoice)).toBe(true);
    debit.pricing!.unit_amount_decimal = Stripe.Decimal.from(TERMS.unitAmount + 1);
    expect(mailboxIncreaseInvoiceMatches(sub, owner, invoice)).toBe(false);
    expect(mailboxIncreasePaymentConfirmed(sub, owner, invoice)).toBe(false);
  });

  it.each([
    "other_price",
    "other_quantity",
    "other_item",
    "other_subscription",
    "other_customer",
    "other_mode",
    "other_currency",
    "other_invoice",
    "other_period",
    "other_proration_date",
    "not_proration",
    "zero_debit",
    "credited_debit",
    "duplicate_debit",
    "incomplete_lines",
    "previous_invoice",
    "unexpected_invoice",
    "invalid_subscription_amount",
  ])("keeps rejecting incompatible evidence with absent unit amount: %s", (field) => {
    const { sub, owner, invoice, debit } = fixture();
    Reflect.deleteProperty(debit.pricing!, "unit_amount_decimal");
    if (field === "other_price") debit.pricing!.price_details!.price = "price_other";
    if (field === "other_quantity") debit.quantity = 2;
    if (field === "other_item")
      debit.parent!.subscription_item_details!.subscription_item = "si_other";
    if (field === "other_subscription")
      debit.parent!.subscription_item_details!.subscription = "sub_other";
    if (field === "other_customer") invoice.customer = "cus_other";
    if (field === "other_mode") invoice.livemode = true;
    if (field === "other_currency") debit.currency = "eur";
    if (field === "other_invoice") debit.invoice = "in_other";
    if (field === "other_period") debit.period.end--;
    if (field === "other_proration_date") debit.period.start++;
    if (field === "not_proration") debit.parent!.subscription_item_details!.proration = false;
    if (field === "zero_debit") debit.amount = 0;
    if (field === "credited_debit")
      debit.parent!.subscription_item_details!.proration_details = {
        credited_items: { invoice: "in_previous", invoice_line_items: ["il_previous"] },
      };
    if (field === "duplicate_debit") invoice.lines.data.push({ ...debit });
    if (field === "incomplete_lines") invoice.lines.has_more = true;
    if (field === "previous_invoice") owner.previousInvoiceId = invoice.id;
    if (field === "unexpected_invoice") owner.invoiceId = "in_other";
    if (field === "invalid_subscription_amount") sub.items.data[0]!.price.unit_amount = null;
    expect(mailboxIncreaseInvoiceMatches(sub, owner, invoice)).toBe(false);
    expect(mailboxIncreasePaymentConfirmed(sub, owner, invoice)).toBe(false);
  });

  it.each(["unpaid", "remaining_balance", "pending_update"])(
    "does not confirm payment merely from a matching proration: %s",
    (field) => {
      const { sub, owner, invoice } = fixture();
      if (field === "unpaid") invoice.status = "open";
      if (field === "remaining_balance") invoice.amount_remaining = 1;
      if (field === "pending_update")
        sub.pending_update = { expires_at: PERIOD_END } as Stripe.Subscription.PendingUpdate;
      expect(mailboxIncreaseInvoiceMatches(sub, owner, invoice)).toBe(true);
      expect(mailboxIncreasePaymentConfirmed(sub, owner, invoice)).toBe(false);
    },
  );
});

describe("Mailbox tiered price projection", () => {
  const catalog: MailboxCatalog = { ...CATALOG, prices: [TERMS, TIERED] };
  const tiered = (status: Stripe.Subscription.Status = "trialing") => {
    const sub = mailSubscription("sub_tiered", status, TIERED);
    const item = sub.items.data[0]!;
    item.price = {
      ...item.price,
      unit_amount: null,
      billing_scheme: "tiered",
      tiers_mode: "graduated",
    };
    return sub;
  };

  it("grants the tiered contract its shared allowance, included mailboxes and trial status", () => {
    expect(projectMailboxSubscription(tiered(), catalog, OWNER)).toMatchObject({
      status: "trialing",
      seats: 3,
      quotaScope: "team",
      includedMailboxes: 3,
      extraUnitAmount: 390,
      storageBytesPerMailbox: 10 * 1024 ** 3,
      includedOutboundPerMailbox: 2000,
      unitAmount: 1290,
    });
  });

  it("refuses a per-unit item under tiered terms and a tiered item under per-unit terms", () => {
    expect(
      projectMailboxSubscription(mailSubscription("sub_tiered", "active", TIERED), catalog, OWNER),
    ).toBeNull();
    const perUnitAsTiered = mailSubscription("sub_plain", "active", TERMS);
    perUnitAsTiered.items.data[0]!.price.billing_scheme = "tiered";
    expect(projectMailboxSubscription(perUnitAsTiered, catalog, OWNER)).toBeNull();
  });
});

describe("Mailbox subscription projection", () => {
  it("projects a trusted licensed quantity and its contract, using the linked owner", () => {
    expect(projectMailboxSubscription(mailSubscription(), CATALOG, OWNER)).toEqual({
      teamId: OWNER.teamId,
      status: "active",
      seats: 3,
      storageBytesPerMailbox: 4096,
      includedOutboundPerMailbox: 7,
      quotaScope: "mailbox",
      includedMailboxes: 1,
      extraUnitAmount: null,
      periodStart: new Date(PERIOD_START * 1000),
      periodEnd: new Date(PERIOD_END * 1000),
      stripeCustomerId: OWNER.customerId,
      stripeSubscriptionId: "sub_mail",
      stripeSubscriptionItemId: "si_sub_mail",
      stripePriceId: TERMS.priceId,
      stripeSubscriptionCreated: PERIOD_START - 100,
      currency: "usd",
      unitAmount: 123,
      interval: "month",
      cancelAtPeriodEnd: false,
      cancelAt: null,
      livemode: false,
    });
  });

  it("keeps approved archived price terms when the checkout catalog rotates", () => {
    const archived = { ...TERMS, priceId: "price_archived", unitAmount: 101 };
    const rotated = { ...TERMS, unitAmount: 456, storageBytesPerMailbox: 8192 };
    const catalog = { ...CATALOG, prices: [archived, rotated] };
    expect(
      projectMailboxSubscription(mailSubscription("sub_old", "active", archived), catalog, OWNER),
    ).toMatchObject({
      stripePriceId: "price_archived",
      unitAmount: 101,
      storageBytesPerMailbox: 4096,
    });
    // Disabling new checkout does not discard a still-approved existing contract.
    expect(
      projectMailboxSubscription(mailSubscription(), { ...CATALOG, checkoutPriceId: null }, OWNER),
    ).not.toBeNull();
  });

  it.each([
    ["active", "active"],
    ["trialing", "trialing"],
    ["past_due", "past_due"],
    ["canceled", "canceled"],
    ["incomplete", "inactive"],
    ["incomplete_expired", "inactive"],
    ["unpaid", "inactive"],
    ["paused", "inactive"],
  ] as const)(
    "maps %s without promoting a failed or unfinished payment",
    (stripeStatus, status) => {
      expect(
        projectMailboxSubscription(mailSubscription("sub_mail", stripeStatus), CATALOG, OWNER)
          ?.status,
      ).toBe(status);
    },
  );

  it("mirrors scheduled cancellation and leaves period enforcement to the paid-operation guard", () => {
    const sub = mailSubscription();
    sub.cancel_at_period_end = true;
    sub.cancel_at = PERIOD_END;
    expect(projectMailboxSubscription(sub, CATALOG, OWNER)).toMatchObject({
      cancelAtPeriodEnd: true,
      cancelAt: new Date(PERIOD_END * 1000),
      periodEnd: new Date(PERIOD_END * 1000),
    });
  });

  const invalidSubscriptions: [string, (sub: Stripe.Subscription) => void][] = [
    [
      "missing subscription tag",
      (sub) => {
        sub.metadata = {};
      },
    ],
    [
      "other Customer",
      (sub) => {
        sub.customer = "cus_other";
      },
    ],
    [
      "other mode",
      (sub) => {
        sub.livemode = true;
      },
    ],
    [
      "unknown price",
      (sub) => {
        sub.items.data[0]!.price.id = "price_other";
      },
    ],
    [
      "other amount",
      (sub) => {
        sub.items.data[0]!.price.unit_amount = 999;
      },
    ],
    [
      "other currency",
      (sub) => {
        sub.items.data[0]!.price.currency = "brl";
      },
    ],
    [
      "metered quantity",
      (sub) => {
        sub.items.data[0]!.price.recurring!.usage_type = "metered";
      },
    ],
    [
      "tiered price",
      (sub) => {
        sub.items.data[0]!.price.billing_scheme = "tiered";
      },
    ],
    [
      "transformed quantity",
      (sub) => {
        sub.items.data[0]!.price.transform_quantity = { divide_by: 2, round: "up" };
      },
    ],
    [
      "other interval",
      (sub) => {
        sub.items.data[0]!.price.recurring!.interval = "year";
      },
    ],
    [
      "multiple-month interval",
      (sub) => {
        sub.items.data[0]!.price.recurring!.interval_count = 2;
      },
    ],
    [
      "fractional seats",
      (sub) => {
        sub.items.data[0]!.quantity = 1.5;
      },
    ],
    [
      "zero seats",
      (sub) => {
        sub.items.data[0]!.quantity = 0;
      },
    ],
    [
      "excess seats",
      (sub) => {
        sub.items.data[0]!.quantity = 10001;
      },
    ],
    [
      "extra subscription item",
      (sub) => {
        sub.items.data.push({ ...sub.items.data[0]!, id: "si_extra" });
      },
    ],
    [
      "invalid period",
      (sub) => {
        sub.items.data[0]!.current_period_end = PERIOD_START;
      },
    ],
    [
      "invalid subscription creation",
      (sub) => {
        sub.created = Number.NaN;
      },
    ],
  ];
  it.each(invalidSubscriptions)("denies an unavailable contract: %s", (_name, mutate) => {
    const sub = mailSubscription();
    mutate(sub);
    expect(projectMailboxSubscription(sub, CATALOG, OWNER)).toBeNull();
  });

  it("fails closed without configuration or with ambiguous/unsafe configured limits", () => {
    const sub = mailSubscription();
    expect(projectMailboxSubscription(sub, null, OWNER)).toBeNull();
    expect(projectMailboxSubscription(sub, { ...CATALOG, prices: [] }, OWNER)).toBeNull();
    expect(
      projectMailboxSubscription(sub, { ...CATALOG, prices: [TERMS, TERMS] }, OWNER),
    ).toBeNull();
    expect(
      projectMailboxSubscription(
        sub,
        {
          ...CATALOG,
          prices: [{ ...TERMS, storageBytesPerMailbox: Number.MAX_SAFE_INTEGER + 1 }],
        },
        OWNER,
      ),
    ).toBeNull();
    expect(
      projectMailboxSubscription(
        sub,
        {
          ...CATALOG,
          prices: [{ ...TERMS, includedOutboundPerMailbox: -1 }],
        },
        OWNER,
      ),
    ).toBeNull();
  });

  it("uses price/product tags to exclude Mail from Send without granting untagged Mail access", () => {
    const sub = mailSubscription();
    sub.metadata = {};
    sub.items.data[0]!.price.metadata = { mepmail_service: "mailbox" };
    expect(isMailboxSubscription(sub)).toBe(true);
    expect(projectMailboxSubscription(sub, CATALOG, OWNER)).toBeNull();
    sub.items.data[0]!.price.metadata = {};
    sub.items.data[0]!.price.product = {
      id: "prod_mail",
      metadata: { mepmail_service: "mailbox" },
    } as unknown as Stripe.Product;
    expect(isMailboxSubscription(sub)).toBe(true);
    expect(projectMailboxSubscription(sub, CATALOG, OWNER)).toBeNull();
  });
});

describe("Mailbox Checkout factory", () => {
  const input: MailboxCheckoutInput = {
    teamId: OWNER.teamId,
    customerId: OWNER.customerId,
    seats: 3,
    successUrl: "https://app.example.com/mailboxes?checkout=success",
    cancelUrl: "https://app.example.com/mailboxes",
    idempotencyKey: "mailbox-checkout:server-purchase-fixture",
  };

  it("sells one quantity-based item, tags its subscription and forwards a stable server key", async () => {
    const { stripe, state } = fakeStripe();
    const options: (Stripe.RequestOptions | undefined)[] = [];
    const create = stripe.checkout.sessions.create;
    stripe.checkout.sessions.create = async (params, requestOptions) => {
      options.push(requestOptions);
      return create(params, requestOptions);
    };
    await createMailboxCheckoutSession(stripe, CATALOG, input);
    await createMailboxCheckoutSession(stripe, CATALOG, input);
    expect(options).toEqual([
      { idempotencyKey: input.idempotencyKey },
      { idempotencyKey: input.idempotencyKey },
    ]);
    expect(state.checkouts[0]).toMatchObject({
      mode: "subscription",
      customer: OWNER.customerId,
      line_items: [{ price: TERMS.priceId, quantity: 3 }],
      metadata: { mepmail_service: "mailbox", team_id: OWNER.teamId },
      subscription_data: { metadata: { mepmail_service: "mailbox", team_id: OWNER.teamId } },
      automatic_tax: { enabled: false },
      tax_id_collection: { enabled: false },
    });
    expect(state.checkouts[0]).not.toHaveProperty("payment_method_types");
    expect(state.calls).toEqual(["checkout.sessions.create", "checkout.sessions.create"]);
  });

  it("refuses disabled catalog and invalid requests before calling Stripe", async () => {
    const { stripe, state } = fakeStripe();
    await expect(createMailboxCheckoutSession(stripe, null, input)).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(
      createMailboxCheckoutSession(stripe, { ...CATALOG, checkoutPriceId: null }, input),
    ).rejects.toMatchObject({ code: "unavailable" });
    for (const invalid of [
      { seats: 0 },
      { seats: 1.5 },
      { seats: 10001 },
      { idempotencyKey: "" },
      { customerId: "cus_" },
      { successUrl: "javascript:alert(1)" },
      { cancelUrl: "https://user:password@app.example.com/mailboxes" },
    ]) {
      await expect(
        createMailboxCheckoutSession(stripe, CATALOG, { ...input, ...invalid }),
      ).rejects.toMatchObject({ code: "invalid" });
    }
    expect(state.calls).toEqual([]);
  });

  it("opens a tiered team-quota price with the free trial and the card collected, from its included mailboxes up", async () => {
    const { stripe, state } = fakeStripe();
    const catalog: MailboxCatalog = {
      ...CATALOG,
      checkoutPriceId: TIERED.priceId,
      prices: [TERMS, TIERED],
    };
    await createMailboxCheckoutSession(stripe, catalog, { ...input, trialDays: 7 });
    expect(state.checkouts[0]).toMatchObject({
      line_items: [{ price: TIERED.priceId, quantity: 3 }],
      payment_method_collection: "always",
      subscription_data: {
        metadata: { mepmail_service: "mailbox" },
        trial_period_days: 7,
        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
      },
    });
    await createMailboxCheckoutSession(stripe, catalog, {
      ...input,
      idempotencyKey: "mailbox-checkout:no-trial",
    });
    expect(state.checkouts[1]).not.toHaveProperty("payment_method_collection");
    expect(state.checkouts[1]?.subscription_data).not.toHaveProperty("trial_period_days");
    for (const invalid of [{ seats: 2 }, { trialDays: 31 }, { trialDays: -1 }]) {
      await expect(
        createMailboxCheckoutSession(stripe, catalog, { ...input, ...invalid }),
      ).rejects.toMatchObject({ code: "invalid" });
    }
  });

  it("reports an unavailable Checkout URL without any fulfillment side effect", async () => {
    const { stripe, state } = fakeStripe();
    stripe.checkout.sessions.create = async () => ({ url: null }) as Stripe.Checkout.Session;
    await expect(createMailboxCheckoutSession(stripe, CATALOG, input)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(state.calls).toEqual([]);
  });
});

describe("Mailbox isolation from Send billing, real handler and database", () => {
  let db: Db;
  let close: () => Promise<void>;
  let stripe: BillingStripe;
  let state: ReturnType<typeof fakeStripe>["state"];
  let teamId: string;
  let sequence = 0;
  let appliedServices: string[];

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    ({ stripe, state } = fakeStripe());
    appliedServices = [];
    teamId = await createTeam(db);
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: OWNER.customerId })
      .where(eq(schema.teams.id, teamId));
  });
  afterEach(() => close());

  const row = async () =>
    (await db.select().from(schema.teams).where(eq(schema.teams.id, teamId)))[0]!;
  async function deliver(sub: Stripe.Subscription) {
    const payload = JSON.stringify({
      id: `evt_mailbox_${++sequence}`,
      object: "event",
      type: "customer.subscription.updated",
      livemode: false,
      data: { object: { id: sub.id, customer: sub.customer } },
    });
    return handleWebhook(
      payload,
      webhooks.generateTestHeaderString({ payload, secret: "whsec_test" }),
      {
        db,
        stripe,
        webhookSecret: "whsec_test",
        livemode: false,
        log: () => {},
        afterApply: (event) => {
          appliedServices.push(event.service);
        },
      },
    );
  }
  async function activateSend() {
    const send = subscription(
      "sub_send",
      OWNER.customerId,
      "active",
      "millionsend_pro_100k_monthly",
      {
        overageKey: "millionsend_pro_100k_overage",
      },
    );
    send.created = PERIOD_START - 200;
    state.subscriptions[send.id] = send;
    expect(await deliver(send)).toBe(200);
    return send;
  }

  it("screens a Mail-only buyer's payments and holds the team's sending when Radar blocked one", async () => {
    state.charges = [
      {
        id: "ch_mail_blocked",
        object: "charge",
        customer: OWNER.customerId,
        created: 900,
        outcome: { type: "blocked", risk_level: "highest" },
      } as unknown as Stripe.Charge,
    ];
    const mail = mailSubscription();
    state.subscriptions[mail.id] = mail;
    expect(await deliver(mail)).toBe(200);
    const held = await row();
    expect(held.sendReviewReason).toBe("payment_risk");
    expect(held.sendReviewNote).toContain("ch_mail_blocked");
    expect(held.plan).toBe("free");
  });

  it("excludes a Mail subscription before querying any Send schema, including billing terms", async () => {
    await expect(
      applySubscription({} as Db, mailSubscription(), () => {}, stripe),
    ).resolves.toBeUndefined();
  });

  it("acknowledges Mail and unrelated product events without changing any Send column", async () => {
    await activateSend();
    const before = await row();
    const mail = mailSubscription();
    const unrelated = subscription("sub_other", OWNER.customerId, "active", "other_product");
    unrelated.created = PERIOD_START - 50;
    for (const sub of [mail, unrelated]) {
      state.subscriptions[sub.id] = sub;
      expect(await deliver(sub)).toBe(200);
      expect(await row()).toEqual(before);
    }
    mail.status = "canceled";
    expect(await deliver(mail)).toBe(200);
    expect(await row()).toEqual(before);
    expect(await db.select().from(schema.stripeEvents)).toHaveLength(4);
    expect(state.itemCreates).toEqual([]);
    expect(state.itemUpdates).toEqual([]);
    expect(appliedServices).toEqual(["send", "mailbox", "ignored", "mailbox"]);
  });

  it("reconciles recognized Send after newer Mail and unrelated subscriptions", async () => {
    await activateSend();
    const before = await row();
    state.subscriptions.sub_mail = mailSubscription();
    state.subscriptions.sub_other = subscription(
      "sub_other",
      OWNER.customerId,
      "active",
      "other_product",
    );
    await reconcileTeamPlan({ db, stripe, log: () => {} }, teamId);
    const after = await row();
    const normalizeVerification = (value: object) => {
      const snapshot = { ...value } as Record<string, unknown>;
      for (const field of ["billingTerms", "sendBillingContract"]) {
        const terms = snapshot[field];
        if (terms && typeof terms === "object") {
          const { verifiedAt: _, ...financialTerms } = terms as Record<string, unknown>;
          snapshot[field] = financialTerms;
        }
      }
      return snapshot;
    };
    expect(normalizeVerification(after)).toEqual(normalizeVerification(before));
    expect(after).toMatchObject({
      plan: before.plan,
      planQuota: before.planQuota,
      planStatus: before.planStatus,
      stripeSubscriptionId: "sub_send",
      currentPeriodStart: before.currentPeriodStart,
      currentPeriodEnd: before.currentPeriodEnd,
    });
    // The qualified Send baseline may precede billingTerms/0043; compare every
    // available field above, and verified terms only when that optional field exists.
    const beforeTerms = (before as Record<string, unknown>).billingTerms;
    if (beforeTerms && typeof beforeTerms === "object") {
      expect((after as Record<string, unknown>).billingTerms).toMatchObject({
        subscriptionId: "sub_send",
        basePriceId: (beforeTerms as Record<string, unknown>).basePriceId,
      });
    }
    expect(state.retrieves).not.toContain("sub_mail");
  });

  it("paginates past other products to recover an older recognized Send subscription", async () => {
    const send = subscription("sub_send", OWNER.customerId, "active");
    state.subscriptions[send.id] = send;
    const mail = mailSubscription();
    const other = subscription("sub_other", OWNER.customerId, "active", "other_product");
    state.subscriptions[mail.id] = mail;
    state.subscriptions[other.id] = other;
    const starts: (string | undefined)[] = [];
    stripe.subscriptions.list = async (params) => {
      starts.push(params.starting_after);
      const selected =
        params.starting_after === mail.id
          ? other
          : params.starting_after === other.id
            ? send
            : mail;
      return {
        data: [selected],
        has_more: selected !== send,
      } as Stripe.ApiList<Stripe.Subscription>;
    };
    await reconcileTeamPlan({ db, stripe, log: () => {} }, teamId);
    expect(starts).toEqual([undefined, "sub_mail", "sub_other"]);
    expect((await row()).stripeSubscriptionId).toBe("sub_send");
  });

  it("still reconciles the already-linked unknown legacy price and its cancellation", async () => {
    const send = await activateSend();
    send.items.data[0]!.price = {
      ...send.items.data[0]!.price,
      id: "price_legacy",
      lookup_key: null,
      metadata: {},
      product: "prod_unknown",
    };
    state.subscriptions.sub_mail = mailSubscription();
    await reconcileTeamPlan({ db, stripe, log: () => {} }, teamId);
    const legacyRow = await row();
    expect(legacyRow).toMatchObject({ stripeSubscriptionId: "sub_send" });
    if ("billingTerms" in legacyRow) expect(legacyRow.billingTerms).toBeNull();
    send.status = "canceled";
    await reconcileTeamPlan({ db, stripe, log: () => {} }, teamId);
    expect(await row()).toMatchObject({
      plan: "free",
      planStatus: "canceled",
      stripeSubscriptionId: "sub_send",
    });
  });

  it("leaves an unlinked Send team alone when the Customer only has Mail/unknown products", async () => {
    const before = await row();
    state.subscriptions.sub_mail = mailSubscription();
    state.subscriptions.sub_other = subscription(
      "sub_other",
      OWNER.customerId,
      "active",
      "other_product",
    );
    await reconcileTeamPlan({ db, stripe, log: () => {} }, teamId);
    expect(await row()).toEqual(before);
  });
});
