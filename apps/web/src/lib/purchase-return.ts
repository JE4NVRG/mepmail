/** Purchase intent only: returning never opens a payment or bypasses eligibility. */
export function purchaseReturnPath(value?: string | null): string | null {
  if (
    !value ||
    value.length > 1000 ||
    Array.from(value).some((char) => char.charCodeAt(0) <= 32 || char === "\\") ||
    !value.startsWith("/") ||
    value.startsWith("//")
  )
    return null;
  const url = new URL(value, "https://purchase.invalid");
  if (url.origin !== "https://purchase.invalid" || url.hash) return null;
  const params = new URLSearchParams();
  if (url.pathname === "/mail") {
    params.set("setup", "correio");
    const plan = url.searchParams.get("plan");
    if (plan && ["solo", "duo", "equipe"].includes(plan)) params.set("plan", plan);
  } else if (url.pathname === "/settings/billing") {
    const plan = url.searchParams.get("plan");
    if (plan && /^[a-z0-9_]{1,64}$/.test(plan)) params.set("plan", plan);
    const interval = url.searchParams.get("interval");
    if (interval === "month" || interval === "year") params.set("interval", interval);
    if (url.searchParams.get("correio") === "1") params.set("correio", "1");
  } else return null;
  const query = params.toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

/** Carry the same validated return through list → create → DNS detail. */
export function withPurchaseReturn(path: string, returnTo?: string | null): string {
  const next = purchaseReturnPath(returnTo);
  if (!next) return path;
  const url = new URL(path, "https://purchase.invalid");
  url.searchParams.set("next", next);
  return `${url.pathname}${url.search}`;
}

export function purchaseDomainReviewHref(returnTo?: string): string {
  return withPurchaseReturn("/domains", purchaseReturnPath(returnTo) ?? "/settings/billing");
}

export function billingPurchaseReturn({
  plan,
  interval = "month",
  correio = false,
}: {
  plan?: string | null;
  interval?: "month" | "year";
  correio?: boolean;
} = {}): string {
  const params = new URLSearchParams({ interval });
  if (plan) params.set("plan", plan);
  if (correio) params.set("correio", "1");
  return purchaseReturnPath(`/settings/billing?${params}`) ?? "/settings/billing";
}

export function mailboxPurchaseReturn(plan?: string | null): string {
  return (
    purchaseReturnPath(`/mail?setup=correio${plan ? `&plan=${encodeURIComponent(plan)}` : ""}`) ??
    "/mail?setup=correio"
  );
}
