export type MailboxSetupPlan = {
  active: boolean;
  seats: number;
  reservedSeats: number;
  licenseKind?: "system" | "subscription" | "none";
  unlimitedSeats?: boolean;
};

export type MailboxSetupReceiving = {
  /** "paused": the domain is verified but the team's receiving is paused by its plan's quota. */
  state: "unknown" | "needs_mx" | "needs_activation" | "ready" | "paused";
  mxHost: string | null;
};

export type MailboxPurchaseOffer = {
  offerId: string;
  currency: string;
  unitAmount: number;
  interval: "month" | "year";
  storageBytesPerMailbox: number;
  includedOutboundPerMailbox: number;
  // Bundles (lib/mailbox-plan-terms): one price for several mailboxes.
  quotaScope?: "mailbox" | "team";
  includedMailboxes?: number;
  extraUnitAmount?: number | null;
  localCurrency?: { currency: string; unitAmount: number; extraUnitAmount: number | null } | null;
  trialDays?: number;
  /** A Correio plan (Solo, Duo, Equipe; lib/mailbox-plans), or null for older offers. */
  plan?: {
    code: string;
    inboundDeliveriesPerPeriod: number;
    inboundBytesPerPeriod: number;
    outboundBytesPerPeriod: number;
  } | null;
};
type LegacyOffer = Omit<MailboxPurchaseOffer, "offerId">;
type OfferCatalog = {
  offer: LegacyOffer | null;
  offers?: MailboxPurchaseOffer[];
  defaultOfferId?: string | null;
  pendingOfferId?: string | null;
  pendingOffer?: MailboxPurchaseOffer | null;
};

/** Remember IDs only. Pending checkout terms must come from the current server DTO. */
export function mailboxOfferSelection(
  catalog: OfferCatalog | undefined,
  selectedId: string | null = null,
  attemptedId: string | null = null,
) {
  const offers = catalog?.offers ?? [];
  if (catalog?.pendingOfferId) {
    const offer =
      catalog.pendingOffer?.offerId === catalog.pendingOfferId ? catalog.pendingOffer : null;
    return { offers, offer, offerId: catalog.pendingOfferId, locked: true };
  }
  if (attemptedId) {
    const offer = offers.find((entry) => entry.offerId === attemptedId) ?? null;
    return { offers, offer, offerId: attemptedId, locked: true };
  }
  const offer =
    offers.find((entry) => entry.offerId === selectedId) ??
    offers.find((entry) => entry.offerId === catalog?.defaultOfferId) ??
    offers[0];
  return {
    offers,
    offer: offer ?? catalog?.offer ?? null,
    offerId: offer?.offerId ?? null,
    locked: false,
  };
}

export function formatMailboxPrice(amount: number, currency: string, locale: string): string {
  const format = new Intl.NumberFormat(locale, { style: "currency", currency });
  // Stripe represents ISK charges in hundredths despite its zero-decimal display.
  const decimals =
    currency.toLowerCase() === "isk" ? 2 : format.resolvedOptions().maximumFractionDigits;
  return format.format(amount / 10 ** (decimals ?? 2));
}

/** Sending verification and a transport toggle cannot prove domain receiving. */
export function mailboxSetupReceiving(
  receiving: MailboxSetupReceiving | undefined,
): MailboxSetupReceiving {
  if (
    !receiving ||
    !["unknown", "needs_mx", "needs_activation", "ready", "paused"].includes(receiving.state)
  )
    return { state: "unknown", mxHost: null };
  return { state: receiving.state, mxHost: receiving.mxHost ?? null };
}

export function formatMailboxStorage(bytes: number, locale: string): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index =
    bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(bytes / 1024 ** index)} ${units[index]}`;
}

/** Only the service DTO can confirm unlimited internal admission. */
export function mailboxHasUnlimitedSeats(plan: MailboxSetupPlan | undefined): boolean {
  return plan?.active === true && plan.licenseKind === "system" && plan.unlimitedSeats === true;
}

/** Presentation only. The registry transaction remains the authority for reserving a seat. */
export function mailboxSetupSeatState(
  plan: MailboxSetupPlan | undefined,
  loading: boolean,
  failed: boolean,
): "loading" | "error" | "inactive" | "full" | "ready" {
  if (failed) return "error";
  if (loading || !plan) return "loading";
  if (!plan.active) return "inactive";
  if (mailboxHasUnlimitedSeats(plan)) return "ready";
  if (plan.seats < 1) return "inactive";
  return plan.reservedSeats >= plan.seats ? "full" : "ready";
}

/** Keep the address preview within the local-part contract accepted by the registry. */
export function mailboxSetupLocalPart(value: string): string | null {
  const local = value.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(local) && !local.includes("..")
    ? local
    : null;
}

export function mailboxSetupFailure(
  cause: unknown,
): "conflict" | "quota" | "notEntitled" | "invalid" | "error" {
  const error = cause as { message?: string; data?: { code?: string } } | null;
  if (error?.data?.code === "CONFLICT") return "conflict";
  if (error?.data?.code === "PRECONDITION_FAILED") {
    if (error.message === "quota") return "quota";
    if (error.message === "not_entitled") return "notEntitled";
  }
  return error?.data?.code === "BAD_REQUEST" ? "invalid" : "error";
}
