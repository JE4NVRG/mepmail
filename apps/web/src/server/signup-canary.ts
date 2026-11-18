import "server-only";
import { env, isCloudDeployment, signupOpen } from "@millionsend/config";
import {
  CANARY_SIGNUP_COOKIE,
  type CanarySignupAdmission,
  type CanarySignupPrerequisites,
  type CanarySignupSetting,
  canarySignupAdmission,
  canarySignupCookieValid,
  canarySignupSetting,
  readCookieValue,
} from "@millionsend/config/canary-signup";
import { cookies } from "next/headers";
import { canaryTokenMatches } from "./canary-signup-token";
import { signupBotProtectionEnabled } from "./signup-bot-protection";
import { emailVerificationEnabled } from "./system-mail";

/**
 * Request-side plumbing for the canary sign-up door. The policy itself lives
 * in `@millionsend/config/canary-signup`; this module only says where the
 * fields, the prerequisites and the cookie come from — the process
 * environment, the same config helpers `createAuth` reads, and the request the
 * caller already has — so `./auth` can ask one question.
 *
 * The endpoint context and the /signup render read the SAME setting, and the
 * admission is re-derived per request: no proof is stored, shared or replayed.
 */
const CONFIG_EPOCH = Date.now();

/**
 * The deployment shape the canary door assumes, re-read on every request from
 * the authorities that actually govern the auth config:
 *  - cloud, because the door was written for the hosted instance;
 *  - public sign-up closed, because that is the door it sits beside;
 *  - the Turnstile challenge enforced AND configured, because a challenge that
 *    cannot run is not a challenge;
 *  - e-mail verification required, because that is what keeps an unverified
 *    address from becoming a usable account.
 * If any of them drifts, `canarySignupSetting` answers `blocked` and the door
 * closes — auth, SMTP and the worker keep running untouched.
 */
export function canarySignupPrerequisites(): CanarySignupPrerequisites {
  return {
    cloud: isCloudDeployment(),
    signupClosed: !signupOpen(),
    captchaEnforced:
      signupBotProtectionEnabled() &&
      Boolean(env.TURNSTILE_SITE_KEY?.trim()) &&
      Boolean(env.TURNSTILE_SECRET_KEY?.trim()),
    emailVerification: emailVerificationEnabled(),
  };
}

export function canarySignupSettingNow(now: number = Date.now()): CanarySignupSetting {
  return canarySignupSetting(
    {
      enabled: env.MEPMAIL_CANARY_SIGNUP,
      email: env.MEPMAIL_CANARY_SIGNUP_EMAIL,
      tokenDigest: env.MEPMAIL_CANARY_SIGNUP_TOKEN_SHA256,
      expiresAt: env.MEPMAIL_CANARY_SIGNUP_EXPIRES_AT,
    },
    canarySignupPrerequisites(),
    now,
    CONFIG_EPOCH,
  );
}

/** The endpoint context fields the admission reads; anything else is ignored. */
export interface CanaryRequestContext {
  readonly path?: unknown;
  readonly headers?: unknown;
}

/**
 * The canary answer for a request that is about to create `email`. Used by
 * both the `/sign-up/email` before hook and the `user.create` database hook,
 * so the closed-door policy and the row's own address are checked against the
 * same proof in the same request.
 */
export function canarySignupAdmissionFor(
  ctx: CanaryRequestContext | null | undefined,
  email: unknown,
): CanarySignupAdmission {
  const setting = canarySignupSettingNow();
  if (setting.status !== "active") return { admitted: false };
  const headers = ctx?.headers;
  const cookie =
    headers instanceof Headers
      ? readCookieValue(headers.get("cookie"), CANARY_SIGNUP_COOKIE)
      : null;
  return canarySignupAdmission(
    { path: typeof ctx?.path === "string" ? ctx.path : "", email, cookie },
    setting,
    canaryTokenMatches,
  );
}

/**
 * Whether /signup may render the password form while the public door is
 * paused. Request-scoped and never cached: the cookie decides, so the page
 * cannot be shared with a visitor who does not carry it.
 */
export async function canarySignupRenderAllowed(): Promise<boolean> {
  const setting = canarySignupSettingNow();
  if (setting.status !== "active") return false;
  const jar = await cookies();
  return canarySignupCookieValid(
    jar.get(CANARY_SIGNUP_COOKIE)?.value ?? null,
    setting,
    canaryTokenMatches,
  );
}
