/**
 * Pure helpers for the operator console. The plan ladder lives in
 * @millionsend/core/plans, whose barrel is server-only; the few facts the
 * console dialogs print (prices, daily limits, the volume format) are
 * restated here and must match PLAN_RUNGS.
 */

/** "100K", "1M", "1.5M": mirrors formatVolume in @millionsend/core/plans. */
export function formatVolume(n: number): string {
  if (n >= 1_000_000) return `${n / 1_000_000}M`;
  if (n >= 1_000) return `${n / 1_000}K`;
  return String(n);
}

/** Monthly price in cents per plan rung key. */
export const RUNG_PRICE_CENTS: Record<string, number> = {
  starter: 900,
  pro_100k: 2_000,
  pro_200k: 3_500,
  scale_500k: 7_500,
  scale_1m: 14_000,
  scale_1_5m: 20_000,
  scale_2_5m: 33_000,
};

/** Emails per day on the daily-capped plans. */
export const PLAN_DAY_LIMIT: Record<string, number> = {
  free: 100,
  starter: 1_500,
};

/** "Pro 100K" on a monthly rung, the bare (already translated) plan name otherwise. */
export function planLabel(name: string, planQuota: number | null): string {
  return planQuota ? `${name} ${formatVolume(planQuota)}` : name;
}

/** Plan pill tone: info for system, success for paid, neutral for free and unknown values. */
export function planTone(plan: string): "info" | "success" | "neutral" {
  if (plan === "system") return "info";
  if (plan === "starter" || plan === "pro" || plan === "scale") return "success";
  return "neutral";
}
