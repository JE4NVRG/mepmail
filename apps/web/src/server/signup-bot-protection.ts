import { env, isCloudDeployment } from "@millionsend/config";
import { APIError } from "better-auth/api";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 10_000;
export const SIGNUP_BOT_ACTION = "auth";
export const SIGNUP_BOT_OAUTH_CONTEXT = "mepmailSignupBotVerified";

/** The flag is deliberately opt-in and does not change self-hosted setup. */
export function signupBotProtectionEnabled(): boolean {
  const value: unknown = env.SIGNUP_BOT_PROTECTION;
  return isCloudDeployment() && (value === true || value === "true" || value === "1");
}

function unavailable(): APIError {
  return new APIError("SERVICE_UNAVAILABLE", {
    code: "SIGNUP_BOT_PROTECTION_UNAVAILABLE",
    message: "Account verification is temporarily unavailable. Try again or contact Support.",
  });
}

/** One authority consumes each signup token; callers must not run the captcha plugin too. */
export async function assertSignupBotVerification(
  headers: Headers | undefined,
  baseUrl: string,
): Promise<void> {
  if (!env.TURNSTILE_SITE_KEY?.trim() || !env.TURNSTILE_SECRET_KEY?.trim()) {
    throw unavailable();
  }
  const token = headers?.get("x-captcha-response")?.trim();
  if (!token || token.length > 2048) {
    throw new APIError("FORBIDDEN", {
      code: "SIGNUP_BOT_VERIFICATION_REQUIRED",
      message: "Complete the account verification and try again.",
    });
  }
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    throw unavailable();
  }
  let result: { success?: boolean; hostname?: string; action?: string };
  try {
    const response = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!response.ok) throw unavailable();
    result = (await response.json()) as typeof result;
    if (!result || typeof result !== "object") throw unavailable();
  } catch {
    // Neither provider errors nor tokens are logged: a retry gets a fresh token.
    throw unavailable();
  }
  if (
    result.success !== true ||
    result.hostname !== hostname ||
    result.action !== SIGNUP_BOT_ACTION
  ) {
    throw new APIError("FORBIDDEN", {
      code: "SIGNUP_BOT_VERIFICATION_REQUIRED",
      message: "Complete the account verification and try again.",
    });
  }
}
