/**
 * Single source for the landing price comparison: display strings for the public
 * table (via formatUsd / formatVolume) and numbers for the savings calculator.
 * Both locales share the numbers but NOT the separators: the audience is global
 * and English is the default, so "en" renders US formatting ("US$ 1,150",
 * "1.5M", "(sales)") and pt-BR the mirrored Brazilian one ("US$ 1.150",
 * "1,5M", "(vendas)"). test/landing-savings.test.ts pins the table cell-for-cell
 * in both locales so a formatter change cannot silently alter the copy.
 */

export interface PriceRow {
  /** Emails per month this row refers to; the table label renders from it (formatVolume). */
  volume: number;
  mepmail: number;
  resend: number;
  sendgrid: number;
  /** null = no public price, quoted commercially: "(vendas)" / "(sales)". */
  postmark: number | null;
  mailgun: number;
  /** Human-readable advantage range as shown in the table. */
  savings: string;
}

export const PRICE_ROWS: readonly PriceRow[] = [
  {
    volume: 100_000,
    mepmail: 20,
    resend: 35,
    sendgrid: 34.95,
    postmark: 115,
    mailgun: 90,
    savings: "43%",
  },
  {
    volume: 200_000,
    mepmail: 100,
    resend: 160,
    sendgrid: 249,
    postmark: 245,
    mailgun: 215,
    savings: "38–60%",
  },
  {
    volume: 500_000,
    mepmail: 199,
    resend: 350,
    sendgrid: 499,
    postmark: 455,
    mailgun: 400,
    savings: "43–60%",
  },
  {
    volume: 1_000_000,
    mepmail: 319,
    resend: 650,
    sendgrid: 799,
    postmark: 775,
    mailgun: 700,
    savings: "51–60%",
  },
  {
    volume: 1_500_000,
    mepmail: 429,
    resend: 825,
    sendgrid: 799,
    postmark: 775,
    mailgun: 700,
    savings: "39–48%",
  },
  {
    volume: 2_500_000,
    mepmail: 549,
    resend: 1150,
    sendgrid: 1099,
    postmark: null,
    mailgun: 1250,
    savings: "50–56%",
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
 * "US$ 34,95" in pt-BR). A null price is the commercial quote the refNote
 * promises: "(sales)" in English, "(vendas)" in Portuguese — the EN table must
 * never show the pt-BR word.
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
 * "100k" in both locales, "1M" / "2.5M" in en against "1M" / "2,5M" in pt-BR.
 * Volumes are ≥ 1k by construction (the market rungs the table anchors start at
 * 100k; the MepMail ladder prices the row that covers it).
 */
export function formatVolume(volume: number, locale: string): string {
  const millions = volume >= 1_000_000;
  const scaled = millions ? volume / 1_000_000 : volume / 1_000;
  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(scaled);
  return `${formatted}${millions ? "M" : "k"}`;
}
