import { COMPETITORS, PRICE_ROWS, type CompetitorKey, type PriceRow } from "./landing-pricing";

export interface Savings {
  row: PriceRow;
  competitor: { key: CompetitorKey; name: string; price: number };
  savingsUsd: number;
  savingsPct: number;
  savingsYearUsd: number;
}

/** Savings against the cheapest competitor that has a public price. */
export function computeSavings(row: PriceRow): Savings {
  let best: { key: CompetitorKey; name: string; price: number } | null = null;
  for (const competitor of COMPETITORS) {
    const price = row[competitor.key];
    if (price === null) continue;
    if (best === null || price < best.price) {
      best = { key: competitor.key, name: competitor.name, price };
    }
  }
  if (best === null) throw new Error(`row ${row.label} has no competitor price`);
  const savingsUsd = best.price - row.mepmail;
  return {
    row,
    competitor: best,
    savingsUsd,
    savingsPct: Math.round((savingsUsd / best.price) * 100),
    savingsYearUsd: savingsUsd * 12,
  };
}

export function savingsForIndex(index: number): Savings {
  const row = PRICE_ROWS[index];
  if (!row) throw new Error(`no price row at index ${index}`);
  return computeSavings(row);
}
