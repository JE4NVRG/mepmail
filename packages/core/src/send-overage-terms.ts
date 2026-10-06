import type { schema } from "@millionsend/db";

export type SendOverageTerms = NonNullable<typeof schema.teams.$inferSelect.billingTerms>;

/** Accept only persisted terms tied to this team's actual Stripe subscription and period. */
export function verifiedSendOverageTerms(
  value: unknown,
  binding: {
    teamId: string;
    customerId: string | null;
    subscriptionId: string | null;
    overageItemId: string | null;
    periodStart: Date;
    periodEnd?: Date | null;
  },
): SendOverageTerms | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const t = value as SendOverageTerms;
  const start = new Date(t.periodStart);
  const end = new Date(t.periodEnd);
  if (
    t.version !== 1 ||
    !binding.customerId ||
    !binding.subscriptionId ||
    !binding.overageItemId ||
    t.teamId !== binding.teamId ||
    t.customerId !== binding.customerId ||
    t.subscriptionId !== binding.subscriptionId ||
    t.overageItemId !== binding.overageItemId ||
    !/^si_[A-Za-z0-9_]+$/.test(t.baseItemId) ||
    !/^si_[A-Za-z0-9_]+$/.test(t.overageItemId) ||
    !/^price_[A-Za-z0-9_]+$/.test(t.basePriceId) ||
    !/^price_[A-Za-z0-9_]+$/.test(t.overagePriceId) ||
    t.currency !== "usd" ||
    t.blockSize !== 1000 ||
    t.rounding !== "up" ||
    !Number.isSafeInteger(t.centsPerBlock) ||
    t.centsPerBlock < 0 ||
    !Number.isSafeInteger(t.included) ||
    t.included <= 0 ||
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start >= end ||
    start.toISOString() !== t.periodStart ||
    end.toISOString() !== t.periodEnd ||
    !Number.isFinite(new Date(t.verifiedAt).getTime()) ||
    binding.periodStart.getTime() !== start.getTime() ||
    (binding.periodEnd !== undefined && binding.periodEnd?.getTime() !== end.getTime())
  )
    return null;
  return t;
}
