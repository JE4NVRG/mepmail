import { publicSignupCopy } from "@/lib/public-signup-copy";
import { newSubscriptionsPaused } from "./new-subscriptions";
import { publicSignupAvailability } from "./public-signup";

/** Presentation only; auth and billing retain their authoritative admission guards. */
export async function publicMarketingAdmission(locale: string) {
  const purchasesPaused = newSubscriptionsPaused();
  // A failed signup hint must not open a CTA or take down the already-paused catalog.
  const signup = purchasesPaused
    ? await publicSignupAvailability().catch(() => null)
    : await publicSignupAvailability();
  const copy = publicSignupCopy(locale);
  const closed = purchasesPaused || signup !== "open";
  if (purchasesPaused && signup === "open") {
    return {
      closed,
      freeLabel: copy.freeCta,
      copy: { ...copy, admissionTitle: copy.freeOnlyTitle, admissionBody: copy.freeOnlyBody },
    };
  }
  if (purchasesPaused && signup === null) {
    return {
      closed,
      freeLabel: null,
      copy: {
        ...copy,
        admissionTitle: copy.purchasesPausedTitle,
        admissionBody: copy.purchasesPausedBody,
      },
    };
  }
  if (!purchasesPaused && signup && signup !== "open") {
    return {
      closed,
      freeLabel: null,
      copy: { ...copy, admissionTitle: copy[signup], admissionBody: copy[`${signup}Body`] },
    };
  }
  return { closed, freeLabel: null, copy };
}
