import { PLAN_RUNGS, type PlanRungKey } from "@millionsend/core/plans";

/** Valida a identidade comercial sem criar checkout ou alterar assinatura. */
export function paidRung(value: unknown): PlanRungKey | null {
  return typeof value === "string"
    ? (PLAN_RUNGS.find((rung) => rung.key === value && rung.priceCents > 0)?.key ?? null)
    : null;
}

export function signupHref(value: unknown): string {
  const rung = paidRung(value);
  return rung ? `/signup?next=${encodeURIComponent(`/settings/billing?rung=${rung}`)}` : "/signup";
}
