import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import type { CanonicalInvoicePayment } from "../src/send-purchase.js";
import { confirmedInitialSendPurchase } from "../src/send-purchase.js";

type PurchaseInput = Parameters<typeof confirmedInitialSendPurchase>[0];

function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Incomplete test fixture");
  return value;
}

function invoiceLine(input: PurchaseInput) {
  const line = required(input.invoice.lines.data[0]);
  return {
    subscription: required(required(line.parent).subscription_item_details),
    pricing: required(required(line.pricing).price_details),
  };
}
const created = 1_791_000_000;
const paidAt = created + 120;
const basePrice = "price_send_pro_100k";
const overagePrice = "price_send_pro_100k_overage";
const attemptId = "8f3059a8-7c30-48ba-bafe-9bd2b233cbb5";
const metadata = { mepmail_send_checkout: attemptId, team_id: "team_send" };

/** Complete relevant provider graph; fixtures are DTOs, not mocks of the classifier. */
function fixture(): PurchaseInput {
  const price = (id: string, metered = false) => ({
    id,
    object: "price",
    active: true,
    billing_scheme: "per_unit",
    created,
    currency: "usd",
    custom_unit_amount: null,
    livemode: false,
    lookup_key: id,
    metadata: { millionsend_rung: "pro_100k" },
    nickname: null,
    product: "prod_send_pro",
    recurring: {
      interval: "month",
      interval_count: 1,
      usage_type: metered ? "metered" : "licensed",
      meter: null,
    },
    tax_behavior: "unspecified",
    tiers_mode: null,
    transform_quantity: null,
    type: "recurring",
    unit_amount: metered ? 10 : 2_000,
    unit_amount_decimal: metered ? "10" : "2000",
  });
  const subscriptionItems = [basePrice, overagePrice].map((id, index) => ({
    id: `si_send_${index}`,
    object: "subscription_item",
    created,
    current_period_start: created,
    current_period_end: created + 30 * 24 * 60 * 60,
    metadata: {},
    price: price(id, index === 1),
    discounts: [],
    tax_rates: [],
    ...(index === 0 ? { quantity: 1 } : {}),
  }));
  const invoice = {
    id: "in_send_initial",
    object: "invoice",
    account_country: "US",
    account_name: "MepMail",
    account_tax_ids: null,
    amount_due: 1_243,
    amount_overpaid: 0,
    amount_paid: 1_243,
    amount_remaining: 0,
    amount_shipping: 0,
    application: null,
    attempt_count: 1,
    attempted: true,
    auto_advance: false,
    automatic_tax: { enabled: false, liability: null, status: null },
    billing_reason: "subscription_create",
    collection_method: "charge_automatically",
    confirmation_secret: null,
    created,
    currency: "usd",
    customer: "cus_send",
    customer_account: null,
    customer_address: null,
    customer_email: "owner@example.invalid",
    customer_name: "Send fixture",
    customer_phone: null,
    customer_shipping: null,
    customer_tax_exempt: "none",
    customer_tax_ids: [],
    default_payment_method: "pm_send",
    default_source: null,
    default_tax_rates: [],
    description: null,
    discounts: [],
    due_date: null,
    effective_at: null,
    ending_balance: 0,
    footer: null,
    from_invoice: null,
    hosted_invoice_url: "https://invoice.stripe.com/i/offline_fixture",
    invoice_pdf: null,
    issuer: { type: "self" },
    latest_revision: null,
    lines: {
      object: "list",
      has_more: false,
      url: "/v1/invoices/in_send_initial/lines",
      data: [
        {
          id: "il_send_initial",
          object: "line_item",
          amount: 2_000,
          currency: "usd",
          description: "Send Pro",
          discount_amounts: [{ amount: 757, discount: "di_send" }],
          discountable: true,
          discounts: [],
          invoice: "in_send_initial",
          livemode: false,
          metadata,
          parent: {
            type: "subscription_item_details",
            subscription_item_details: {
              invoice_item: null,
              proration: false,
              proration_details: { credited_items: null },
              subscription: "sub_send",
              subscription_item: "si_send_0",
            },
          },
          period: { start: created, end: created + 30 * 24 * 60 * 60 },
          pretax_credit_amounts: [],
          pricing: {
            type: "price_details",
            price_details: { price: basePrice, product: "prod_send_pro" },
            unit_amount_decimal: "2000",
          },
          quantity: 1,
          subtotal: 2_000,
          taxes: [],
        },
      ],
    },
    livemode: false,
    metadata,
    next_payment_attempt: null,
    number: "SEND-0001",
    on_behalf_of: null,
    parent: {
      type: "subscription_details",
      subscription_details: { metadata, subscription: "sub_send" },
    },
    payment_settings: {
      default_mandate: null,
      payment_method_options: null,
      payment_method_types: null,
    },
    period_end: created + 30 * 24 * 60 * 60,
    period_start: created,
    post_payment_credit_notes_amount: 0,
    pre_payment_credit_notes_amount: 0,
    receipt_number: null,
    rendering: null,
    shipping_cost: null,
    shipping_details: null,
    starting_balance: 0,
    statement_descriptor: null,
    status: "paid",
    status_transitions: {
      finalized_at: created,
      marked_uncollectible_at: null,
      paid_at: paidAt,
      voided_at: null,
    },
    subtotal: 2_000,
    subtotal_excluding_tax: 2_000,
    test_clock: null,
    total: 1_243,
    total_discount_amounts: [{ amount: 757, discount: "di_send" }],
    total_excluding_tax: 1_243,
    total_pretax_credit_amounts: [],
    total_taxes: [],
    webhooks_delivered_at: paidAt,
  } as unknown as Stripe.Invoice;
  const subscription = {
    id: "sub_send",
    object: "subscription",
    application: null,
    application_fee_percent: null,
    automatic_tax: { enabled: false, liability: null },
    billing_cycle_anchor: created,
    billing_cycle_anchor_config: null,
    billing_mode: { type: "classic", flexible: null },
    billing_thresholds: null,
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: null,
    cancellation_details: { comment: null, feedback: null, reason: null },
    collection_method: "charge_automatically",
    created,
    currency: "usd",
    customer: "cus_send",
    customer_account: null,
    days_until_due: null,
    default_payment_method: "pm_send",
    default_source: null,
    default_tax_rates: [],
    description: null,
    discounts: [],
    ended_at: null,
    invoice_settings: { account_tax_ids: null, issuer: { type: "self" } },
    items: {
      object: "list",
      data: subscriptionItems,
      has_more: false,
      url: "/v1/subscription_items?subscription=sub_send",
    },
    latest_invoice: "in_send_initial",
    livemode: false,
    metadata,
    next_pending_invoice_item_invoice: null,
    on_behalf_of: null,
    pause_collection: null,
    payment_settings: {
      payment_method_options: null,
      payment_method_types: null,
      save_default_payment_method: "off",
    },
    pending_invoice_item_interval: null,
    pending_setup_intent: null,
    pending_update: null,
    schedule: null,
    start_date: created,
    status: "active",
    test_clock: null,
    transfer_data: null,
    trial_end: null,
    trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
    trial_start: null,
  } as unknown as Stripe.Subscription;
  const session = {
    id: "cs_send",
    object: "checkout.session",
    adaptive_pricing: null,
    after_expiration: null,
    allow_promotion_codes: true,
    amount_subtotal: 2_000,
    amount_total: 1_243,
    automatic_tax: { enabled: false, liability: null, status: null },
    billing_address_collection: "auto",
    cancel_url: "https://mepmail.dev/pricing",
    client_reference_id: "team_send",
    client_secret: null,
    collected_information: null,
    consent: null,
    consent_collection: null,
    created,
    currency: "usd",
    currency_conversion: null,
    custom_fields: [],
    custom_text: {
      after_submit: null,
      shipping_address: null,
      submit: null,
      terms_of_service_acceptance: null,
    },
    customer: "cus_send",
    customer_account: null,
    customer_creation: null,
    customer_details: {
      address: null,
      email: "owner@example.invalid",
      name: "Send fixture",
      phone: null,
      tax_exempt: "none",
      tax_ids: [],
    },
    customer_email: null,
    discounts: [],
    expires_at: created + 1_800,
    invoice: "in_send_initial",
    invoice_creation: null,
    line_items: {
      object: "list",
      data: [
        {
          id: "li_send",
          object: "item",
          amount_discount: 757,
          amount_subtotal: 2_000,
          amount_tax: 0,
          amount_total: 1_243,
          currency: "usd",
          description: "Send Pro",
          discounts: [],
          price: price(basePrice),
          quantity: 1,
          taxes: [],
        },
      ],
      has_more: false,
      url: "/v1/checkout/sessions/cs_send/line_items",
    },
    livemode: false,
    locale: null,
    metadata,
    mode: "subscription",
    optional_items: null,
    origin_context: null,
    payment_intent: null,
    payment_link: null,
    payment_method_collection: "always",
    payment_method_configuration_details: null,
    payment_method_options: {},
    payment_method_types: ["card"],
    payment_status: "paid",
    permissions: null,
    phone_number_collection: { enabled: false },
    presentment_details: null,
    recovered_from: null,
    redirect_on_completion: "always",
    return_url: null,
    saved_payment_method_options: null,
    setup_intent: null,
    shipping_address_collection: null,
    shipping_cost: null,
    shipping_options: [],
    status: "complete",
    submit_type: "auto",
    subscription: "sub_send",
    success_url: "https://mepmail.dev/app?checkout=success",
    tax_id_collection: { enabled: false, required: "never" },
    total_details: { amount_discount: 757, amount_shipping: 0, amount_tax: 0 },
    ui_mode: "hosted",
    url: null,
    wallet_options: null,
  } as unknown as Stripe.Checkout.Session;
  return {
    type: "invoice.payment_succeeded",
    invoice,
    subscription,
    session,
    mailbox: false,
    attempt: {
      id: attemptId,
      rung: "pro_100k",
      livemode: false,
      stripeCustomerId: "cus_send",
      stripeSessionId: "cs_send",
      parameters: {
        mode: "subscription",
        customer: "cus_send",
        client_reference_id: "team_send",
        metadata,
        subscription_data: { metadata },
        line_items: [{ price: basePrice, quantity: 1 }, { price: overagePrice }],
      },
    },
  };
}

