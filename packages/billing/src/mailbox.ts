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
  /** Null disables new purchases while archived terms can still be reconciled. */
  checkoutPriceId: string | null;
  prices: readonly MailboxPriceTerms[];
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
