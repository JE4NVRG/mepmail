/**
 * Single source for the landing price comparison: display strings for the public
 * table (via formatUsd) and numbers for the savings calculator. Both locales
 * render the same neutral formatting; test/landing-savings.test.ts pins the
 * table cell-for-cell so a formatter change cannot silently alter the copy.
 */

export interface PriceRow {
  /** Volume label as shown in the table ("100k", "1,5M"). */
  label: string;
  /** Emails per month this row refers to. */
  volume: number;
  mepmail: number;
  resend: number;
  sendgrid: number;
  /** null = "(vendas)": no public price, quoted commercially. */
  postmark: number | null;
  mailgun: number;
  /** Human-readable advantage range as shown in the table. */
  savings: string;
}

export const PRICE_ROWS: readonly PriceRow[] = [
  {
    label: "100k",
    volume: 100_000,
    mepmail: 20,
    resend: 35,
    sendgrid: 34.95,
    postmark: 115,
    mailgun: 90,
    savings: "43%",
  },
  {
    label: "200k",
    volume: 200_000,
    mepmail: 100,
    resend: 160,
    sendgrid: 249,
    postmark: 245,
    mailgun: 215,
    savings: "38–60%",
  },
  {
    label: "500k",
    volume: 500_000,
    mepmail: 199,
    resend: 350,
    sendgrid: 499,
    postmark: 455,
    mailgun: 400,
    savings: "43–60%",
  },
  {
    label: "1M",
    volume: 1_000_000,
    mepmail: 319,
    resend: 650,
    sendgrid: 799,
    postmark: 775,
    mailgun: 700,
    savings: "51–60%",
  },
  {
    label: "1,5M",
    volume: 1_500_000,
    mepmail: 429,
    resend: 825,
    sendgrid: 799,
    postmark: 775,
    mailgun: 700,
    savings: "39–48%",
  },
  {
    label: "2,5M",
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

/** Formats like the public table always has: "US$ 35", "US$ 34,95", "US$ 1.150", "(vendas)". */
export function formatUsd(value: number | null): string {
  if (value === null) return "(vendas)";
  const formatted = Number.isInteger(value)
    ? value.toLocaleString("pt-BR")
    : value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `US$ ${formatted}`;
}
