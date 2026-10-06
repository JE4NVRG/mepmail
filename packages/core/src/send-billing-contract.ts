import type { schema } from "@millionsend/db";

export type SendBillingContract = NonNullable<typeof schema.teams.$inferSelect.sendBillingContract>;

export interface SendContractBinding {
  teamId: string;
  customerId: string | null;
  subscriptionId: string | null;
  financialPeriodStart?: Date | null;
  financialPeriodEnd?: Date | null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isoTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) && date.toISOString() === value ? timestamp : null;
}

function periodMatches(expected: Date | null | undefined, actual: number): boolean {
  return (
    expected === undefined ||
    (expected instanceof Date &&
      Number.isFinite(expected.getTime()) &&
      expected.getTime() === actual)
  );
}

/** Validate a persisted Stripe-derived contract before granting commercial capabilities. */
export function verifiedSendBillingContract(
  value: unknown,
  binding: SendContractBinding,
  now?: Date,
): SendBillingContract | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const contract = value as Record<string, unknown>;
  if (
    contract.version !== 1 ||
    !binding.teamId ||
    !binding.customerId ||
    !binding.subscriptionId ||
    contract.teamId !== binding.teamId ||
    contract.customerId !== binding.customerId ||
    contract.subscriptionId !== binding.subscriptionId ||
    typeof contract.baseItemId !== "string" ||
    !/^si_[A-Za-z0-9_]+$/.test(contract.baseItemId) ||
    typeof contract.basePriceId !== "string" ||
    !/^price_[A-Za-z0-9_]+$/.test(contract.basePriceId) ||
    contract.currency !== "usd" ||
    contract.intervalCount !== 1 ||
    !positiveInteger(contract.baseAmountCents) ||
    !positiveInteger(contract.regularMonthlyCents) ||
    !positiveInteger(contract.included) ||
    (contract.usageInterval !== "day" && contract.usageInterval !== "month")
  )
    return null;

  if (contract.billingInterval === "month") {
    if (contract.regularMonthlyCents !== contract.baseAmountCents) return null;
  } else if (contract.billingInterval === "year") {
    // The approved annual Send offer has monthly capped usage and no metered item.
    if (
      contract.baseAmountCents !== 29_000 ||
      contract.regularMonthlyCents !== 2_900 ||
      contract.included !== 110_000 ||
      contract.usageInterval !== "month"
    )
      return null;
  } else return null;

  const start = isoTimestamp(contract.financialPeriodStart);
  const end = isoTimestamp(contract.financialPeriodEnd);
  const anchor = isoTimestamp(contract.usageAnchor);
  if (
    start === null ||
    end === null ||
    start >= end ||
    anchor !== start ||
    isoTimestamp(contract.verifiedAt) === null ||
    !periodMatches(binding.financialPeriodStart, start) ||
    !periodMatches(binding.financialPeriodEnd, end)
  )
    return null;
  if (now !== undefined) {
    const at = now instanceof Date ? now.getTime() : Number.NaN;
    if (!Number.isFinite(at) || at < start || at >= end) return null;
  }
  return contract as unknown as SendBillingContract;
}
