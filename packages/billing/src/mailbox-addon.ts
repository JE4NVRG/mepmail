/** Envio is the hosted Correio add-on's purchase prerequisite. Read the verified
 * billing projection, not the plan label alone (past_due can retain that label).
 * Existing mailbox contracts and private content are deliberately not revoked here.
 */
export function hasPaidSendingPlan(
  team: {
    plan: string;
    planStatus?: string;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    currentPeriodStart?: Date | null;
    currentPeriodEnd?: Date | null;
    cancelAt?: Date | null;
  },
  now = new Date(),
) {
  const time = now.getTime();
  return (
    ["starter", "pro", "scale"].includes(team.plan) &&
    team.planStatus === "active" &&
    /^cus_[A-Za-z0-9_]+$/.test(team.stripeCustomerId ?? "") &&
    /^sub_[A-Za-z0-9_]+$/.test(team.stripeSubscriptionId ?? "") &&
    !!team.currentPeriodStart &&
    team.currentPeriodStart.getTime() <= time &&
    !!team.currentPeriodEnd &&
    team.currentPeriodEnd.getTime() > time &&
    (!team.cancelAt || team.cancelAt.getTime() > time)
  );
}
