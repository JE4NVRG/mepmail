/**
 * Single source for the landing price comparison: display strings for the public
 * table (via formatUsd / formatVolume) and numbers for the savings calculator.
 * Both locales share the numbers but NOT the separators: the audience is global
 * and English is the default, so "en" renders US formatting ("US$ 1,265",
 * "1.65M") and pt-BR the mirrored Brazilian one ("US$ 1.265", "1,65M"). The
 * rows are the MepMail rungs of release v.44 (+10% volume, same price), in the
 * same order packages/core/src/plans.ts lists them; every competitor figure is
 * the cheapest published way to send that volume (the rung that covers it, or a
 * smaller rung plus that plan's published overage), from
 * docs/gtm/bench-concorrentes-2026-09.md. test/landing-savings.test.ts pins the
 * table cell-for-cell in both locales and checks the Advantage column against
 * the calculator's own arithmetic, so a formatter change cannot silently alter
 * the copy or drift from computeSavings.
 */

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
