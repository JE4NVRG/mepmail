import {
  ADVERTISING_CONSENT_COOKIE,
  advertisingCookie,
  decodeConsentProof,
  readGoogleConversionConfig,
  readMetaConversionConfig,
  recordSignupConversions,
} from "@millionsend/billing";
import { env } from "@millionsend/config";
import type { Db } from "@millionsend/db";

/**
 * Queues a finished sign-up for Meta (CompleteRegistration) and GA4 (sign_up)
 * from the request that created the account, when that browser accepted
 * advertising measurement. Best-effort: a measurement never fails the sign-up.
 * The worker sends the events and re-checks the consent before each one.
 */
export async function recordSignupAdvertising(
  db: Db,
  userId: string,
  requestHeaders: Headers | undefined,
): Promise<void> {
  try {
    const cookieHeader = requestHeaders?.get("cookie") ?? null;
    const proof = decodeConsentProof(
      advertisingCookie(cookieHeader, ADVERTISING_CONSENT_COOKIE),
      env.BETTER_AUTH_SECRET ?? "",
    );
    if (!proof) return;
    await recordSignupConversions(db, userId, {
      meta: readMetaConversionConfig(process.env),
      google: readGoogleConversionConfig(process.env),
      proof,
      cookieHeader,
    });
  } catch (error) {
    console.error("sign-up advertising capture failed", error);
  }
}
