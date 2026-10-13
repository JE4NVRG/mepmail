import type Stripe from "stripe";
import { isPixSubscription, PIX_SESSION_METADATA_KEY, type PixPayment } from "./pix.js";

export interface SendPurchaseAttempt {
  id: string;
  rung: string;
  livemode: boolean;
  stripeCustomerId: string;
  stripeSessionId: string | null;
  parameters: Record<string, unknown>;
}
/** This must come from an authenticated canonical InvoicePayment readback, never invoice.paid alone. */
export interface CanonicalInvoicePayment {
  invoiceId: string;
  customerId: string;
  subscriptionId: string;
  livemode: boolean;
  status: "paid";
  paymentType: "payment_intent";
  paymentStatus: "succeeded";
  amountPaidMinor: number;
  currency: string;
}
export interface SendPurchaseFacts {
  stripeInvoiceId: string;
  stripeSubscriptionId: string;
  stripeSessionId: string;
  amountPaidMinor: number;
  /** Brazil pays the same prices in reais (their BRL currency option). */
  currency: "usd" | "brl";
  paidAt: Date;
}
export type SendInvoiceFacts = Omit<SendPurchaseFacts, "stripeSessionId">;
function id(value: unknown): string | null {
  return typeof value === "string"
    ? value
    : value && typeof value === "object" && "id" in value && typeof value.id === "string"
      ? value.id
      : null;
}

/** Invoice facts and the original financial intent classify acquisition, not the team's latest plan. */
export function initialSendInvoiceFacts(input: {
  type: string;
  invoice: Stripe.Invoice;
  subscription: Stripe.Subscription;
  attempt: SendPurchaseAttempt;
  mailbox: boolean;
  canonicalPayment?: CanonicalInvoicePayment | null;
  /** Google measures every paid Send rung; Meta keeps its two Pro rungs. */
  anyRung?: boolean;
}): SendInvoiceFacts | null {
  const { invoice: v, subscription: s, attempt: a } = input;
  if (
    (!input.anyRung && !["pro_100k", "pro_200k"].includes(a.rung)) ||
    input.mailbox ||
    s.trial_start != null ||
    s.trial_end != null
  )
    return null;
  if (!v.lines || !Array.isArray(v.lines.data) || !s.items || !Array.isArray(s.items.data))
    return null;
  if (
    v.status !== "paid" ||
    v.billing_reason !== "subscription_create" ||
    (v.currency !== "usd" && v.currency !== "brl") ||
    !Number.isSafeInteger(v.amount_paid) ||
    v.amount_paid <= 0 ||
    v.amount_paid > 2_147_483_647 ||
    !Number.isSafeInteger(v.status_transitions?.paid_at) ||
    !v.status_transitions.paid_at ||
    v.status_transitions.paid_at <= 0 ||
    v.status_transitions.paid_at > 8_640_000_000_000 ||
    v.lines.has_more
  )
    return null;
  if (
    v.livemode !== a.livemode ||
    s.livemode !== a.livemode ||
    id(v.customer) !== a.stripeCustomerId ||
    id(s.customer) !== a.stripeCustomerId ||
    id(v.parent?.subscription_details?.subscription) !== s.id ||
    s.metadata?.mepmail_send_checkout !== a.id
  )
    return null;
  const items = a.parameters.line_items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const expected = items.map((item: unknown) =>
    item && typeof item === "object" && "price" in item ? item.price : null,
  );
  if (expected.some((price) => typeof price !== "string")) return null;
  const subscriptionPrices = s.items.data.map((item) => item.price.id);
  if (
    s.items.has_more ||
    !subscriptionPrices.includes(String(expected[0])) ||
    subscriptionPrices.some((price) => !expected.includes(price))
  )
    return null;
  let baseFound = false;
  for (const line of v.lines.data) {
    const price = id(line.pricing?.price_details?.price);
    if (
      !price ||
      !expected.includes(price) ||
      line.parent?.subscription_item_details?.proration !== false
    )
      return null;
    if (price === expected[0]) baseFound = true;
  }
  if (!baseFound) return null;
  if (input.type !== "invoice.payment_succeeded") {
    const p = input.canonicalPayment;
    if (
      input.type !== "invoice.paid" ||
      !p ||
      p.invoiceId !== v.id ||
      p.customerId !== a.stripeCustomerId ||
      p.subscriptionId !== s.id ||
      p.livemode !== a.livemode ||
      p.status !== "paid" ||
      p.paymentType !== "payment_intent" ||
      p.paymentStatus !== "succeeded" ||
      p.currency !== v.currency ||
      p.amountPaidMinor !== v.amount_paid
    )
      return null;
  }
  return {
    stripeInvoiceId: v.id,
    stripeSubscriptionId: s.id,
    amountPaidMinor: v.amount_paid,
    currency: v.currency as "usd" | "brl",
    paidAt: new Date(v.status_transitions.paid_at * 1000),
  };
}