function canonical(input: PurchaseInput): CanonicalInvoicePayment {
  return {
    invoiceId: input.invoice.id,
    customerId: input.attempt.stripeCustomerId,
    subscriptionId: input.subscription.id,
    livemode: input.attempt.livemode,
    status: "paid",
    paymentType: "payment_intent",
    paymentStatus: "succeeded",
    amountPaidMinor: 1_243,
    currency: "usd",
  };
}

describe("initial Send acquisition classifier", () => {
  it("classifies an offline signature-verified payment_succeeded and preserves discounted provider cents/paid time", () => {
    const input = fixture();
    const stripe = new Stripe("sk_test_offline_fixture");
    const body = JSON.stringify({
      id: "evt_send_paid",
      object: "event",
      api_version: null,
      created: paidAt,
      data: { object: input.invoice },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: input.type,
    });
    const secret = "whsec_offline_fixture";
    const header = stripe.webhooks.generateTestHeaderString({ payload: body, secret });
    const verified = stripe.webhooks.constructEvent(body, header, secret);
    expect(
      confirmedInitialSendPurchase({
        ...input,
        type: verified.type,
        invoice: verified.data.object as Stripe.Invoice,
      }),
    ).toEqual({
      stripeInvoiceId: "in_send_initial",
      stripeSubscriptionId: "sub_send",
      stripeSessionId: "cs_send",
      amountPaidMinor: 1_243,
      currency: "usd",
      paidAt: new Date(paidAt * 1_000),
    });
  });

  it("does not trust invoice.paid alone; requires exact canonical succeeded InvoicePayment facts", () => {
    const input = fixture();
    input.type = "invoice.paid";
    expect(confirmedInitialSendPurchase(input)).toBeNull();
    expect(
      confirmedInitialSendPurchase({ ...input, canonicalPayment: canonical(input) })
        ?.amountPaidMinor,
    ).toBe(1_243);
    for (const patch of [
      { invoiceId: "in_other" },
      { customerId: "cus_other" },
      { subscriptionId: "sub_other" },
      { livemode: true },
      { amountPaidMinor: 2_000 },
      { currency: "brl" },
      { paymentStatus: "requires_action" },
      { paymentType: "payment_record" },
    ]) {
      const payment = { ...canonical(input), ...patch } as CanonicalInvoicePayment;
      expect(confirmedInitialSendPurchase({ ...input, canonicalPayment: payment })).toBeNull();
    }
  });

  it("rejects renewals, updates and manual invoices regardless of paid amount", () => {
    for (const reason of ["subscription_cycle", "subscription_update", "manual"] as const) {
      const input = fixture();
      input.invoice.billing_reason = reason;
      expect(confirmedInitialSendPurchase(input)).toBeNull();
    }
  });

  it("rejects prorated, unresolved, truncated, or missing base invoice lines", () => {
    const prorated = fixture();
    invoiceLine(prorated).subscription.proration = true;
    const unknown = fixture();
    invoiceLine(unknown).pricing.price = "price_other";
    const truncated = fixture();
    truncated.invoice.lines.has_more = true;
    const empty = fixture();
    empty.invoice.lines.data = [];
    const overageOnly = fixture();
    invoiceLine(overageOnly).pricing.price = overagePrice;
    for (const input of [prorated, unknown, truncated, empty, overageOnly])
      expect(confirmedInitialSendPurchase(input)).toBeNull();
  });

  it("rejects Free, Mail and trial acquisitions", () => {
    const free = fixture();
    free.attempt.rung = "free_10k";
    const mail = fixture();
    mail.mailbox = true;
    const trial = fixture();
    trial.subscription.trial_start = created;
    trial.subscription.trial_end = created + 1_000;
    for (const input of [free, mail, trial]) expect(confirmedInitialSendPurchase(input)).toBeNull();
  });

  it("rejects zero, failed, unpaid and invalid currency payments", () => {
    const zero = fixture();
    zero.invoice.amount_paid = 0;
    const negative = fixture();
    negative.invoice.amount_paid = -1;
    const failed = fixture();
    failed.type = "invoice.payment_failed";
    const open = fixture();
    open.invoice.status = "open";
    const unpaid = fixture();
    unpaid.session.payment_status = "unpaid";
    const foreign = fixture();
    foreign.invoice.currency = "brl";
    for (const input of [zero, negative, failed, open, unpaid, foreign])
      expect(confirmedInitialSendPurchase(input)).toBeNull();
  });

  it("requires the same Customer and live/test mode across Invoice, Subscription and Session", () => {
    for (const object of ["invoice", "subscription", "session"] as const) {
      const wrongCustomer = fixture();
      wrongCustomer[object].customer = "cus_other";
      expect(confirmedInitialSendPurchase(wrongCustomer)).toBeNull();
      const wrongMode = fixture();
      wrongMode[object].livemode = true;
      expect(confirmedInitialSendPurchase(wrongMode)).toBeNull();
    }
  });

  it("requires original Session identity, attempt metadata and subscription graph", () => {
    const forged = fixture();
    forged.session.id = "cs_forged";
    const changedAttempt = fixture();
    changedAttempt.session.metadata = { mepmail_send_checkout: "other_attempt" };
    const changedSubscriptionMetadata = fixture();
    changedSubscriptionMetadata.subscription.metadata = { mepmail_send_checkout: "other_attempt" };
    const wrongSessionSub = fixture();
    wrongSessionSub.session.subscription = "sub_other";
    const wrongInvoiceSub = fixture();
    required(required(wrongInvoiceSub.invoice.parent).subscription_details).subscription =
      "sub_other";
    const incomplete = fixture();
    incomplete.session.status = "open";
    for (const input of [
      forged,
      changedAttempt,
      changedSubscriptionMetadata,
      wrongSessionSub,
      wrongInvoiceSub,
      incomplete,
    ]) {
      expect(confirmedInitialSendPurchase(input)).toBeNull();
    }
  });

  it("rejects a subscription price graph that conflicts with frozen checkout intent", () => {
    const input = fixture();
    required(input.subscription.items.data[0]).price.id = "price_foreign_product";
    expect(confirmedInitialSendPurchase(input)).toBeNull();
  });

  it("rejects conflicting expanded Session prices and client reference", () => {
    const priceConflict = fixture();
    required(required(required(priceConflict.session.line_items).data[0]).price).id =
      "price_foreign_product";
    const clientConflict = fixture();
    clientConflict.session.client_reference_id = "team_other";
    expect(confirmedInitialSendPurchase(priceConflict)).toBeNull();
    expect(confirmedInitialSendPurchase(clientConflict)).toBeNull();
  });

  it("requires a positive valid provider paid timestamp", () => {
    const input = fixture();
    input.invoice.status_transitions.paid_at = -1;
    expect(confirmedInitialSendPurchase(input)).toBeNull();
  });
});
