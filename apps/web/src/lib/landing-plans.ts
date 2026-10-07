/**
 * Single source for the public plan ladder: the landing renders it inside its
 * #planos section and /pricing renders the same cards in one grid. The price
 * strings live here; the per-plan copy (volume, limits, overage, attachment)
 * comes from the "landing" catalog (plans.items), so both pages always show
 * the same numbers and the same words.
 */

import type { PlanRungKey } from "@millionsend/core/plans";
import { LAUNCH_OFFER } from "./launch-offer";

export type PlanTier = "core" | "scale";

export interface PlanBase {
  rung: PlanRungKey;
  name: string;
  price: string;
  tier: PlanTier;
  featured?: boolean;
}

export interface PlanCopy {
  volume: string;
  limits: string;
  overage: string;
  attachment: string;
  cta?: string;
  priceNote?: string;
}

export interface LandingPlan extends PlanBase {
  copy: PlanCopy;
}

export const PLANS: readonly PlanBase[] = [
  { rung: "free", name: "Free", price: "US$ 0", tier: "core" },
  { rung: "starter", name: "Starter", price: "US$ 9", tier: "core" },
  { rung: "pro_100k", name: "Pro 110K", price: "US$ 20", tier: "core", featured: true },
  { rung: "pro_200k", name: "Pro 220K", price: "US$ 55", tier: "core" },
  { rung: "scale_500k", name: "Scale 550K", price: "US$ 129", tier: "scale" },
  { rung: "scale_1m", name: "Scale 1.1M", price: "US$ 239", tier: "scale" },
  { rung: "scale_1_5m", name: "Scale 1.65M", price: "US$ 349", tier: "scale" },
  { rung: "scale_2_5m", name: "Scale 2.75M", price: "US$ 549", tier: "scale" },
];

export const EMPTY_PLAN_COPY: PlanCopy = { volume: "", limits: "", overage: "", attachment: "" };

/** Pairs the shared ladder with the localized copy; a missing entry renders empty. */
export function plansWithCopy(
  copy: readonly PlanCopy[],
  launchOfferEnabled = false,
  launchPriceNote?: string,
): LandingPlan[] {
  return PLANS.map((plan, index) => {
    const localizedCopy = copy[index] ?? EMPTY_PLAN_COPY;
    if (plan.rung !== "pro_100k" || !launchOfferEnabled) return { ...plan, copy: localizedCopy };
    return {
      ...plan,
      price: `US$ ${LAUNCH_OFFER.sending.monthlyCents / 100}`,
      copy: {
        ...localizedCopy,
        ...(launchPriceNote ? { priceNote: launchPriceNote } : {}),
      },
    };
  });
}
