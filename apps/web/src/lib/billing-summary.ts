export interface BillingAmount {
  amountCents: number;
  currency: string;
  interval: "month" | "year";
}

/** A sum is useful only when its currency and billing periods agree. */
export function compatibleBillingTotal(
  left: BillingAmount | null,
  right: BillingAmount | null,
): BillingAmount | null {
  if (
    !left ||
    !right ||
    left.interval !== right.interval ||
    left.currency.toLowerCase() !== right.currency.toLowerCase()
  )
    return null;
  if (
    ![left.amountCents, right.amountCents].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    return null;
  const amountCents = left.amountCents + right.amountCents;
  return Number.isSafeInteger(amountCents)
    ? { amountCents, currency: left.currency.toLowerCase(), interval: left.interval }
    : null;
}

/** Arithmetic reference; it does not turn a daily sending limit into a monthly allowance. */
export function dailyQuotaReference(limit: number): { days: 30; volume: number } {
  return { days: 30, volume: limit * 30 };
}
