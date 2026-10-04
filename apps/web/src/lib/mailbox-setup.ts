export type MailboxSetupPlan = {
  active: boolean;
  seats: number;
  reservedSeats: number;
  licenseKind?: "system" | "subscription" | "none";
  unlimitedSeats?: boolean;
};

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