/** No external Purchase until the expanded canonical Session closes the graph. */
export function confirmedInitialSendPurchase(input: {
  type: string;
  invoice: Stripe.Invoice;
  subscription: Stripe.Subscription;
  session: Stripe.Checkout.Session;
  attempt: SendPurchaseAttempt;
  mailbox: boolean;
  canonicalPayment?: CanonicalInvoicePayment | null;
}): SendPurchaseFacts | null {
  const facts = initialSendInvoiceFacts(input);
  if (!facts) return null;
  const { session: c, subscription: s, attempt: a } = input;
  const reference = a.parameters.client_reference_id;
  if (
    c.livemode !== a.livemode ||
    id(c.customer) !== a.stripeCustomerId ||
    id(c.subscription) !== s.id ||
    typeof reference !== "string" ||
    !reference ||
    c.client_reference_id !== reference ||
    (a.stripeSessionId !== null && c.id !== a.stripeSessionId) ||
    c.mode !== "subscription" ||
    c.status !== "complete" ||
    c.payment_status !== "paid" ||
    c.metadata?.mepmail_send_checkout !== a.id
  )
    return null;
  const items = a.parameters.line_items as Array<{ price: string }>;
  const expected = items.map((item) => item.price);
  const prices = c.line_items?.data.map((item) => id(item.price));
  if (
    !prices ||
    c.line_items?.has_more ||
    !prices.includes(expected[0]!) ||
    prices.some((price) => !price || !expected.includes(price))
  )
    return null;
  return { ...facts, stripeSessionId: c.id };
}

/**
 * The first Send purchase paid by Pix (send_start), from canonical Stripe readbacks only:
 * the paid Checkout (readPixPayment), its PaymentIntent, and the subscription and first
 * invoice this payment settled out of band. Never the QR, a pending Pix, a renewal
 * (kind "invoice"), or a Correio plan. The value is what the invoice says was paid: the
 * intro month is R$ 99, not the R$ 149 renewal.
 */
export function initialSendPixFacts(input: {
  payment: PixPayment;
  paymentIntent: Stripe.PaymentIntent;
  invoice: Stripe.Invoice;
  subscription: Stripe.Subscription;
  attempt: SendPurchaseAttempt & { teamId: string };
  livemode: boolean;
  /** Google measures every paid Send rung; Meta keeps its two Pro rungs. */
  anyRung?: boolean;
}): SendPurchaseFacts | null {
  const { payment: p, paymentIntent: pi, invoice: v, subscription: s, attempt: a } = input;
  if (
    p.kind !== "send_start" ||
    p.attemptId !== a.id ||
    p.teamId !== a.teamId ||
    p.customerId !== a.stripeCustomerId ||
    a.livemode !== input.livemode ||
    a.parameters.method !== "pix" ||
    (a.stripeSessionId !== null && a.stripeSessionId !== p.sessionId)
  )
    return null;
  // The PaymentIntent is the money that moved: succeeded, in reais, this customer, this amount.
  if (
    pi.id !== p.paymentIntentId ||
    pi.livemode !== input.livemode ||
    pi.status !== "succeeded" ||
    pi.currency !== "brl" ||
    pi.amount !== p.amount ||
    (pi.amount_received ?? pi.amount) !== p.amount ||
    id(pi.customer) !== a.stripeCustomerId
  )
    return null;
  if (
    !isPixSubscription(s) ||
    s.metadata?.[PIX_SESSION_METADATA_KEY] !== p.sessionId ||
    v.metadata?.[PIX_SESSION_METADATA_KEY] !== p.sessionId ||
    v.metadata?.mepmail_pix_payment !== p.paymentIntentId ||
    v.collection_method !== "send_invoice" ||
    v.currency !== "brl" ||
    v.amount_paid !== p.amount
  )
    return null;
  const facts = initialSendInvoiceFacts({
    type: "invoice.payment_succeeded",
    invoice: v,
    subscription: s,
    attempt: a,
    mailbox: false,
    anyRung: input.anyRung ?? false,
  });
  return facts ? { ...facts, stripeSessionId: p.sessionId } : null;
}
