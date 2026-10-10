/**
 * The Correio plans (Solo, Duo, Equipe): fixed mailboxes and team-wide
 * allowances per monthly period, sold as offers carrying `plan`. Older
 * contracts (per-mailbox or the 3-mailbox bundle with extras) have no plan
 * and keep their own screens. The server decides limits, prices, the
 * upgrade target and the change direction; these helpers only order and
 * present what it sends.
 */

export const MAILBOX_PLAN_ORDER = ["solo", "duo", "equipe"] as const;
export type MailboxPlanCode = (typeof MAILBOX_PLAN_ORDER)[number];

/** Product names, the same in every language. */
export const MAILBOX_PLAN_NAMES: Record<MailboxPlanCode, string> = {
  solo: "Solo",
  duo: "Duo",
  equipe: "Equipe",
};

export type MailboxPlanAllowance = {
  code: string;
  inboundDeliveriesPerPeriod: number;
  inboundBytesPerPeriod: number;
  outboundBytesPerPeriod: number;
};

type WithPlan = { plan?: MailboxPlanAllowance | null };

export function isMailboxPlanCode(code: unknown): code is MailboxPlanCode {
  return typeof code === "string" && (MAILBOX_PLAN_ORDER as readonly string[]).includes(code);
}

/** The offers that are plans, smallest first (unknown codes are left out). */
export function mailboxPlanOffers<O extends WithPlan>(
  offers: readonly O[],
): (O & { plan: MailboxPlanAllowance & { code: MailboxPlanCode } })[] {
  return offers
    .filter((offer): offer is O & { plan: MailboxPlanAllowance & { code: MailboxPlanCode } } =>
      isMailboxPlanCode(offer.plan?.code),
    )
    .sort(
      (a, b) => MAILBOX_PLAN_ORDER.indexOf(a.plan.code) - MAILBOX_PLAN_ORDER.indexOf(b.plan.code),
    );
}

/** The plan offer a new purchase starts on: the catalog's default if it is a plan, else Duo. */
export function defaultMailboxPlanOffer<O extends WithPlan & { offerId: string }>(
  plans: readonly O[],
  defaultOfferId: string | null | undefined,
): O | null {
  return (
    plans.find((offer) => offer.offerId === defaultOfferId) ??
    plans.find((offer) => offer.plan?.code === "duo") ??
    plans[0] ??
    null
  );
}

/**
 * How a change reads to the person. The server has the last word; this
 * mirrors its rule: more mailboxes or a higher price is an upgrade.
 */
export function mailboxPlanDirection(
  current: { unitAmount: number; includedMailboxes?: number | undefined } | null,
  currentSeats: number,
  target: { unitAmount: number; includedMailboxes?: number | undefined },
): "upgrade" | "downgrade" {
  const targetSeats = target.includedMailboxes ?? 1;
  if (targetSeats > (current?.includedMailboxes ?? currentSeats)) return "upgrade";
  if (current && target.unitAmount > current.unitAmount) return "upgrade";
  return "downgrade";
}

export type MailboxMeterLevel = "ok" | "near" | "full" | "paused";

/** Near from 80 %, full at the limit, paused past `pauseAt` (inbound: limit + 10 %). */
export function mailboxMeterLevel(
  used: number,
  limit: number | null,
  pauseAt: number | null = null,
): MailboxMeterLevel {
  if (!limit || limit <= 0) return "ok";
  if (pauseAt !== null && used >= pauseAt) return "paused";
  if (used >= limit) return "full";
  if (used >= limit * 0.8) return "near";
  return "ok";
}

/** Bytes for people: 1 decimal, binary units (what the limits are sold in). */
export function formatMailboxBytes(value: number, locale: string): string {
  const units = [
    ["GiB", 1024 ** 3],
    ["MiB", 1024 ** 2],
    ["KiB", 1024],
  ] as const;
  const [unit, divisor] = units.find(([, size]) => value >= size) ?? ["B", 1];
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / divisor)} ${unit}`;
}

/** Event any Correio screen dispatches to open the license dialog (optionally on an offer). */
export const MAILBOX_OPEN_LICENSE_EVENT = "mepmail:open-license";

export function openMailboxLicense(offerId?: string | null): void {
  window.dispatchEvent(
    new CustomEvent(MAILBOX_OPEN_LICENSE_EVENT, { detail: { offerId: offerId ?? null } }),
  );
}
