import Stripe from "stripe";
import { idOf } from "./subscription.js";

/**
 * Pix, Brazil's instant payment. A Stripe account in Brazil takes Pix only as a one-time
 * payment (no Pix Automático), so a plan paid by Pix is a `send_invoice` subscription:
 * each of its invoices is paid by its own Pix Checkout and recorded as paid out of band.
 * Card subscriptions are unchanged. Boleto is never offered: invoices accept card only.
 */
export const PIX_PURCHASE_METADATA_KEY = "mepmail_pix";
export const PIX_COLLECTION_METADATA_KEY = "mepmail_collection";
export const PIX_COLLECTION = "pix";
/** On a subscription: the Pix Checkout that started it. On an invoice: the one that paid it. */
export const PIX_SESSION_METADATA_KEY = "mepmail_pix_session";
const PIX_PRICE_METADATA_KEY = "mepmail_pix_price";
const PIX_QUANTITY_METADATA_KEY = "mepmail_pix_quantity";
const PIX_INVOICE_METADATA_KEY = "mepmail_pix_invoice";
const PIX_OVERAGE_METADATA_KEY = "mepmail_pix_overage";
const PIX_COUPON_METADATA_KEY = "mepmail_pix_coupon";
const PIX_INTERVAL_METADATA_KEY = "mepmail_pix_interval";
/** send_start: the Send checkout attempt (advertising context) this payment belongs to. */
const PIX_ATTEMPT_METADATA_KEY = "mepmail_pix_attempt";
/** Days a Pix-collected renewal invoice stays payable before the plan falls past due. */
export const PIX_DAYS_UNTIL_DUE = 5;
/** Stripe's Pix limits: R$ 0,50 to R$ 3.000 per payment. */
export const PIX_MIN_AMOUNT = 50;
export const PIX_MAX_AMOUNT = 300_000;
/** The QR code and the Checkout page each stay valid for an hour. */
const PIX_QR_SECONDS = 3600;
const PIX_CHECKOUT_SECONDS = 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PixPurchaseKind = "mailbox_start" | "send_start" | "invoice";

