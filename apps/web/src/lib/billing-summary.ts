/** Customer-safe billing display contract. No provider IDs, tokens or operator-only notes. */
export type BillingSummary = {
  state: "confirmed" | "unavailable" | "not_applicable";
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  renewalAt: string | null;
  accessEndsAt: string | null;
  nextInvoice: {
    at: string;
    currency: string;
    baseAmountCents: number;
    baseDiscountCents: number;
    baseNetCents: number;
    totalEstimateCents: number;
    usageMayChange: boolean;
    periodStart: string;
    periodEnd: string;
  } | null;
  benefit: {
    kind: "courtesy" | "discount";
    periodStart: string;
    periodEnd: string;
    baseDiscountCents: number;
    regularBillingResumesAt: string | null;
  } | null;
};
