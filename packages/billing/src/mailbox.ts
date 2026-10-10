import type Stripe from "stripe";
import type { BillingStripe } from "./stripe.js";

export const MAILBOX_SERVICE_METADATA_KEY = "mepmail_service";
export const MAILBOX_SERVICE = "mailbox";
export const MAILBOX_CHECKOUT_METADATA_KEY = "mepmail_checkout_key";
export const MAILBOX_CUSTOMER_METADATA_KEY = "mepmail_customer_key";

/** Server-approved terms. Retain archived entries while subscriptions reference them. */
export interface MailboxPriceTerms {
  priceId: string;
  currency: string;
  unitAmount: number;
  interval: "month" | "year";
  storageBytesPerMailbox: number;
  includedOutboundPerMailbox: number;
}

export interface MailboxCatalog {
  livemode: boolean;
  /** Null disables the legacy/default purchase; explicit offers may remain selectable. */
  checkoutPriceId: string | null;
  /** Explicit purchasable offers. When absent, only the legacy default is purchasable. */
  checkoutPriceIds?: readonly string[] | undefined;
  /**
   * Correio sold on its own: these prices need no paid Envio contract and no
   * Stripe Customer beforehand (the Mail Customer flow creates one). Every
   * other price keeps the Envio requirement.
   */
  standalonePriceIds?: readonly string[] | undefined;
  prices: readonly MailboxPriceTerms[];
}

/** Whether `priceId` is sold without an Envio plan. */
export function isStandaloneMailboxPrice(
  catalog: Pick<MailboxCatalog, "standalonePriceIds"> | null | undefined,
  priceId: string | null | undefined,
): boolean {
  return !!priceId && !!catalog?.standalonePriceIds?.includes(priceId);
}

export class MailboxBillingError extends Error {
  constructor(public readonly code: "unavailable" | "invalid") {
    super(code);
  }
}

/** Classification only: a tag excludes Mail from Send; it never grants Mail access. */
export function isMailboxSubscription(sub: Stripe.Subscription): boolean {
  return (
    sub.metadata?.[MAILBOX_SERVICE_METADATA_KEY] === MAILBOX_SERVICE ||
    sub.items.data.some((item) => {
      const product = item.price.product;
      return (
        item.price.metadata?.[MAILBOX_SERVICE_METADATA_KEY] === MAILBOX_SERVICE ||
        (typeof product === "object" &&
          product !== null &&
          "metadata" in product &&
          product.metadata[MAILBOX_SERVICE_METADATA_KEY] === MAILBOX_SERVICE)
      );
    })
  );
}

function validTerms(terms: MailboxPriceTerms): boolean {
  return (
    /^price_[A-Za-z0-9_]+$/.test(terms.priceId) &&
    /^[a-z]{3}$/.test(terms.currency) &&
    Number.isSafeInteger(terms.unitAmount) &&
    terms.unitAmount > 0 &&
    terms.unitAmount <= 2147483647 &&
    (terms.interval === "month" || terms.interval === "year") &&
    Number.isSafeInteger(terms.storageBytesPerMailbox) &&
    terms.storageBytesPerMailbox >= 1 &&
    terms.storageBytesPerMailbox <= 10995116277760 &&
    Number.isSafeInteger(terms.includedOutboundPerMailbox) &&
    terms.includedOutboundPerMailbox >= 0 &&
    terms.includedOutboundPerMailbox <= 1000000
  );
}

function trustedTerms(catalog: MailboxCatalog | null, priceId: string): MailboxPriceTerms | null {
  if (!catalog || typeof catalog.livemode !== "boolean") return null;
  const matches = catalog.prices.filter((entry) => entry.priceId === priceId);
  const terms = matches[0];
  return matches.length === 1 && terms && validTerms(terms) ? terms : null;
}

/** Approved new-purchase terms, without calling a provider or inventing a launch price. */
export function mailboxCheckoutTerms(catalog: MailboxCatalog | null): MailboxPriceTerms | null {
  return catalog?.checkoutPriceId ? trustedTerms(catalog, catalog.checkoutPriceId) : null;
}

