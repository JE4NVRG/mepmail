import { verifiedSendBillingContract } from "./send-contract.js";

/** Correio requires a verified Envio contract above US$20 per regular month.
 * Discounts and plan labels cannot establish the contracted recurring amount.
 * Existing mailbox contracts and private content are deliberately not revoked here.
 */
export function hasPaidSendingPlan(
  team: {
    id: string;
    plan: string;
    planStatus?: string;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    currentPeriodStart?: Date | null;
    currentPeriodEnd?: Date | null;
    cancelAt?: Date | null;
    sendBillingContract?: unknown;
  },
  now = new Date(),
) {
  const time = now.getTime();
  const active =
    ["starter", "pro", "scale"].includes(team.plan) &&
    team.planStatus === "active" &&
    /^cus_[A-Za-z0-9_]+$/.test(team.stripeCustomerId ?? "") &&
    /^sub_[A-Za-z0-9_]+$/.test(team.stripeSubscriptionId ?? "") &&
    !!team.currentPeriodStart &&
    team.currentPeriodStart.getTime() <= time &&
    !!team.currentPeriodEnd &&
    team.currentPeriodEnd.getTime() > time &&
    (!team.cancelAt || team.cancelAt.getTime() > time);
  if (!active) return false;
  const contract = verifiedSendBillingContract(
    team.sendBillingContract,
    {
      teamId: team.id,
      customerId: team.stripeCustomerId ?? null,
      subscriptionId: team.stripeSubscriptionId ?? null,
      financialPeriodStart: team.currentPeriodStart ?? null,
      financialPeriodEnd: team.currentPeriodEnd ?? null,
    },
    now,
  );
  return !!contract && contract.regularMonthlyCents > 2000;
}
