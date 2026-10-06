export interface MailboxLaunchCohort {
  version: 1;
  capturedAt: string;
  members: Array<{
    teamId: string;
    customerId: string;
    subscriptionId: string;
    /** Explicit operator grant only; never inferred from being an old customer. */
    grandfatheredTwentyDollarPlan?: true;
  }>;
}

/** An operator captures only verified paid-active Envio contracts above US$20
 * at the actual opening. This immutable membership is not inferred from dates,
 * labels or a later purchase. The original subscription ID remains evidence.
 */
export function parseMailboxLaunchCohort(raw: string | undefined): MailboxLaunchCohort | null {
  if (raw === undefined || raw.length > 2_000_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "capturedAt,members,version" ||
    record.version !== 1 ||
    typeof record.capturedAt !== "string" ||
    !Array.isArray(record.members) ||
    record.members.length > 10_000
  )
    return null;
  const captured = new Date(record.capturedAt);
  if (!Number.isFinite(captured.getTime()) || captured.toISOString() !== record.capturedAt)
    return null;
  const teams = new Set<string>();
  const customers = new Set<string>();
  for (const entry of record.members) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const member = entry as Record<string, unknown>;
    if (
      ![
        "customerId,subscriptionId,teamId",
        "customerId,grandfatheredTwentyDollarPlan,subscriptionId,teamId",
      ].includes(Object.keys(member).sort().join(",")) ||
      (Object.hasOwn(member, "grandfatheredTwentyDollarPlan") &&
        member.grandfatheredTwentyDollarPlan !== true) ||
      typeof member.teamId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(member.teamId) ||
      typeof member.customerId !== "string" ||
      !/^cus_[A-Za-z0-9_]+$/.test(member.customerId) ||
      typeof member.subscriptionId !== "string" ||
      !/^sub_[A-Za-z0-9_]+$/.test(member.subscriptionId) ||
      teams.has(member.teamId) ||
      customers.has(member.customerId)
    )
      return null;
    teams.add(member.teamId);
    customers.add(member.customerId);
  }
  return value as MailboxLaunchCohort;
}

/** Hosted admission to Correio. Undefined preserves self-hosted/legacy behavior,
 * and a present but invalid configuration is null and never grants access.
 * Since the public opening, any team with a Stripe customer is admitted once
 * `capturedAt` has passed; whether it may buy or create is decided separately
 * by hasPaidSendingPlanForMailbox. Members only carry explicit grants such as
 * grandfatheredTwentyDollarPlan.
 */
export function mailboxLaunchCohortAllows(
  cohort: MailboxLaunchCohort | null | undefined,
  binding: { teamId: string; customerId: string | null },
  now = new Date(),
): boolean {
  if (cohort === undefined) return true;
  if (!cohort || !binding.customerId || !Number.isFinite(now.getTime())) return false;
  const captured = new Date(cohort.capturedAt).getTime();
  return Number.isFinite(captured) && captured <= now.getTime();
}
