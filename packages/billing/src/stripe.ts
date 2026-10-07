import Stripe from "stripe";

/**
 * The slice of the Stripe SDK billing touches. The real client satisfies it
 * structurally; tests hand in a fake with the same shape.
 */
export interface BillingStripe {
  prices: { list(params: Stripe.PriceListParams): Promise<Stripe.ApiList<Stripe.Price>> };
  customers: {
    create(
      params: Stripe.CustomerCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.Customer>;
    retrieve?: (id: string) => Promise<Stripe.Customer | Stripe.DeletedCustomer>;
  };
  subscriptions: {
    retrieve(id: string, params?: Stripe.SubscriptionRetrieveParams): Promise<Stripe.Subscription>;
    list(params: Stripe.SubscriptionListParams): Promise<Stripe.ApiList<Stripe.Subscription>>;
    update(
      id: string,
      params?: Stripe.SubscriptionUpdateParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.Subscription>;
    cancel(id: string, params?: Stripe.SubscriptionCancelParams): Promise<Stripe.Subscription>;
  };
  invoices?: {
    retrieve(id: string): Promise<Stripe.Invoice>;
    list?: (params: Stripe.InvoiceListParams) => Promise<Stripe.ApiList<Stripe.Invoice>>;
  };
  coupons?: { retrieve(id: string, params?: Stripe.CouponRetrieveParams): Promise<Stripe.Coupon> };
  /** Read only: the fraud screen looks for payments Stripe's Radar blocked. */
  charges?: { list(params: Stripe.ChargeListParams): Promise<Stripe.ApiList<Stripe.Charge>> };
  subscriptionItems: {
    create(params: Stripe.SubscriptionItemCreateParams): Promise<Stripe.SubscriptionItem>;
    update(
      id: string,
      params?: Stripe.SubscriptionItemUpdateParams,
    ): Promise<Stripe.SubscriptionItem>;
    del(
      id: string,
      params?: Stripe.SubscriptionItemDeleteParams,
    ): Promise<Stripe.DeletedSubscriptionItem>;
  };
  subscriptionSchedules: {
    create(
      params: Stripe.SubscriptionScheduleCreateParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.SubscriptionSchedule>;
    update(
      id: string,
      params: Stripe.SubscriptionScheduleUpdateParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.SubscriptionSchedule>;
    release(
      id: string,
      params?: Stripe.SubscriptionScheduleReleaseParams,
      options?: Stripe.RequestOptions,
    ): Promise<Stripe.SubscriptionSchedule>;
    retrieve?: (id: string) => Promise<Stripe.SubscriptionSchedule>;
  };
  billing: {
    meterEvents: {
      create(params: Stripe.Billing.MeterEventCreateParams): Promise<Stripe.Billing.MeterEvent>;
    };
  };
  checkout: {
    sessions: {
      create(
        params: Stripe.Checkout.SessionCreateParams,
        options?: Stripe.RequestOptions,
      ): Promise<Stripe.Checkout.Session>;
      retrieve?: (
        id: string,
        params?: Stripe.Checkout.SessionRetrieveParams,
      ) => Promise<Stripe.Checkout.Session>;
      list?: (
        params: Stripe.Checkout.SessionListParams,
      ) => Promise<Stripe.ApiList<Stripe.Checkout.Session>>;
    };
  };
  billingPortal: {
    sessions: {
      create(
        params: Stripe.BillingPortal.SessionCreateParams,
      ): Promise<Stripe.BillingPortal.Session>;
    };
  };
  webhooks: { constructEvent(payload: string, header: string, secret: string): Stripe.Event };
}

export function createStripe(secretKey: string): BillingStripe {
  return new Stripe(secretKey);
}

/** Secret and restricted keys share the `_live_` / `_test_` mode marker. */
export function isLiveKey(secretKey: string): boolean {
  return /^[sr]k_live_/.test(secretKey);
}

/**
 * Stripe's answer that the request's `customer` does not exist under this
 * key: deleted, from another account, or a test-mode id met by a live key.
 */
export function isMissingStripeCustomer(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, param } = err as { code?: unknown; param?: unknown };
  return code === "resource_missing" && param === "customer";
}
