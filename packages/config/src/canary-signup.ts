/**
 * Canary sign-up admission: ONE operator address may register with a password
 * while the public door stays closed.
 *
 * This is deliberately not an invite system and it never widens admission:
 *  - it exists only when MEPMAIL_CANARY_SIGNUP is on AND the address, the
 *    token DIGEST and a short expiry are all valid together;
 *  - it exists only while the deployment still matches the shape it was
 *    written for: cloud, public sign-up closed, the Turnstile challenge
 *    enforced with both keys, and e-mail verification required. Those four
 *    conditions are re-read on every request (CanarySignupPrerequisites), so
 *    a future env drift closes the canary instead of inheriting a door the
 *    policy no longer describes;
 *  - it admits exactly one normalized address, on `/sign-up/email` only, and
 *    only with the token the operator injected into their own browser;
 *  - the beta seat cap, the Turnstile challenge (hostname + action) and email
 *    verification keep applying to that same request.
 *
 * The token itself is never configured: the environment holds only its
 * SHA-256 digest (MEPMAIL_CANARY_SIGNUP_TOKEN_SHA256), and the digest compare
 * lives in the server-only module `canary-signup-token`, so this package
 * pulls no `node:crypto` into a process that only needs the shape.
 *
 * Pure by design: no Node builtins and no I/O, so the admission matrix is
 * exercised directly and the module stays importable from every runtime.
 * Nothing here throws at import or at boot: a half-configured or no-longer-
 * applicable canary answers "inert" and leaves auth, SMTP and the worker
 * exactly as they were.
 */

/** Host-only, Secure cookie the operator sets by hand. The app never writes it. */
export const CANARY_SIGNUP_COOKIE = "__Host-mepmail_canary_signup";

/** The only endpoint the canary door can open; every other path keeps the closed door. */
export const CANARY_SIGNUP_PATH = "/sign-up/email";

/** 256 bits of entropy, base64url, unpadded: 32 bytes encode to 43 characters. */
export const CANARY_SIGNUP_TOKEN_LENGTH = 43;
/** SHA-256 rendered as lowercase hex. */
export const CANARY_SIGNUP_DIGEST_LENGTH = 64;

/** Hard ceiling for the expiry: the door is short-lived by construction. */
export const CANARY_SIGNUP_MAX_TTL_MS = 72 * 60 * 60 * 1000;

