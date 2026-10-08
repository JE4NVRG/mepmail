/** Mail Checkout helpers shared by the Correio panel and the Send + Mail combo step. */

/** Hosted Checkout only; a provider response is never allowed to redirect to an arbitrary origin. */
export function safeMailboxCheckoutUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "checkout.stripe.com" &&
      !url.username &&
      !url.password &&
      !url.port
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function mailboxCheckoutFailure(cause: unknown) {
  const error = cause as { message?: string; data?: { code?: string } } | null;
  if (error?.message === "sending_plan_required") return "sending_plan_required";
  if (error?.message === "expired") return "error";
  if (error?.message === "subscription_exists") return "existing";
  if (error?.message === "subscriptions_paused") return "unavailable";
  if (error?.message === "mailbox_billing_unavailable" || error?.data?.code === "FORBIDDEN")
    return "unavailable";
  return "pending";
}
