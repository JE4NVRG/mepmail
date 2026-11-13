import { publicSignupCopy } from "@/lib/public-signup-copy";
import { newSubscriptionsPaused } from "./new-subscriptions";
import { publicSignupAvailability } from "./public-signup";

/** Presentation only; auth and billing retain their authoritative admission guards. */
export async function publicMarketingAdmission(locale: string) {
  const closed = newSubscriptionsPaused() || (await publicSignupAvailability()) !== "open";
  return { closed, copy: publicSignupCopy(locale) };
}
