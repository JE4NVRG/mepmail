import {
  calculateLaunchQuote,
  getLaunchMailboxPlan,
  LAUNCH_OFFER,
  type LaunchBillingPeriod,
  type LaunchMailboxTierId,
} from "./launch-offer";

/**
 * Send + Mail "combo": two separate Stripe subscriptions bought in two steps.
 * Step 1 is the Send Checkout; step 2 opens the Mail Checkout with the
 * mailboxes chosen in step 1. The choice is a per-browser convenience only:
 * the server re-validates the offer, the plan and the role on step 2.
 */
export const LAUNCH_COMBO_STORAGE_KEY = "mepmail.launch-combo.v1";
/** A Stripe Checkout Session expires after 24 hours; the choice expires with it. */
export const LAUNCH_COMBO_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const GIB = 1024 ** 3;

export type LaunchComboIntent = {
  v: 1;
  teamId: string;
  tier: LaunchMailboxTierId;
  seats: number;
  interval: LaunchBillingPeriod;
  savedAt: number;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function parseLaunchComboIntent(
  raw: string | null,
  teamId: string,
  now = Date.now(),
): LaunchComboIntent | null {
  if (!raw || !teamId) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const intent = value as Partial<LaunchComboIntent>;
  const quantity = LAUNCH_OFFER.previewMailboxQuantity;
  if (
    intent.v !== 1 ||
    intent.teamId !== teamId ||
    !LAUNCH_OFFER.mailboxes.some((plan) => plan.id === intent.tier) ||
    (intent.interval !== "month" && intent.interval !== "year") ||
    typeof intent.seats !== "number" ||
    !Number.isSafeInteger(intent.seats) ||
    intent.seats < quantity.min ||
    intent.seats > quantity.max ||
    typeof intent.savedAt !== "number" ||
    !Number.isFinite(intent.savedAt) ||
    intent.savedAt > now ||
    now - intent.savedAt > LAUNCH_COMBO_MAX_AGE_MS
  )
    return null;
  return intent as LaunchComboIntent;
}

export function readLaunchComboIntent(
  teamId: string,
  storage: StorageLike | null = browserStorage(),
  now = Date.now(),
): LaunchComboIntent | null {
  try {
    return parseLaunchComboIntent(storage?.getItem(LAUNCH_COMBO_STORAGE_KEY) ?? null, teamId, now);
  } catch {
    return null;
  }
}

export function saveLaunchComboIntent(
  intent: Omit<LaunchComboIntent, "v" | "savedAt">,
  storage: StorageLike | null = browserStorage(),
  now = Date.now(),
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(LAUNCH_COMBO_STORAGE_KEY, JSON.stringify({ v: 1, ...intent, savedAt: now }));
    return true;
  } catch {
    return false;
  }
}

export function clearLaunchComboIntent(storage: StorageLike | null = browserStorage()): void {
  try {
    storage?.removeItem(LAUNCH_COMBO_STORAGE_KEY);
  } catch {
    // Storage may be blocked; the server never relies on this value.
  }
}

/** Only a server-approved offer with exactly the quoted terms is preselected. */
export function matchLaunchComboOffer(
  offers: readonly {
    offerId: string;
    currency: string;
    unitAmount: number;
    interval: string;
    storageBytesPerMailbox: number;
  }[],
  tier: LaunchMailboxTierId,
  interval: LaunchBillingPeriod,
): string | null {
  const plan = getLaunchMailboxPlan(tier);
  const unitAmount =
    plan.monthlyCents * (interval === "year" ? LAUNCH_OFFER.annualChargedMonths : 1);
  return (
    offers.find(
      (offer) =>
        offer.currency.toLowerCase() === LAUNCH_OFFER.currency.toLowerCase() &&
        offer.interval === interval &&
        offer.unitAmount === unitAmount &&
        offer.storageBytesPerMailbox === plan.storageGiB * GIB,
    )?.offerId ?? null
  );
}

/** Arithmetic for the two payments; Stripe Checkout remains the source of the charged amount. */
export function launchComboQuote({
  interval,
  tier,
  seats,
}: {
  interval: LaunchBillingPeriod;
  tier: LaunchMailboxTierId;
  seats: number;
}) {
  const quote = calculateLaunchQuote({
    period: interval,
    mailboxTierId: tier,
    mailboxQuantity: seats,
    isNewCustomer: true,
  });
  return {
    sendFirstCents: quote.sendingPeriodCents - quote.introductorySavingCents,
    sendPeriodCents: quote.sendingPeriodCents,
    mailUnitPeriodCents: quote.mailboxUnitPeriodCents,
    mailPeriodCents: quote.mailboxTotalPeriodCents,
    recurringPeriodCents: quote.recurringPeriodCents,
  };
}
