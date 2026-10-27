import type { BillingStripe } from "@millionsend/billing";
import type Stripe from "stripe";
import type { BillingSummary } from "@/lib/billing-summary";

/** Display-only seam: previewing never creates an invoice or changes a subscription. */
type PreviewStripe = BillingStripe & {
  invoices?: BillingStripe["invoices"] & {
    createPreview?: (
      params: Stripe.InvoiceCreatePreviewParams,
      options?: Stripe.RequestOptions,
    ) => Promise<Stripe.Invoice>;
  };
};

export function emptyBillingSummary(state: BillingSummary["state"]): BillingSummary {
  return {
    state,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    renewalAt: null,
    accessEndsAt: null,
    nextInvoice: null,
    benefit: null,
  };
}

function iso(seconds: number | null | undefined): string | null {
  if (!Number.isSafeInteger(seconds) || (seconds ?? 0) <= 0) return null;
  const date = new Date((seconds as number) * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function money(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function id(value: string | { id: string } | null | undefined): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}
async function bounded<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("billing display unavailable")), 4500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Called ONLY with the router's already identity/contract-verified subscription. */
export async function readBillingSummary(
  stripe: BillingStripe,
  subscription: Stripe.Subscription,
): Promise<BillingSummary> {
  const unavailable = emptyBillingSummary("unavailable");
  try {
    const bases = subscription.items.data.filter(
      (item) => item.price.recurring?.usage_type === "licensed",
    );
    const base = bases[0];
    if (
      subscription.items.has_more ||
      bases.length !== 1 ||
      !base ||
      base.quantity !== 1 ||
      !["active", "trialing", "past_due"].includes(subscription.status) ||
      !money(base.price.unit_amount) ||
      base.price.unit_amount === 0 ||
      !/^[a-z]{3}$/.test(base.price.currency)
    )
      return unavailable;
    const currentPeriodStart = iso(base.current_period_start);
    const currentPeriodEnd = iso(base.current_period_end);
    if (!currentPeriodStart || !currentPeriodEnd || currentPeriodStart >= currentPeriodEnd)
      return unavailable;
    const dates = { ...unavailable, currentPeriodStart, currentPeriodEnd };
    const ending = subscription.cancel_at != null || subscription.cancel_at_period_end;
    if (ending) {
      const accessEndsAt =
        subscription.cancel_at != null ? iso(subscription.cancel_at) : currentPeriodEnd;
      if (!accessEndsAt || accessEndsAt <= currentPeriodStart) return unavailable;
      return {
        ...(subscription.status === "trialing" ? unavailable : dates),
        state: "confirmed",
        accessEndsAt,
      };
    }
    // Delinquency/trials do not establish an upcoming paid renewal.
    if (
      subscription.status !== "active" ||
      subscription.pause_collection ||
      subscription.collection_method === "send_invoice"
    )
      return unavailable;
    const invoices = (stripe as PreviewStripe).invoices;
    if (!invoices?.createPreview) return dates;
    const createPreview = invoices.createPreview.bind(invoices);
    const invoice = await bounded(() =>
      createPreview(
        {
          customer: id(subscription.customer) ?? "",
          subscription: subscription.id,
          preview_mode: "next",
          expand: ["discounts"],
        },
        { timeout: 4000, maxNetworkRetries: 0 },
      ),
    );
    if (
      id(invoice.customer) !== id(subscription.customer) ||
      id(invoice.parent?.subscription_details?.subscription) !== subscription.id ||
      invoice.currency !== base.price.currency ||
      invoice.lines.has_more ||
      !money(invoice.amount_due) ||
      !money(invoice.total) ||
      invoice.lines.data.length > 20
    )
      return dates;
    const lines = invoice.lines.data;
    if (
      lines.some(
        (line) =>
          line.currency !== invoice.currency ||
          !money(line.amount) ||
          !iso(line.period.start) ||
          !iso(line.period.end) ||
          line.period.start >= line.period.end ||
          (line.discount_amounts ?? []).some((discount) => !money(discount.amount)),
      )
    )
      return dates;
    const baseLines = lines.filter(
      (line) => line.parent?.subscription_item_details?.subscription_item === base.id,
    );
    const line = baseLines[0];
    if (
      baseLines.length !== 1 ||
      !line ||
      line.parent?.subscription_item_details?.proration !== false ||
      line.parent.subscription_item_details.subscription !== subscription.id ||
      id(line.pricing?.price_details?.price) !== base.price.id ||
      line.quantity !== 1 ||
      line.subtotal !== base.price.unit_amount ||
      line.period.start !== base.current_period_end
    )
      return dates;
    const periodStart = iso(line.period.start);
    const periodEnd = iso(line.period.end);
    if (!periodStart || !periodEnd) return dates;
    // A real full recurring period is required; do not display proration/stub dates.
    const interval = base.price.recurring;
    if (
      !interval ||
      !["month", "year"].includes(interval.interval) ||
      interval.interval_count !== 1
    )
      return dates;
    const expectedEnd = new Date(line.period.start * 1000);
    const anchorDay = expectedEnd.getUTCDate();
    expectedEnd.setUTCMonth(expectedEnd.getUTCMonth() + (interval.interval === "year" ? 12 : 1), 1);
    const last = new Date(
      Date.UTC(expectedEnd.getUTCFullYear(), expectedEnd.getUTCMonth() + 1, 0),
    ).getUTCDate();
    expectedEnd.setUTCDate(Math.min(anchorDay, last));
    if (expectedEnd.getTime() !== line.period.end * 1000) return dates;
    const discounts = line.discount_amounts ?? [];
    const knownDiscounts = [...(invoice.discounts ?? []), ...(line.discounts ?? [])];
    if (
      discounts.some((applied) => {
        const discount =
          typeof applied.discount === "object"
            ? applied.discount
            : knownDiscounts.find(
                (value) => typeof value === "object" && value.id === applied.discount,
              );
        return (
          !discount ||
          typeof discount !== "object" ||
          discount.deleted ||
          (discount.customer != null && id(discount.customer) !== id(subscription.customer)) ||
          (discount.subscription != null && discount.subscription !== subscription.id) ||
          (discount.subscription_item != null && discount.subscription_item !== base.id)
        );
      })
    )
      return dates;
    const baseDiscountCents = discounts.reduce((sum, discount) => sum + discount.amount, 0);
    if (!money(baseDiscountCents) || baseDiscountCents > line.subtotal) return dates;
    let benefit: BillingSummary["benefit"] =
      baseDiscountCents > 0
        ? {
            kind: "discount",
            periodStart,
            periodEnd,
            baseDiscountCents,
            regularBillingResumesAt: null,
          }
        : null;
    // Only a provider-applied, single, 100%-once, base-product-only MONTHLY coupon
    // establishes one courtesy period. Credits, repeating and annual reductions do not.
    // coupon.valid controls NEW redemptions, not an already applied invoice discount.
    const coupons = stripe.coupons as unknown as
      | {
          retrieve: (
            couponId: string,
            params: { expand: string[] },
            options: Stripe.RequestOptions,
          ) => Promise<Stripe.Coupon>;
        }
      | undefined;
    if (
      benefit &&
      discounts.length === 1 &&
      baseDiscountCents === line.subtotal &&
      base.price.recurring?.interval === "month" &&
      base.price.recurring.interval_count === 1 &&
      !subscription.schedule &&
      coupons
    ) {
      const applied = discounts[0];
      const discount =
        typeof applied?.discount === "object"
          ? applied.discount
          : invoice.discounts?.find(
              (value) => typeof value === "object" && value.id === applied?.discount,
            );
      if (
        discount &&
        typeof discount === "object" &&
        !discount.deleted &&
        (!discount.customer || id(discount.customer) === id(subscription.customer)) &&
        (!discount.subscription || discount.subscription === subscription.id) &&
        iso(discount.start) &&
        discount.start <= line.period.start &&
        (discount.end == null || (iso(discount.end) && discount.end >= line.period.end))
      ) {
        const couponId = id(discount.source.coupon);
        if (couponId) {
          const coupon = await bounded(() =>
            coupons.retrieve(
              couponId,
              { expand: ["applies_to"] },
              { timeout: 4000, maxNetworkRetries: 0 },
            ),
          );
          const product = id(base.price.product);
          const products = coupon.applies_to?.products;
          const meteredProducts = subscription.items.data
            .filter((item) => item.price.recurring?.usage_type === "metered")
            .map((item) => id(item.price.product));
          const oneMonthEnd = new Date(line.period.start * 1000);
          const day = oneMonthEnd.getUTCDate();
          oneMonthEnd.setUTCMonth(oneMonthEnd.getUTCMonth() + 1, 1);
          const lastDay = new Date(
            Date.UTC(oneMonthEnd.getUTCFullYear(), oneMonthEnd.getUTCMonth() + 1, 0),
          ).getUTCDate();
          oneMonthEnd.setUTCDate(Math.min(day, lastDay));
          if (
            coupon.id === couponId &&
            coupon.percent_off === 100 &&
            coupon.amount_off == null &&
            coupon.duration === "once" &&
            products?.length === 1 &&
            products[0] === product &&
            !meteredProducts.includes(product) &&
            oneMonthEnd.getTime() === line.period.end * 1000 &&
            discounts.every((d) => id(d.discount) === discount.id) &&
            (invoice.discounts ?? []).every((d) => id(d) === discount.id)
          ) {
            benefit = { ...benefit, kind: "courtesy", regularBillingResumesAt: periodEnd };
          }
        }
      }
    }
    return {
      ...dates,
      state: "confirmed",
      renewalAt: currentPeriodEnd,
      benefit,
      nextInvoice: {
        at: periodStart,
        currency: invoice.currency,
        baseAmountCents: line.subtotal,
        baseDiscountCents,
        baseNetCents: line.subtotal - baseDiscountCents,
        totalEstimateCents: invoice.amount_due,
        usageMayChange: subscription.items.data.some(
          (item) => item.price.recurring?.usage_type === "metered",
        ),
        periodStart,
        periodEnd,
      },
    };
  } catch {
    return unavailable;
  }
}
