import { PLAN_RUNGS } from "@millionsend/core/plans";
import { LAUNCH_OFFER } from "./launch-offer";

/** Transactional outbound only, USD recurring prices, before tax. No introductory discount.
 * Resend's published Pro 50K is $20/month, checked 2026-10-24.
 * https://resend.com/pricing.md (commercial-facts.json, source 1).
 * A daily allowance is NOT a fungible monthly balance or a burst entitlement.
 */
export const ENTRY_COMPARISON_SOURCE = {
  checkedAt: "2026-10-24",
  resend: "https://resend.com/pricing.md",
  mepmail: "https://github.com/JE4NVRG/mepmail/blob/4c11098772836b8ad9e2f4d414bbc58353e4e29b/packages/core/src/plans.ts",
  offer: "https://github.com/JE4NVRG/mepmail/blob/4c11098772836b8ad9e2f4d414bbc58353e4e29b/apps/web/src/lib/launch-offer.ts",
} as const;

const starter = PLAN_RUNGS.find((rung) => rung.key === "starter");
if (!starter) throw new Error("Missing Starter catalog rung");

/** Only render against the public recurring offer, never a grandfathered Pro contract. */
export const ENTRY_PLAN_COMPARISON = [
  {
    volume: 10_000,
    plan: "Starter",
    mepmailUsd: starter.priceCents / 100,
    resendUsd: 20,
    condition: "daily" as const,
    dailyCap: starter.included,
    minimumSendingDays: Math.ceil(10_000 / starter.included),
  },
  {
    volume: 50_000,
    plan: "Pro 110K",
    mepmailUsd: LAUNCH_OFFER.sending.monthlyCents / 100,
    resendUsd: 20,
    condition: "monthly" as const,
    monthlyIncluded: LAUNCH_OFFER.sending.monthlyRecipientDeliveries,
  },
] as const;
