/** Public MepMail prices and dated competitor references.
 * Resend rates were rechecked on 2026-10-16; other providers retain the
 * 2026-09-27 reference. Feature bundles differ. Offer selection is server-side.
 */

import { PLAN_RUNGS } from "@millionsend/core/plans";
import { LAUNCH_OFFER } from "./launch-offer";

/** BCB closing sell rate, retrieved on 2026-10-16; conversion is a comparison estimate. */
export const COMPARISON_FX = {
  brlPerUsd: 5.0521,
  date: "2026-10-15",
  url: "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@dataCotacao)?@dataCotacao=%2710-15-2026%27&$format=json",
} as const;

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
    mepmail: 55,
    resend: 143,
    sendgrid: 142.95,
    postmark: 245,
    mailgun: 207,
    savings: "62%",
  },
  {
    volume: 550_000,
    mepmail: 129,
    resend: 385,
    sendgrid: 439.95,
    postmark: 455,
    mailgun: 437.5,
    savings: "66%",
  },
  {
    volume: 1_100_000,
    mepmail: 239,
    resend: 715,
    sendgrid: 799,
    postmark: 775,
    mailgun: 750,
    savings: "67%",
  },
  {
    volume: 1_650_000,
    mepmail: 349,
    resend: 903,
    sendgrid: 889,
    postmark: 1037.5,
    mailgun: 1025,
    savings: "61%",
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

/** Brazil uses the catalog's charged BRL price; only foreign prices are converted. */
export function comparisonRowsForLocale(
  launchOfferEnabled: boolean,
  locale: string,
): readonly PriceRow[] {
  const rows = priceRowsForOffer(launchOfferEnabled);
  if (locale !== "pt-BR") return rows;
  return rows.map((row) => {
    const rung = PLAN_RUNGS.find((plan) => plan.period === "month" && plan.included === row.volume);
    if (!rung) throw new RangeError("Missing BRL comparison rung");
    const mepmail =
      row.volume === LAUNCH_OFFER.sending.monthlyRecipientDeliveries && launchOfferEnabled
        ? LAUNCH_OFFER.sending.brlMonthlyCents / 100
        : rung.brlPriceCents / 100;
    const converted = {
      ...row,
      mepmail,
      resend: row.resend * COMPARISON_FX.brlPerUsd,
      sendgrid: row.sendgrid * COMPARISON_FX.brlPerUsd,
      postmark: row.postmark === null ? null : row.postmark * COMPARISON_FX.brlPerUsd,
      mailgun: row.mailgun * COMPARISON_FX.brlPerUsd,
    };
    const cheapest = Math.min(
      converted.resend,
      converted.sendgrid,
      converted.postmark ?? Infinity,
      converted.mailgun,
    );
    return { ...converted, savings: `${Math.round(((cheapest - mepmail) / cheapest) * 100)}%` };
  });
}

export function formatComparisonPrice(value: number | null, locale: string): string {
  return locale === "pt-BR" && value !== null ? formatBrl(value, locale) : formatUsd(value, locale);
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

/** A plan price in reais as a headline shows it: "R$ 149", but "R$ 14,90" with cents. */
export function formatBrlPrice(cents: number, locale: string): string {
  return cents % 100 === 0
    ? `R$ ${(cents / 100).toLocaleString(locale)}`
    : formatBrl(cents / 100, locale);
}

/** A reais price for Brazil, always with cents ("R$ 14,90"; "R$ 14.90" in en). */
export function formatBrl(value: number, locale: string): string {
  return `R$ ${value.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