/** The token alphabet, and exactly the length 256 bits produce. */
const TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${CANARY_SIGNUP_TOKEN_LENGTH}}$`);
/** Canonical lowercase hex: `printf %s "$TOKEN" | openssl dgst -sha256`. */
const DIGEST_PATTERN = new RegExp(`^[0-9a-f]{${CANARY_SIGNUP_DIGEST_LENGTH}}$`);
/** One bare address: a list, a display name or a stray separator is not one. */
const EMAIL_PATTERN = /^[^\s@,;:"<>]+@[^\s@,;:"<>]+\.[^\s@,;:"<>]+$/;
/** Absolute UTC instant; a local-time string would silently move the expiry. */
const EXPIRES_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export interface CanarySignupFields {
  readonly enabled?: unknown;
  readonly email?: unknown;
  readonly tokenDigest?: unknown;
  readonly expiresAt?: unknown;
}

/**
 * The deployment shape the canary was written for. Every field is read from
 * the same authority the auth configuration itself uses, on every request:
 *  - `cloud` — `isCloudDeployment()`;
 *  - `signupClosed` — `!signupOpen()` (the public door this door sits beside);
 *  - `captchaEnforced` — `signupBotProtectionEnabled()` with both Turnstile
 *    keys present, i.e. exactly what `assertSignupBotVerification` demands;
 *  - `emailVerification` — `emailVerificationEnabled()`, the same flag that
 *    turns on `requireEmailVerification`.
 */
export interface CanarySignupPrerequisites {
  readonly cloud: boolean;
  readonly signupClosed: boolean;
  readonly captchaEnforced: boolean;
  readonly emailVerification: boolean;
}

/**
 * Fail-closed default: a caller that forgets to state the prerequisites
 * answers "blocked", never "admitted".
 */
export const CANARY_SIGNUP_NO_PREREQUISITES: CanarySignupPrerequisites = {
  cloud: false,
  signupClosed: false,
  captchaEnforced: false,
  emailVerification: false,
};

export interface CanarySignupConfig {
  /** The single admitted address, normalized. */
  readonly email: string;
  /** SHA-256 of the token, lowercase hex. The token itself is never stored here. */
  readonly tokenDigest: string;
  readonly expiresAt: number;
}

export type CanarySignupSetting =
  | { readonly status: "disabled" }
  /** Configured, but the deployment no longer matches what the door assumes. */
  | { readonly status: "blocked"; readonly message: string }
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "active"; readonly config: CanarySignupConfig }
  | { readonly status: "expired"; readonly config: CanarySignupConfig };

export type CanarySignupAdmission =
  | { readonly admitted: true; readonly email: string }
  | { readonly admitted: false };

/**
 * Compares a presented cookie value with the configured digest. Supplied by
 * the caller (the server-only token module), never defaulted: a caller that
 * cannot verify a token cannot admit anybody.
 */
export type CanarySignupCookieVerifier = (presented: string, expectedDigest: string) => boolean;

const DENIED: CanarySignupAdmission = { admitted: false };

/** The flags are read raw: under SKIP_ENV_VALIDATION the string "false" is truthy. */
export function canarySignupSwitchedOn(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

/** Whether a value has the shape of the 256-bit base64url token. Pure. */
export function canarySignupTokenShape(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/** Whether a value has the shape of a SHA-256 digest in canonical hex. Pure. */
export function canarySignupDigestShape(value: unknown): value is string {
  return typeof value === "string" && DIGEST_PATTERN.test(value);
}

/** The exact environment lines still missing, for whoever reads the setting. */
function missingPrerequisites(p: CanarySignupPrerequisites): string[] {
  const missing: string[] = [];
  if (!p.cloud) missing.push("IS_CLOUD=true (the door is cloud-only)");
  if (!p.signupClosed) missing.push("ALLOW_SIGNUP=false (the public door must stay closed)");
  if (!p.captchaEnforced) {
    missing.push("SIGNUP_BOT_PROTECTION=true with TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY");
  }
  if (!p.emailVerification) missing.push("e-mail verification (AUTH_EMAIL_FROM with SES reach)");
  return missing;
}

/**
 * The address as it will be compared: trimmed and lowercased. Better Auth
 * lowercases every address it stores, so this is the same normalization the
 * account row keeps.
 */
export function normalizeCanaryEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Resolve the capability from its raw fields and the deployment's current shape.
 *
 * Order matters and is part of the contract:
 *  1. the switch alone decides `disabled` — so turning it off is a complete
 *     rollback even while the address, digest and expiry are still in the
 *     environment (nothing else has to be removed at the same time);
 *  2. a switched-on canary with missing or malformed fields is `invalid`
 *     (a configuration mistake the caller may surface; never a boot failure);
 *  3. a well-formed canary whose deployment no longer matches the shape it
 *     assumes is `blocked` — inert, and never a boot failure;
 *  4. otherwise it is `expired` or `active`.
 *
 * @param configEpoch when the running configuration was accepted (process
 *   start). The expiry must sit within CANARY_SIGNUP_MAX_TTL_MS of it, so a
 *   long-lived value can never turn into a permanent door: every restart
 *   re-checks the ceiling.
 */
export function canarySignupSetting(
  fields: CanarySignupFields,
  prerequisites: CanarySignupPrerequisites = CANARY_SIGNUP_NO_PREREQUISITES,
  now: number = Date.now(),
  configEpoch: number = now,
): CanarySignupSetting {
  // 1. Off means off. Auxiliary values left behind are not an error: the
  // operator's rollback must not require deleting them simultaneously.
  if (!canarySignupSwitchedOn(fields.enabled)) return { status: "disabled" };

  // 2. A switched-on door must be complete and well-formed.
  const rawEmail = fields.email;
  const rawDigest = fields.tokenDigest;
  const rawExpiresAt = fields.expiresAt;
  if (!hasText(rawEmail) || !hasText(rawDigest) || !hasText(rawExpiresAt)) {
    return {
      status: "invalid",
      message:
        "MEPMAIL_CANARY_SIGNUP requires MEPMAIL_CANARY_SIGNUP_EMAIL, _TOKEN_SHA256 and _EXPIRES_AT together",
    };
  }
  const email = normalizeCanaryEmail(rawEmail);
  if (!EMAIL_PATTERN.test(email)) {
    return { status: "invalid", message: "MEPMAIL_CANARY_SIGNUP_EMAIL must be one bare address" };
  }
  const tokenDigest = rawDigest.trim();
  if (!canarySignupDigestShape(tokenDigest)) {
    return {
      status: "invalid",
      message:
        "MEPMAIL_CANARY_SIGNUP_TOKEN_SHA256 must be 64 lowercase hex characters: the SHA-256 of the token, never the token itself",
    };
  }
  const expiresAtRaw = rawExpiresAt.trim();
  const expiresAt = Date.parse(expiresAtRaw);
  if (!EXPIRES_PATTERN.test(expiresAtRaw) || !Number.isFinite(expiresAt)) {
    return {
      status: "invalid",
      message:
        "MEPMAIL_CANARY_SIGNUP_EXPIRES_AT must be an absolute UTC instant such as 2027-01-01T00:00:00Z",
    };
  }
  if (expiresAt - configEpoch > CANARY_SIGNUP_MAX_TTL_MS) {
    return {
      status: "invalid",
      message: `MEPMAIL_CANARY_SIGNUP_EXPIRES_AT must sit within ${CANARY_SIGNUP_MAX_TTL_MS / 3_600_000}h: the canary is short-lived`,
    };
  }

  // 3. A complete canary on a deployment that no longer matches its premises
  // is inert, not fatal.
  const missing = missingPrerequisites(prerequisites);
  if (missing.length > 0) {
    return {
      status: "blocked",
      message: `MEPMAIL_CANARY_SIGNUP stays closed until ${missing.join("; ")}`,
    };
  }

  const config: CanarySignupConfig = { email, tokenDigest, expiresAt };
  if (now >= expiresAt) return { status: "expired", config };
  return { status: "active", config };
}

/** Value of `name` in a Cookie request header, or null. Undecoded on purpose. */
export function readCookieValue(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== name) continue;
    return part.slice(at + 1).trim();
  }
  return null;
}

/**
 * Whether the presented cookie carries the configured token, according to the
 * caller's verifier (SHA-256 + `timingSafeEqual`, server-only). A missing
 * verifier denies: the policy never assumes a comparison happened.
 */
export function canarySignupCookieValid(
  cookie: string | null | undefined,
  setting: CanarySignupSetting,
  verifyCookie: CanarySignupCookieVerifier | null | undefined,
): boolean {
  if (setting.status !== "active") return false;
  if (typeof cookie !== "string" || cookie === "") return false;
  if (typeof verifyCookie !== "function") return false;
  return verifyCookie(cookie, setting.config.tokenDigest) === true;
}

/**
 * Whether this request is the canary: the sign-up endpoint, the one bound
 * address, the operator's cookie, and a capability that is active right now.
 * Anything else is denied — the caller then applies the ordinary closed door.
 */
export function canarySignupAdmission(
  input: { readonly path: string; readonly email?: unknown; readonly cookie: string | null },
  setting: CanarySignupSetting,
  verifyCookie: CanarySignupCookieVerifier | null | undefined,
): CanarySignupAdmission {
  if (input.path !== CANARY_SIGNUP_PATH) return DENIED;
  if (setting.status !== "active") return DENIED;
  const email = normalizeCanaryEmail(input.email);
  if (email === "" || email !== setting.config.email) return DENIED;
  if (!canarySignupCookieValid(input.cookie, setting, verifyCookie)) return DENIED;
  return { admitted: true, email };
}
