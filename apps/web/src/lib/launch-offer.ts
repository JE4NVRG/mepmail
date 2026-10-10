/** Approved launch presentation, separate from the existing billing catalog. */
export const LAUNCH_OFFER = {
  currency: "USD",
  sending: { monthlyCents: 2900, firstMonthlyCents: 2000, monthlyRecipientDeliveries: 110_000 },
  annualChargedMonths: 10,
  annualServiceMonths: 12,
  previewMailboxQuantity: { min: 1, max: 50 },
  mailboxes: [
    { id: "gib1", storageGiB: 1, monthlyCents: 590, monthlyRecipientDeliveries: 500 },
    { id: "gib10", storageGiB: 10, monthlyCents: 990, monthlyRecipientDeliveries: 2000 },
  ],
  /**
   * Correio plans (Jean, 2026-10-10), sold to every team with or without Envio: a fixed
   * number of mailboxes and team-wide monthly allowances (storage, outbound recipients,
   * inbound messages), the same plan in reais in Brazil, a 7-day free trial with the
   * card on a first purchase and no automatic overage. Display only: the billing
   * catalog sells them.
   */
  correioPlans: [
    {
      id: "solo",
      mailboxes: 1,
      storageGiB: 1,
      monthlyCents: 290,
      brlMonthlyCents: 1490,
      monthlyRecipientDeliveries: 500,
      monthlyInboundMessages: 2000,
    },
    {
      id: "duo",
      mailboxes: 3,
      storageGiB: 3,
      monthlyCents: 590,
      brlMonthlyCents: 2990,
      monthlyRecipientDeliveries: 2000,
      monthlyInboundMessages: 5000,
    },
    {
      id: "equipe",
      mailboxes: 10,
      storageGiB: 10,
      monthlyCents: 1290,
      brlMonthlyCents: 6490,
      monthlyRecipientDeliveries: 6000,
      monthlyInboundMessages: 10000,
    },
  ],
  correioTrialDays: 7,
  /** Domains a team with an active Correio subscription may verify on the free Envio plan. */
  correioDomains: 3,
  internal: { storageGiBPerMailbox: 50 },
} as const;

export type LaunchBillingPeriod = "month" | "year";
export type LaunchMailboxTierId = (typeof LAUNCH_OFFER.mailboxes)[number]["id"];
export type LaunchMailboxPlan = (typeof LAUNCH_OFFER.mailboxes)[number];
export type CorreioPlan = (typeof LAUNCH_OFFER.correioPlans)[number];
/** The smallest Correio plan price, for "from" claims. */
export const CORREIO_FROM_CENTS = Math.min(
  ...LAUNCH_OFFER.correioPlans.map((plan) => plan.monthlyCents),
);

export function parseLaunchMailboxQuantity(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) &&
    quantity >= LAUNCH_OFFER.previewMailboxQuantity.min &&
    quantity <= LAUNCH_OFFER.previewMailboxQuantity.max
    ? quantity
    : null;
}

export function getLaunchMailboxPlan(id: LaunchMailboxTierId): LaunchMailboxPlan {
  const mailbox = LAUNCH_OFFER.mailboxes.find((plan) => plan.id === id);
  if (!mailbox) throw new RangeError("Unknown launch mailbox plan");
  return mailbox;
}

/** Arithmetic only: this quote cannot create checkout or change an entitlement. */
export function calculateLaunchQuote({
  period,
  mailboxTierId = null,
  mailboxQuantity = 1,
  isNewCustomer,
}: {
  period: LaunchBillingPeriod;
  mailboxTierId?: LaunchMailboxTierId | null;
  mailboxQuantity?: number;
  isNewCustomer: boolean;
}) {
  if (period !== "month" && period !== "year")
    throw new RangeError("Unknown launch billing period");
  if (
    !Number.isSafeInteger(mailboxQuantity) ||
    mailboxQuantity < LAUNCH_OFFER.previewMailboxQuantity.min ||
    mailboxQuantity > LAUNCH_OFFER.previewMailboxQuantity.max
  ) {
    throw new RangeError("Launch preview quantity must be an integer from 1 to 50");
  }
  if (typeof isNewCustomer !== "boolean")
    throw new TypeError("A quote must identify whether it models a new customer");
  const mailbox = mailboxTierId === null ? null : getLaunchMailboxPlan(mailboxTierId);
  const factor = period === "year" ? LAUNCH_OFFER.annualChargedMonths : 1;
  const sendingPeriodCents = LAUNCH_OFFER.sending.monthlyCents * factor;
  const mailboxUnitPeriodCents = (mailbox?.monthlyCents ?? 0) * factor;
  const mailboxTotalPeriodCents = mailboxUnitPeriodCents * (mailbox ? mailboxQuantity : 0);
  const recurringPeriodCents = sendingPeriodCents + mailboxTotalPeriodCents;
  const introductoryOfferApplied = period === "month" && isNewCustomer;
  const introductorySavingCents = introductoryOfferApplied
    ? LAUNCH_OFFER.sending.monthlyCents - LAUNCH_OFFER.sending.firstMonthlyCents
    : 0;
  const firstPaymentCents = recurringPeriodCents - introductorySavingCents;
  const regularMonthlyCents =
    LAUNCH_OFFER.sending.monthlyCents +
    (mailbox?.monthlyCents ?? 0) * (mailbox ? mailboxQuantity : 0);
  return {
    period,
    mailbox,
    mailboxQuantity: mailbox ? mailboxQuantity : 0,
    sendingPeriodCents,
    mailboxUnitPeriodCents,
    mailboxTotalPeriodCents,
    recurringPeriodCents,
    firstPaymentCents,
    introductoryOfferApplied,
    introductorySavingCents,
    regularMonthlyCents,
    annualEquivalentMonthlyCents:
      period === "year"
        ? Math.round(recurringPeriodCents / LAUNCH_OFFER.annualServiceMonths)
        : null,
    annualSavingAgainstRegularMonthlyCents:
      period === "year"
        ? regularMonthlyCents * LAUNCH_OFFER.annualServiceMonths - recurringPeriodCents
        : 0,
  };
}

/** Presentation of server-validated context. This is never an authorization gate. */
export function describeLaunchPlan(
  context:
    | { kind: "system" }
    | { kind: "launch" }
    | { kind: "legacy"; recurringMonthlyCents: number },
) {
  if (context.kind === "system") {
    return {
      planQualifiesForMail: true,
      commercialBillingExempt: true,
      recurringMonthlyCents: 0,
      internalMailbox: {
        storageGiB: LAUNCH_OFFER.internal.storageGiBPerMailbox,
        commercialMailboxCountLimit: null,
        commercialMonthlyRecipientLimit: null,
      },
    };
  }
  const recurringMonthlyCents =
    context.kind === "launch" ? LAUNCH_OFFER.sending.monthlyCents : context.recurringMonthlyCents;
  if (!Number.isSafeInteger(recurringMonthlyCents) || recurringMonthlyCents < 0)
    throw new RangeError("Invalid recurring plan price");
  return {
    planQualifiesForMail: recurringMonthlyCents > 2000,
    commercialBillingExempt: false,
    recurringMonthlyCents,
    internalMailbox: null,
  };
}
