/** Public MepMail prices compared with the dated 2026-09-27 benchmark.
 * Competitor values are historical references, not current quotes or equivalent
 * feature bundles. The new offer is selected by the server, never client env.
 */
import { LAUNCH_OFFER } from "./launch-offer";

export interface PriceRow {
  /** Emails per month this row refers to: a MepMail rung (plans.ts PLAN_RUNGS). */
  volume: number;
  mepmail: number;
  resend: number;
  sendgrid: number;
  /** null = no public price, quoted commercially: "(vendas)" / "(sales)". */
  postmark: number | null;
  mailgun: number;
  /** Advantage against the cheapest competitor on this row, as the table shows it. */
  savings: string;
}

export const PRICE_ROWS: readonly PriceRow[] = [
  {
    volume: 110_000,
    mepmail: 20,
    resend: 44,
    sendgrid: 43.95,
    postmark: 115,
    mailgun: 86,
    savings: "54%",
  },
  {
    volume: 220_000,
    mepmail: 100,
    resend: 143,
    sendgrid: 142.95,
    postmark: 245,
    mailgun: 207,
    savings: "30%",
  },
  {
    volume: 550_000,
    mepmail: 199,
    resend: 385,
    sendgrid: 439.95,
    postmark: 455,
    mailgun: 437.5,
    savings: "48%",
  },
  {
    volume: 1_100_000,
    mepmail: 319,
    resend: 715,
    sendgrid: 799,
    postmark: 775,
    mailgun: 750,
    savings: "55%",
  },
  {
    volume: 1_650_000,
    mepmail: 429,
    resend: 903,
    sendgrid: 889,
    postmark: 1037.5,
    mailgun: 1025,
    savings: "52%",
  },
  {
    volume: 2_750_000,
    mepmail: 549,
    resend: 1265,
    sendgrid: 1224,
    postmark: 2962.5,
    mailgun: 1350,
    savings: "55%",
  },
];

/** Presentation only: existing subscriptions and the core catalog are unchanged. */
export function priceRowsForOffer(launchOfferEnabled: boolean): readonly PriceRow[] {
  if (!launchOfferEnabled) return PRICE_ROWS;
  return PRICE_ROWS.map((row) => {
    if (row.volume !== LAUNCH_OFFER.sending.monthlyRecipientDeliveries) return row;
    const mepmail = LAUNCH_OFFER.sending.monthlyCents / 100;
    const cheapest = Math.min(row.resend, row.sendgrid, row.postmark ?? Infinity, row.mailgun);
    return { ...row, mepmail, savings: `${Math.round(((cheapest - mepmail) / cheapest) * 100)}%` };
  });
}

export const COMPETITORS = [
  { key: "resend", name: "Resend" },
  { key: "sendgrid", name: "SendGrid" },
  { key: "postmark", name: "Postmark" },
  { key: "mailgun", name: "Mailgun" },
] as const;

export type CompetitorKey = (typeof COMPETITORS)[number]["key"];

/**
 * Price cell for the public table ("US$ 35" whole, "US$ 34.95" in en against
 * "US$ 34,95" in pt-BR). A null price is a commercial quote: "(sales)" in
 * English, "(vendas)" in Portuguese. No row needs it today, but the branch stays
 * so a future quote cell cannot leak the pt-BR word into the EN table.
 */
export function formatUsd(value: number | null, locale: string): string {
  if (value === null) return locale.startsWith("pt") ? "(vendas)" : "(sales)";
  const formatted = Number.isInteger(value)
    ? value.toLocaleString(locale)
    : value.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `US$ ${formatted}`;
}

/**
 * Volume label for the table's first column and the calculator, derived from the
 * row's own `volume` so the label and the prices it heads can never drift apart:
 * "110k", "550k", "1.65M" in en against "110k", "550k", "1,65M" in pt-BR. Two
 * decimals are kept where the rung carries them (1.65M, 2.75M); the trailing
 * zero of 1.1M is dropped. Volumes are ≥ 1k by construction: the rows are the
 * MepMail ladder, cheapest first.
 */
export function formatVolume(volume: number, locale: string): string {
  const millions = volume >= 1_000_000;
  const scaled = millions ? volume / 1_000_000 : volume / 1_000;
  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(scaled);
  return `${formatted}${millions ? "M" : "k"}`;
}