/** The Stripe calls Pix makes. The real client satisfies it structurally; tests pass a fake. */
export interface PixStripe {
  prices: { retrieve(id: string, params?: Stripe.PriceRetrieveParams): Promise<Stripe.Price> };
  checkout: {
    sessions: {
      create(
        params: Stripe.Checkout.SessionCreateParams,
        options?: Stripe.RequestOptions,
      ): Promise<Stripe.Checkout.Session>;
      retrieve(
        id: string,
        params?: Stripe.Checkout.SessionRetrieveParams,
      ): Promise<Stripe.Checkout.Session>;
    };
  };
  subscriptions: {
    create(
      params: Stripe.SubscriptionCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.Subscription>;
    list(params: Stripe.SubscriptionListParams): Promise<Stripe.ApiList<Stripe.Subscription>>;
    cancel(id: string, params?: Stripe.SubscriptionCancelParams): Promise<Stripe.Subscription>;
  };
  invoices: {
    retrieve(id: string, params?: Stripe.InvoiceRetrieveParams): Promise<Stripe.Invoice>;
    list(params: Stripe.InvoiceListParams): Promise<Stripe.ApiList<Stripe.Invoice>>;
    finalizeInvoice(
      id: string,
      params?: Stripe.InvoiceFinalizeInvoiceParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.Invoice>;
    update(id: string, params: Stripe.InvoiceUpdateParams): Promise<Stripe.Invoice>;
    pay(
      id: string,
      params?: Stripe.InvoicePayParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.Invoice>;
    voidInvoice(id: string, params?: Stripe.InvoiceVoidInvoiceParams): Promise<Stripe.Invoice>;
  };
  refunds: {
    create(
      params: Stripe.RefundCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.Refund>;
  };
  paymentIntents: {
    retrieve(
      id: string,
      params?: Stripe.PaymentIntentRetrieveParams,
    ): Promise<Stripe.PaymentIntent>;
  };
}

/** A client for the Pix calls; the same SDK and key as createStripe. */
export function createPixStripe(secretKey: string): PixStripe {
  return new Stripe(secretKey);
}

export class PixBillingError extends Error {
  constructor(public readonly code: "invalid" | "unavailable" | "not_found" | "paid") {
    super(code);
  }
}

/** A subscription whose invoices are paid by Pix, one at a time. */
export function isPixSubscription(
  sub: Pick<Stripe.Subscription, "collection_method" | "metadata">,
) {
  return (
    sub.collection_method === "send_invoice" &&
    sub.metadata?.[PIX_COLLECTION_METADATA_KEY] === PIX_COLLECTION
  );
}

/** An invoice of a Pix-collected subscription, read off the metadata it was finalized with. */
export function isPixInvoice(invoice: Stripe.Invoice) {
  return (
    invoice.collection_method === "send_invoice" &&
    invoice.parent?.subscription_details?.metadata?.[PIX_COLLECTION_METADATA_KEY] === PIX_COLLECTION
  );
}

/**
 * What one Pix payment of `quantity` units of a price costs in reais: the amount Stripe
 * will bill for it, read from the price's BRL currency option. Null when the price has
 * none, or the amount is outside Pix's limits.
 */
export async function pixAmountForPrice(
  stripe: PixStripe,
  priceId: string,
  quantity: number,
): Promise<{ amount: number; product: string } | null> {
  const price = await stripe.prices.retrieve(priceId, { expand: ["currency_options"] });
  const brl = price.currency === "brl" ? price : price.currency_options?.brl;
  const unit = brl?.unit_amount;
  const product = idOf(price.product);
  if (
    !price.active ||
    price.billing_scheme !== "per_unit" ||
    !product ||
    !Number.isSafeInteger(unit) ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1
  )
    return null;
  const amount = (unit as number) * quantity;
  return amount >= PIX_MIN_AMOUNT && amount <= PIX_MAX_AMOUNT ? { amount, product } : null;
}

export interface PixCheckoutInput {
  kind: PixPurchaseKind;
  teamId: string;
  customerId: string;
  amount: number;
  /** The product the payment is for; the Checkout line shows its name. */
  product: string;
  successUrl: string;
  cancelUrl: string;
  /** Stripe idempotency key: the same intent never opens two Pix payments. */
  idempotencyKey: string;
  /** mailbox_start / send_start: the plan price and quantity the subscription is created with. */
  priceId?: string;
  quantity?: number;
  /** send_start: the metered overage price, the first-invoice coupon and the interval. */
  overagePriceId?: string;
  coupon?: string;
  interval?: "month" | "year";
  /** send_start: the Send checkout attempt holding the advertising context. */
  attemptId?: string;
  /** invoice: the open invoice this payment settles. */
  invoiceId?: string;
}

/** A one-time Pix Checkout in reais; only the webhook ever acts on its payment. */
export async function createPixCheckoutSession(
  stripe: PixStripe,
  input: PixCheckoutInput,
): Promise<string> {
  if (
    !UUID.test(input.teamId) ||
    !/^cus_[A-Za-z0-9_]+$/.test(input.customerId) ||
    !Number.isSafeInteger(input.amount) ||
    input.amount < PIX_MIN_AMOUNT ||
    input.amount > PIX_MAX_AMOUNT ||
    ((input.kind === "mailbox_start" || input.kind === "send_start") &&
      (!input.priceId ||
        !Number.isSafeInteger(input.quantity) ||
        (input.quantity as number) < 1 ||
        input.invoiceId)) ||
    (input.kind === "invoice" && (!input.invoiceId || input.priceId)) ||
    (input.attemptId !== undefined && (input.kind !== "send_start" || !UUID.test(input.attemptId)))
  )
    throw new PixBillingError("invalid");
  const metadata: Record<string, string> = {
    [PIX_PURCHASE_METADATA_KEY]: input.kind,
    team_id: input.teamId,
    ...(input.priceId
      ? {
          [PIX_PRICE_METADATA_KEY]: input.priceId,
          [PIX_QUANTITY_METADATA_KEY]: String(input.quantity),
        }
      : {}),
    ...(input.invoiceId ? { [PIX_INVOICE_METADATA_KEY]: input.invoiceId } : {}),
    ...(input.overagePriceId ? { [PIX_OVERAGE_METADATA_KEY]: input.overagePriceId } : {}),
    ...(input.coupon ? { [PIX_COUPON_METADATA_KEY]: input.coupon } : {}),
    ...(input.interval ? { [PIX_INTERVAL_METADATA_KEY]: input.interval } : {}),
    ...(input.attemptId ? { [PIX_ATTEMPT_METADATA_KEY]: input.attemptId } : {}),
  };
  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      customer: input.customerId,
      client_reference_id: input.teamId,
      payment_method_types: ["pix"],
      payment_method_options: { pix: { expires_after_seconds: PIX_QR_SECONDS } },
      line_items: [
        {
          quantity: 1,
          price_data: { currency: "brl", unit_amount: input.amount, product: input.product },
        },
      ],
      metadata,
      payment_intent_data: { metadata },
      locale: "pt-BR",
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      expires_at: Math.floor(Date.now() / 1000) + PIX_CHECKOUT_SECONDS,
    },
    { idempotencyKey: input.idempotencyKey },
  );
  if (!session.url) throw new PixBillingError("unavailable");
  return session.url;
}

/** A Pix Checkout payment, as verified from the session Stripe returns (never the event). */
export interface PixPayment {
  sessionId: string;
  paymentIntentId: string;
  kind: PixPurchaseKind;
  teamId: string;
  customerId: string;
  amount: number;
  priceId: string | null;
  quantity: number | null;
  invoiceId: string | null;
  overagePriceId: string | null;
  coupon: string | null;
  interval: "month" | "year" | null;
  /** send_start: the Send checkout attempt it was opened under (null before 0.152). */
  attemptId: string | null;
}

/** The Pix session an event is about, before verification; null for every other event. */
export function pixSessionOf(event: Stripe.Event): string | null {
  if (
    event.type !== "checkout.session.completed" &&
    event.type !== "checkout.session.async_payment_succeeded"
  )
    return null;
  const session = event.data.object;
  return session.mode === "payment" && session.metadata?.[PIX_PURCHASE_METADATA_KEY]
    ? session.id
    : null;
}

/** "pending": not paid yet (Stripe sends async_payment_succeeded when it is). */
export async function readPixPayment(
  stripe: PixStripe,
  sessionId: string,
  livemode: boolean,
): Promise<PixPayment | "pending" | "invalid"> {
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const kind = session.metadata?.[PIX_PURCHASE_METADATA_KEY];
  const customerId = idOf(session.customer);
  const paymentIntentId = idOf(session.payment_intent);
  const teamId = session.metadata?.team_id ?? "";
  const quantity = Number(session.metadata?.[PIX_QUANTITY_METADATA_KEY]);
  if (
    session.id !== sessionId ||
    session.mode !== "payment" ||
    session.livemode !== livemode ||
    session.currency !== "brl" ||
    (kind !== "mailbox_start" && kind !== "send_start" && kind !== "invoice") ||
    !customerId ||
    !UUID.test(teamId) ||
    !Number.isSafeInteger(session.amount_total) ||
    (session.amount_total ?? 0) < PIX_MIN_AMOUNT
  )
    return "invalid";
  if (session.status !== "complete" || session.payment_status !== "paid" || !paymentIntentId)
    return "pending";
  return {
    sessionId,
    paymentIntentId,
    kind,
    teamId,
    customerId,
    amount: session.amount_total as number,
    priceId: session.metadata?.[PIX_PRICE_METADATA_KEY] ?? null,
    quantity: Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null,
    invoiceId: session.metadata?.[PIX_INVOICE_METADATA_KEY] ?? null,
    overagePriceId: session.metadata?.[PIX_OVERAGE_METADATA_KEY] ?? null,
    coupon: session.metadata?.[PIX_COUPON_METADATA_KEY] ?? null,
    interval:
      session.metadata?.[PIX_INTERVAL_METADATA_KEY] === "year"
        ? "year"
        : session.metadata?.[PIX_INTERVAL_METADATA_KEY] === "month"
          ? "month"
          : null,
    attemptId:
      kind === "send_start" && UUID.test(session.metadata?.[PIX_ATTEMPT_METADATA_KEY] ?? "")
        ? (session.metadata?.[PIX_ATTEMPT_METADATA_KEY] as string)
        : null,
  };
}

/** Gives a Pix payment back in full: once per payment, whatever retries come. */
export async function refundPixPayment(stripe: PixStripe, payment: PixPayment, reason: string) {
  await stripe.refunds.create(
    {
      payment_intent: payment.paymentIntentId,
      reason: "requested_by_customer",
      metadata: { [PIX_SESSION_METADATA_KEY]: payment.sessionId, mepmail_pix_refund: reason },
    },
    { idempotencyKey: `pix-refund:${payment.paymentIntentId}` },
  );
}

/**
 * Records `payment` as what paid `invoiceId`, when it is the invoice's whole open amount.
 * "paid" also when this payment already paid it (a retried event). "mismatch": the invoice
 * is not this payment's to settle (paid otherwise, voided, another amount); the caller
 * refunds it.
 */
export async function settlePixInvoice(
  stripe: PixStripe,
  invoiceId: string,
  payment: PixPayment,
): Promise<"paid" | "mismatch"> {
  let invoice = await stripe.invoices.retrieve(invoiceId);
  if (idOf(invoice.customer) !== payment.customerId || invoice.currency !== "brl")
    return "mismatch";
  if (invoice.status === "paid")
    return invoice.metadata?.[PIX_SESSION_METADATA_KEY] === payment.sessionId ? "paid" : "mismatch";
  if (invoice.status === "draft")
    invoice = await stripe.invoices.finalizeInvoice(
      invoice.id,
      { auto_advance: false },
      { idempotencyKey: `pix-finalize:${invoice.id}` },
    );
  if (invoice.status !== "open" || invoice.amount_remaining !== payment.amount) return "mismatch";
  await stripe.invoices.update(invoice.id, {
    metadata: {
      [PIX_SESSION_METADATA_KEY]: payment.sessionId,
      mepmail_pix_payment: payment.paymentIntentId,
    },
  });
  try {
    await stripe.invoices.pay(
      invoice.id,
      { paid_out_of_band: true },
      { idempotencyKey: `pix-pay:${payment.sessionId}` },
    );
  } catch (error) {
    // Paid by card on the hosted invoice page in the meantime: not this payment's anymore.
    const now = await stripe.invoices.retrieve(invoice.id);
    if (now.status === "paid" && now.metadata?.[PIX_SESSION_METADATA_KEY] !== payment.sessionId)
      return "mismatch";
    if (now.status === "paid") return "paid";
    throw error;
  }
  return "paid";
}

/** The team's open invoices that Pix can pay, oldest first. */
export async function openPixInvoices(stripe: PixStripe, customerId: string) {
  const page = await stripe.invoices.list({ customer: customerId, status: "open", limit: 20 });
  return page.data
    .filter(
      (invoice) =>
        isPixInvoice(invoice) &&
        invoice.currency === "brl" &&
        invoice.amount_remaining >= PIX_MIN_AMOUNT &&
        invoice.amount_remaining <= PIX_MAX_AMOUNT,
    )
    .sort((a, b) => a.created - b.created)
    .map((invoice) => ({
      id: invoice.id,
      amount: invoice.amount_remaining,
      currency: invoice.currency,
      dueDate: invoice.due_date ? new Date(invoice.due_date * 1000) : null,
      service: invoice.parent?.subscription_details?.metadata?.mepmail_service ?? null,
      subscriptionId: idOf(invoice.parent?.subscription_details?.subscription),
    }));
}

/** Opens a Pix Checkout for one of the customer's open Pix invoices. */
export async function beginPixInvoicePayment(
  stripe: PixStripe,
  input: {
    teamId: string;
    customerId: string;
    invoiceId: string;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<string> {
  if (!/^in_[A-Za-z0-9_]+$/.test(input.invoiceId)) throw new PixBillingError("invalid");
  const invoice = await stripe.invoices.retrieve(input.invoiceId);
  if (idOf(invoice.customer) !== input.customerId || !isPixInvoice(invoice))
    throw new PixBillingError("not_found");
  if (invoice.status === "paid") throw new PixBillingError("paid");
  const line = invoice.lines?.data?.[0];
  const product = line?.pricing?.price_details?.product ?? null;
  if (
    invoice.status !== "open" ||
    invoice.currency !== "brl" ||
    invoice.amount_remaining < PIX_MIN_AMOUNT ||
    invoice.amount_remaining > PIX_MAX_AMOUNT ||
    !product
  )
    throw new PixBillingError("unavailable");
  return createPixCheckoutSession(stripe, {
    kind: "invoice",
    teamId: input.teamId,
    customerId: input.customerId,
    amount: invoice.amount_remaining,
    product,
    invoiceId: invoice.id,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    // One open Pix per invoice and amount for a while; a later click opens a fresh one.
    idempotencyKey: `pix-invoice:${invoice.id}:${invoice.amount_remaining}:${Math.floor(Date.now() / 1_800_000)}`,
  });
}
