/**
 * Correio plan arithmetic shared by the service panel and the setup dialog.
 * Two price shapes coexist: per-mailbox prices (the older offers: every
 * mailbox costs unitAmount and carries its own allowance) and bundles
 * (quotaScope "team": unitAmount covers includedMailboxes, each one above
 * costs extraUnitAmount, and the allowance is shared by the team).
 */
export type MailboxPlanTerms = {
  unitAmount: number;
  currency: string;
  interval: "month" | "year";
  quotaScope?: "mailbox" | "team" | undefined;
  includedMailboxes?: number | undefined;
  extraUnitAmount?: number | null | undefined;
  localCurrency?: {
    currency: string;
    unitAmount: number;
    extraUnitAmount: number | null;
  } | null;
  trialDays?: number | undefined;
};

const MAX_SEATS = 10_000;

/** A bundle: one price for several mailboxes, with a shared allowance. */
export function isMailboxBundle(terms: MailboxPlanTerms): boolean {
  return terms.quotaScope === "team" || (terms.includedMailboxes ?? 1) > 1;
}

/** The fewest mailboxes the plan can be bought with (the bundle's size). */
export function mailboxPlanMinimumSeats(terms: MailboxPlanTerms): number {
  return Math.max(1, Math.trunc(terms.includedMailboxes ?? 1));
}

/** The most mailboxes it can be bought with: a bundle without an extra price stops at its size. */
export function mailboxPlanMaximumSeats(terms: MailboxPlanTerms): number {
  return isMailboxBundle(terms) && !terms.extraUnitAmount
    ? mailboxPlanMinimumSeats(terms)
    : MAX_SEATS;
}

export function validMailboxPlanSeats(terms: MailboxPlanTerms, seats: number): boolean {
  return (
    Number.isSafeInteger(seats) &&
    seats >= mailboxPlanMinimumSeats(terms) &&
    seats <= mailboxPlanMaximumSeats(terms)
  );
}

/**
 * The price for `seats` mailboxes per interval, in minor units, in the
 * offer's currency or (`local`) in its local display currency. Null when the
 * local currency is not offered or the quantity is not valid.
 */
export function mailboxPlanTotal(
  terms: MailboxPlanTerms,
  seats: number,
  local = false,
): { amount: number; currency: string } | null {
  if (!validMailboxPlanSeats(terms, seats)) return null;
  const prices = local
    ? terms.localCurrency
      ? {
          currency: terms.localCurrency.currency,
          unit: terms.localCurrency.unitAmount,
          extra: terms.localCurrency.extraUnitAmount,
        }
      : null
    : { currency: terms.currency, unit: terms.unitAmount, extra: terms.extraUnitAmount ?? null };
  if (!prices) return null;
  if (!isMailboxBundle(terms)) return { amount: prices.unit * seats, currency: prices.currency };
  const extras = seats - mailboxPlanMinimumSeats(terms);
  if (extras > 0 && !prices.extra) return null;
  return { amount: prices.unit + extras * (prices.extra ?? 0), currency: prices.currency };
}

/** A starting quantity inside the plan's range (the bundle's size for a new purchase). */
export function clampMailboxPlanSeats(terms: MailboxPlanTerms, seats: number): number {
  const value = Number.isFinite(seats) ? Math.trunc(seats) : mailboxPlanMinimumSeats(terms);
  return Math.min(mailboxPlanMaximumSeats(terms), Math.max(mailboxPlanMinimumSeats(terms), value));
}