function licensedPrice(price: Stripe.Price, terms: MailboxPriceTerms): boolean {
  return (
    price.id === terms.priceId &&
    price.currency === terms.currency &&
    price.unit_amount === terms.unitAmount &&
    price.billing_scheme === "per_unit" &&
    price.recurring?.usage_type === "licensed" &&
    price.recurring.interval === terms.interval &&
    price.recurring.interval_count === 1 &&
    !price.transform_quantity
  );
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

function dateOf(seconds: number | null | undefined): Date | null {
  if (!Number.isSafeInteger(seconds) || !seconds || seconds < 1) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface MailboxIncreaseEvidence {
  customerId: string;
  livemode: boolean;
  seats: number;
  periodStart: Date;
  periodEnd: Date;
  prorationAt?: Date | undefined;
  previousInvoiceId?: string | null | undefined;
  invoiceId?: string | null | undefined;
}

/** Match the billed debit, not an old paid invoice or a credit for the same contract. */
export function mailboxIncreaseInvoiceMatches(
  sub: Stripe.Subscription,
  owner: MailboxIncreaseEvidence,
  evidence: Stripe.Invoice | string | null = sub.latest_invoice,
): boolean {
  const invoice = evidence;
  const item = sub.items.data[0];
  const start = Math.floor(owner.periodStart.getTime() / 1000);
  const end = Math.floor(owner.periodEnd.getTime() / 1000);
  const proration = owner.prorationAt ? Math.floor(owner.prorationAt.getTime() / 1000) : null;
  if (
    !item ||
    sub.items.data.length !== 1 ||
    !Number.isSafeInteger(item.price.unit_amount) ||
    (item.price.unit_amount ?? 0) <= 0 ||
    !Number.isSafeInteger(owner.seats) ||
    owner.seats < 1 ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end <= start ||
    !invoice ||
    typeof invoice !== "object" ||
    !invoice.id ||
    invoice.id === owner.previousInvoiceId ||
    (owner.invoiceId && invoice.id !== owner.invoiceId) ||
    idOf(invoice.customer) !== owner.customerId ||
    invoice.livemode !== owner.livemode ||
    invoice.currency !== item.price.currency ||
    idOf(invoice.parent?.subscription_details?.subscription) !== sub.id ||
    invoice.billing_reason !== "subscription_update" ||
    invoice.lines?.has_more !== false ||
    !Array.isArray(invoice.lines.data)
  )
    return false;
  const debits = invoice.lines.data.filter((line) => {
    const details = line.parent?.subscription_item_details;
    return (
      line.invoice === invoice.id &&
      line.livemode === owner.livemode &&
      line.currency === item.price.currency &&
      line.parent?.type === "subscription_item_details" &&
      details?.subscription === sub.id &&
      details.subscription_item === item.id &&
      !details.proration_details?.credited_items &&
      Number.isSafeInteger(line.amount) &&
      line.amount > 0 &&
      line.pricing?.type === "price_details" &&
      idOf(line.pricing.price_details?.price) === item.price.id &&
      // Stripe may omit the unit amount on a proration; its canonical price remains bound.
      (line.pricing.unit_amount_decimal == null
        ? details.proration === true
        : Number(line.pricing.unit_amount_decimal) === item.price.unit_amount) &&
      line.quantity === owner.seats &&
      (line.quantity_decimal == null || Number(line.quantity_decimal) === owner.seats) &&
      Number.isSafeInteger(line.period?.start) &&
      line.period.start >= start &&
      line.period.start < end &&
      line.period.end === end &&
      (proration === null || (details.proration && line.period.start === proration))
    );
  });
  return debits.length === 1;
}

/** Subscription readback and the exact billed debit must both confirm the increase. */
export function mailboxIncreasePaymentConfirmed(
  sub: Stripe.Subscription,
  owner: MailboxIncreaseEvidence,
  evidence: Stripe.Invoice | string | null = sub.latest_invoice,
): boolean {
  return (
    !sub.pending_update &&
    !!evidence &&
    typeof evidence === "object" &&
    evidence.status === "paid" &&
    evidence.amount_remaining === 0 &&
    mailboxIncreaseInvoiceMatches(sub, owner, evidence)
  );
}

type MailboxStatus = "inactive" | "trialing" | "active" | "past_due" | "canceled";

export interface MailboxSubscriptionProjection {
  teamId: string;
  status: MailboxStatus;
  seats: number;
  storageBytesPerMailbox: number;
  includedOutboundPerMailbox: number;
  periodStart: Date;
  periodEnd: Date;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripeSubscriptionItemId: string;
  stripePriceId: string;
  stripeSubscriptionCreated: number;
  currency: string;
  unitAmount: number;
  interval: "month" | "year";
  cancelAtPeriodEnd: boolean;
  cancelAt: Date | null;
  livemode: boolean;
}

/**
 * Project a re-fetched subscription owned by the already-linked Customer.
 * No event payload, success URL, team metadata or current catalog fallback grants access.
 * Null is unavailable: the caller must deny paid operations, not preserve a stale grant.
 * The caller applies the projection under its Customer/service lock and checks the period
 * on every paid operation. lastEventCreated belongs to the verified webhook, not this object.
 */
export function projectMailboxSubscription(
  sub: Stripe.Subscription,
  catalog: MailboxCatalog | null,
  owner: { teamId: string; customerId: string },
): MailboxSubscriptionProjection | null {
  if (
    !catalog ||
    !owner.teamId ||
    !owner.customerId ||
    sub.metadata?.[MAILBOX_SERVICE_METADATA_KEY] !== MAILBOX_SERVICE ||
    idOf(sub.customer) !== owner.customerId ||
    sub.livemode !== catalog.livemode ||
    !sub.id ||
    !Number.isSafeInteger(sub.created) ||
    sub.created < 1 ||
    sub.items.data.length !== 1
  )
    return null;
  const item = sub.items.data[0];
  if (!item) return null;
  const terms = trustedTerms(catalog, item.price.id);
  const seats = item.quantity;
  const periodStart = dateOf(item.current_period_start);
  const periodEnd = dateOf(item.current_period_end);
  if (
    !terms ||
    !licensedPrice(item.price, terms) ||
    !item.id ||
    !Number.isSafeInteger(seats) ||
    !seats ||
    seats < 1 ||
    seats > 10000 ||
    !periodStart ||
    !periodEnd ||
    periodEnd <= periodStart
  )
    return null;
  const status: MailboxStatus =
    sub.status === "active"
      ? "active"
      : sub.status === "trialing"
        ? "trialing"
        : sub.status === "past_due"
          ? "past_due"
          : sub.status === "canceled"
            ? "canceled"
            : "inactive";
  return {
    teamId: owner.teamId,
    status,
    seats,
    storageBytesPerMailbox: terms.storageBytesPerMailbox,
    includedOutboundPerMailbox: terms.includedOutboundPerMailbox,
    periodStart,
    periodEnd,
    stripeCustomerId: owner.customerId,
    stripeSubscriptionId: sub.id,
    stripeSubscriptionItemId: item.id,
    stripePriceId: item.price.id,
    stripeSubscriptionCreated: sub.created,
    currency: item.price.currency,
    unitAmount: terms.unitAmount,
    interval: terms.interval,
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    cancelAt: dateOf(sub.cancel_at),
    livemode: sub.livemode,
  };
}

export interface MailboxCheckoutInput {
  teamId: string;
  customerId: string;
  seats: number;
  successUrl: string;
  cancelUrl: string;
  /** Stable server-owned purchase/lease key, reused across retries and tabs. */
  idempotencyKey: string;
  /** Explicit only; no new tax registration or automatic tax default. */
  automaticTax?: boolean;
}

/** Additional methods already supplied by the pinned SDK; readers are optional for offline fixtures. */
export interface MailboxBillingStripe extends BillingStripe {
  customers: {
    create(
      params: Stripe.CustomerCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.Customer>;
    retrieve?: (id: string) => Promise<Stripe.Customer | Stripe.DeletedCustomer>;
  };
  checkout: {
    sessions: BillingStripe["checkout"]["sessions"] & {
      retrieve?: (id: string) => Promise<Stripe.Checkout.Session>;
      list?: (
        params: Stripe.Checkout.SessionListParams,
      ) => Promise<Stripe.ApiList<Stripe.Checkout.Session>>;
    };
  };
}

export interface MailboxCheckoutReadbackInput {
  teamId: string;
  stripeCustomerId: string;
  stripeSessionId: string | null;
  idempotencyKey: string;
  livemode: boolean;
}

export function mailboxCheckoutSessionMatches(
  session: Stripe.Checkout.Session,
  lease: MailboxCheckoutReadbackInput,
): boolean {
  return (
    /^cs_[A-Za-z0-9_]+$/.test(session.id) &&
    (!lease.stripeSessionId || session.id === lease.stripeSessionId) &&
    session.mode === "subscription" &&
    idOf(session.customer) === lease.stripeCustomerId &&
    session.livemode === lease.livemode &&
    session.metadata?.[MAILBOX_SERVICE_METADATA_KEY] === MAILBOX_SERVICE &&
    session.metadata?.[MAILBOX_CHECKOUT_METADATA_KEY] === lease.idempotencyKey &&
    session.metadata?.team_id === lease.teamId
  );
}

/** Readback only: a missing, duplicated or incompatible session never permits another creation. */
export async function recoverMailboxCheckoutSession(
  stripe: MailboxBillingStripe,
  lease: MailboxCheckoutReadbackInput,
): Promise<Stripe.Checkout.Session | null> {
  try {
    if (lease.stripeSessionId) {
      if (!stripe.checkout.sessions.retrieve) return null;
      const session = await stripe.checkout.sessions.retrieve(lease.stripeSessionId);
      return mailboxCheckoutSessionMatches(session, lease) ? session : null;
    }
    if (!stripe.checkout.sessions.list) return null;
    let found: Stripe.Checkout.Session | null = null;
    let startingAfter: string | undefined;
    const cursors = new Set<string>();
    for (;;) {
      const page = await stripe.checkout.sessions.list({
        customer: lease.stripeCustomerId,
        limit: 100,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
      for (const session of page.data) {
        if (session.metadata?.[MAILBOX_CHECKOUT_METADATA_KEY] !== lease.idempotencyKey) continue;
        if (found || !mailboxCheckoutSessionMatches(session, lease)) return null;
        found = session;
      }
      if (!page.has_more) return found;
      const lastId = page.data.at(-1)?.id;
      if (!lastId || cursors.has(lastId)) return null;
      cursors.add(lastId);
      startingAfter = lastId;
    }
  } catch {
    // Provider errors are ambiguous. Do not expose their payload or release the durable intent.
    return null;
  }
}

function safeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Server-only Checkout factory. Ownership, live-subscription checks and the persistent
 * purchase lease must be checked by the caller before calling Stripe. This never
 * provisions a box or writes entitlement; fulfillment requires the verified lifecycle.
 */
export async function createMailboxCheckoutSession(
  stripe: BillingStripe,
  catalog: MailboxCatalog | null,
  input: MailboxCheckoutInput,
): Promise<string> {
  const terms = mailboxCheckoutTerms(catalog);
  if (!terms) throw new MailboxBillingError("unavailable");
  if (
    !input.teamId ||
    !/^cus_[A-Za-z0-9_]+$/.test(input.customerId) ||
    !Number.isSafeInteger(input.seats) ||
    input.seats < 1 ||
    input.seats > 10000 ||
    !/^[\x21-\x7e]{1,255}$/.test(input.idempotencyKey) ||
    !safeUrl(input.successUrl) ||
    !safeUrl(input.cancelUrl)
  )
    throw new MailboxBillingError("invalid");
  const metadata = {
    [MAILBOX_SERVICE_METADATA_KEY]: MAILBOX_SERVICE,
    [MAILBOX_CHECKOUT_METADATA_KEY]: input.idempotencyKey,
    team_id: input.teamId,
  };
  const session = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      customer: input.customerId,
      client_reference_id: input.teamId,
      metadata,
      subscription_data: { metadata },
      line_items: [{ price: terms.priceId, quantity: input.seats }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      automatic_tax: { enabled: input.automaticTax ?? false },
      tax_id_collection: { enabled: input.automaticTax ?? false },
      customer_update: { address: "auto", name: "auto" },
      billing_address_collection: "auto",
    },
    { idempotencyKey: input.idempotencyKey },
  );
  if (!session.url) throw new MailboxBillingError("unavailable");
  return session.url;
}
