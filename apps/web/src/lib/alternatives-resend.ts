import { PRICE_ROWS, type PriceRow } from "./landing-pricing";

/**
 * Honest Resend comparison for /alternatives/resend.
 *
 * The Resend column is the public price of the plan that covers each monthly
 * volume, read from resend.com/pricing on 2026-09-27 (commercial analysis:
 * docs/gtm/bench-concorrentes-2026-09.md §2.1). The rows are derived from
 * PRICE_ROWS — the same numbers the landing table renders — and every saving is
 * computed, never typed, so no cell can drift from the data.
 *
 * The headline claim ("up to 60% cheaper") is anchored on the most expensive
 * publicly priced rung of the market (SendGrid), NOT on Resend: against Resend
 * the maximum is 52% at 2.5M. Both numbers are exported here so the page states
 * them from the data instead of restating them by hand.
 */

export const RESEND_PRICING_SOURCE = {
  provider: "Resend",
  url: "https://resend.com/pricing",
  checkedOn: "2026-09-27",
} as const;

export interface ResendRow {
  /** Emails per month this row refers to; the table label renders from it (formatVolume). */
  volume: number;
  mepmail: number;
  resend: number;
}

export const RESEND_ROWS: readonly ResendRow[] = PRICE_ROWS.map((row) => ({
  volume: row.volume,
  mepmail: row.mepmail,
  resend: row.resend,
}));

export interface ResendSavings {
  /** US$ per month MepMail is below Resend at this volume. */
  usd: number;
  /** Rounded percentage, as published. */
  pct: number;
}

export function resendSavings(row: ResendRow): ResendSavings {
  const usd = row.resend - row.mepmail;
  return { usd, pct: Math.round((usd / row.resend) * 100) };
}

/** Percentage we beat SendGrid's public price by; 0 when it has no public price. */
function sendgridSavingsPct(row: PriceRow): number {
  if (row.sendgrid === null) return 0;
  return Math.round(((row.sendgrid - row.mepmail) / row.sendgrid) * 100);
}

const RESEND_SAVINGS_PCT = RESEND_ROWS.map((row) => resendSavings(row).pct);

/** Ceiling of the claim against Resend — 52% on the top rung. */
export const MAX_RESEND_SAVINGS_PCT = Math.max(...RESEND_SAVINGS_PCT);

/** Floor of the savings shown in the comparison table — 38% at 200k. */
export const MIN_RESEND_SAVINGS_PCT = Math.min(...RESEND_SAVINGS_PCT);

/** Ceiling against the most expensive published market price — 60% (SendGrid). */
export const MAX_MARKET_SAVINGS_PCT = PRICE_ROWS.reduce(
  (max, row) => Math.max(max, sendgridSavingsPct(row)),
  0,
);

/** The rung that anchors the headline claim: the most expensive publicly priced
 *  SendGrid rung we beat by the headline margin (ties broken by the pricier
 *  competitor, so the page cites the dearest public price, not a softer one). */
export const CLAIM_ANCHOR_ROW: PriceRow = (() => {
  let best: PriceRow | null = null;
  for (const row of PRICE_ROWS) {
    if (best === null) {
      best = row;
      continue;
    }
    const pct = sendgridSavingsPct(row);
    const bestPct = sendgridSavingsPct(best);
    const price = row.sendgrid ?? 0;
    const bestPrice = best.sendgrid ?? 0;
    if (pct > bestPct || (pct === bestPct && price > bestPrice)) best = row;
  }
  if (best === null) throw new Error("PRICE_ROWS is empty: no claim anchor");
  return best;
})();
