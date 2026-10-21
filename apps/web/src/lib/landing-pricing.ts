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

/**
 * Resend's transactional plans as resend.com/pricing.md publishes them (checked on
 * 2026-10-16, unchanged on 2026-10-19): monthly price in USD, included emails and the
 * overage per 1,000 past them.
 */
export const RESEND_PLANS = [
  { name: "Pro", included: 50_000, usd: 20, overagePer1k: 0.9 },
  { name: "Pro", included: 100_000, usd: 35, overagePer1k: 0.9 },
  { name: "Scale", included: 100_000, usd: 90, overagePer1k: 0.9 },
  { name: "Scale", included: 200_000, usd: 160, overagePer1k: 0.8 },
  { name: "Scale", included: 500_000, usd: 350, overagePer1k: 0.7 },
  { name: "Scale", included: 1_000_000, usd: 650, overagePer1k: 0.65 },
  { name: "Scale", included: 1_500_000, usd: 825, overagePer1k: 0.52 },
  { name: "Scale", included: 2_500_000, usd: 1_150, overagePer1k: 0.46 },
] as const;

export interface ResendQuote {
  /** "Pro 100K", "Scale 500K", "Scale 1.5M": the plan the cheapest option starts from. */
  plan: string;
  /** The plan's monthly price, US$. */
  base: number;
  /** Emails past the plan's volume, billed as overage. */
  extra: number;
  overagePer1k: number;
  /** base + overage, US$ with cents. */
  total: number;
}

function planVolumeLabel(included: number): string {
  return included >= 1_000_000 ? `${included / 1_000_000}M` : `${included / 1_000}K`;
}

/**
 * The cheapest published way to send `volume` emails a month on Resend: a plan, plus
 * overage for each started 1,000 past it. 110,000 is Pro 100K (US$ 35) + 10,000 extra at
 * US$ 0.90 per 1,000 = US$ 44, not the US$ 35 of the 100K plan alone.
 */
export function resendQuote(volume: number): ResendQuote {
  let best: ResendQuote | null = null;
  for (const plan of RESEND_PLANS) {
    const extra = Math.max(0, volume - plan.included);
    const total = Math.round((plan.usd + Math.ceil(extra / 1_000) * plan.overagePer1k) * 100) / 100;
    if (best === null || total < best.total)
      best = {
        plan: `${plan.name} ${planVolumeLabel(plan.included)}`,
        base: plan.usd,
        extra,
        overagePer1k: plan.overagePer1k,
        total,
      };
  }
  if (best === null) throw new RangeError("No Resend plan");
  return best;
}

/**
 * AgentMail's Developer tier as agentmail.to/pricing lists it, checked on 2026-10-20: the
 * reference the home quotes against Correio Equipe (10 mailboxes, 10,000 recipients and
 * 10 domains for US$ 12.90). Recheck the page before changing either side.
 */
export const AGENTMAIL_DEVELOPER = {
  usd: 20,
  inboxes: 10,
  emails: 10_000,
  domains: 10,
  checked: "2026-10-20",
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
    resend: resendQuote(110_000).total,
    sendgrid: 43.95,
    postmark: 115,
    mailgun: 86,
    savings: "54%",
  },
  {
    volume: 220_000,
    mepmail: 55,
    resend: resendQuote(220_000).total,
    sendgrid: 142.95,
    postmark: 245,
    mailgun: 207,
    savings: "62%",
  },
  {
    volume: 550_000,
    mepmail: 129,
    resend: resendQuote(550_000).total,
    sendgrid: 439.95,
    postmark: 455,
    mailgun: 437.5,
    savings: "66%",
  },
  {
    volume: 1_100_000,
    mepmail: 239,
    resend: resendQuote(1_100_000).total,
    sendgrid: 799,
    postmark: 775,
    mailgun: 750,
    savings: "67%",
  },
  {
    volume: 1_650_000,
    mepmail: 349,
    resend: resendQuote(1_650_000).total,
    sendgrid: 889,
    postmark: 1037.5,
    mailgun: 1025,
    savings: "61%",
  },
  {
    volume: 2_750_000,
    mepmail: 549,
    resend: resendQuote(2_750_000).total,
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

/**
 * A comparison figure quoted in a sentence or a headline: rounded to whole units, as a
 * headline price reads ("R$ 649", "R$ 1.945", "US$ 385"). The table keeps the cents.
 */
export function formatWholeComparisonPrice(value: number, locale: string): string {
  const whole = Math.round(value);
  return locale === "pt-BR" ? formatBrlPrice(whole * 100, locale) : formatUsd(whole, locale);
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
