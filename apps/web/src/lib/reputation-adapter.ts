import type { TenantReputationDto } from "@millionsend/core";
import type { ReputationSnapshot } from "../components/reputation-panel";
export function reputationSnapshot(dto: TenantReputationDto): ReputationSnapshot {
  const used = (hours: 1 | 24 | 168) =>
    dto.newRecipientWindows.find((w) => w.hours === hours)?.used ?? null;
  const refusals: Record<TenantReputationDto["reason"], ReputationSnapshot["refusal"]> = {
    capacity_unavailable: "capacity_unknown",
    sending_suspended: "review_required",
    review_required: "review_required",
    verify_identity: "verify_identity",
    verify_domain: "domain_required",
    warming: "warming",
    ready: null,
  };
  const refusal = Object.hasOwn(refusals, dto.reason) ? refusals[dto.reason] : "capacity_unknown";
  return {
    state: dto.state,
    plan: dto.plan,
    nominalMonthly: dto.nominalMonthly,
    nominalPlanDaily: null,
    effectiveDaily: dto.effectiveDaily,
    effectiveMinute: dto.effectivePerMinute,
    usedToday: dto.dailyUsed,
    dailyLeft: dto.dailyLeft,
    volume24h: dto.reputationDenominator24h,
    complaints: { count: null, denominator: dto.reputationDenominator24h, rate: dto.complaintRate },
    bounces: { count: null, denominator: dto.reputationDenominator24h, rate: dto.bounceRate },
    newRecipients: { hour: used(1), day: used(24), week: used(168) },
    recipientWindows: dto.newRecipientWindows,
    warmupPercent: dto.warmupPercent,
    nextDailyLimit: dto.nextDaily,
    nextEligibleAt: dto.nextEligibleAt,
    campaignEligible: dto.campaignEligible,
    capacityKnown: dto.capacityKnown,
    capacityAvailable: dto.capacityAvailable,
    refusal,
    nextStep: dto.nextStep,
  };
}
