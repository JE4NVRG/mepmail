/**
 * Single source for the public plan ladder: the landing renders it inside its
 * #planos section and /pricing renders the same cards in one grid. The price
 * strings live here; the per-plan copy (volume, limits, overage, attachment)
 * comes from the "landing" catalog (plans.items), so both pages always show
 * the same numbers and the same words.
 */

export type PlanTier = "core" | "scale";

export interface PlanBase {
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
}

export interface LandingPlan extends PlanBase {
  copy: PlanCopy;
}

export const PLANS: readonly PlanBase[] = [
  { name: "Free", price: "US$ 0", tier: "core" },
  { name: "Starter", price: "US$ 9", tier: "core" },
  { name: "Pro 110K", price: "US$ 20", tier: "core", featured: true },
  { name: "Pro 220K", price: "US$ 100", tier: "core" },
  { name: "Scale 550K", price: "US$ 199", tier: "scale" },
  { name: "Scale 1.1M", price: "US$ 319", tier: "scale" },
  { name: "Scale 1.65M", price: "US$ 429", tier: "scale" },
  { name: "Scale 2.75M", price: "US$ 549", tier: "scale" },
];

export const EMPTY_PLAN_COPY: PlanCopy = { volume: "", limits: "", overage: "", attachment: "" };

/** Pairs the shared ladder with the localized copy; a missing entry renders empty. */
export function plansWithCopy(copy: readonly PlanCopy[]): LandingPlan[] {
  return PLANS.map((plan, index) => ({ ...plan, copy: copy[index] ?? EMPTY_PLAN_COPY }));
}
