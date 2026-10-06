import {
  type MailboxLaunchCohort,
  mailboxLaunchCohortAllows,
} from "../../core/src/mailbox-launch-cohort.js";
import { verifiedSendBillingContract } from "./send-contract.js";

interface SendingTeam {
  id: string;
  plan: string;
  planStatus?: string;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  cancelAt?: Date | null;
  sendBillingContract?: unknown;
}

/** Correio requires a verified Envio contract above US$20 per regular month.
 * Discounts and plan labels cannot establish the contracted recurring amount.
 * Existing mailbox contracts and private content are deliberately not revoked here.
 */
export function hasPaidSendingPlan(team: SendingTeam, now = new Date()) {
  const contract = activeSendingContract(team, now);
  return !!contract && contract.regularMonthlyCents > 2000;
}

function activeSendingContract(team: SendingTeam, now: Date) {
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
  if (!active) return null;
  return verifiedSendBillingContract(
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
}

/** Optional explicit grandfathering preserves only the captured US$20 monthly
 * contract. It neither changes Envio's signed price nor enrolls later customers.
 * New >US$20 contracts still require the separate opening-cohort admission gate.
 */
export function hasPaidSendingPlanForMailbox(
  team: SendingTeam,
  cohort: MailboxLaunchCohort | null | undefined,
  now = new Date(),
) {
  const contract = activeSendingContract(team, now);
  if (!contract) return false;
  if (contract.regularMonthlyCents > 2000) return true;
  return (
    contract.billingInterval === "month" &&
    contract.baseAmountCents === 2000 &&
    contract.regularMonthlyCents === 2000 &&
    mailboxLaunchCohortAllows(
      cohort,
      { teamId: team.id, customerId: team.stripeCustomerId ?? null },
      now,
    ) &&
    !!cohort?.members.some(
      (member) =>
        member.teamId === team.id &&
        member.customerId === team.stripeCustomerId &&
        member.subscriptionId === team.stripeSubscriptionId &&
        member.grandfatheredTwentyDollarPlan === true,
    )
  );
}
