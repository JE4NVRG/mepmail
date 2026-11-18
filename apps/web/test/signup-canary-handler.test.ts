// @vitest-environment node

import { createHash, randomBytes } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Auth, createAuth } from "@/server/auth";
import { canarySignupSettingNow } from "@/server/signup-canary";

/**
 * The canary door through the REAL Better Auth HTTP handler, against a real
 * PGlite database with the real drizzle adapter, the real `hooks.before`
 * middleware and the real `databaseHooks.user.create` callback.
 *
 * This is the contract the extracted-source tests cannot prove: that the
 * context Better Auth builds for a `/sign-up/email` request is the one the
 * `user.create` hook receives, so the admission re-derived there sees the same
 * cookie and the same path — and that Turnstile, e-mail verification and the
 * closed-door authority still run on that request.
 *
 * Only the outer boundary is mocked: `fetch` (the Cloudflare siteverify call),
 * because a test must not answer DNS. The assertion under test is the app's.
 */

const BASE_URL = "http://localhost:3000";
const PASSWORD = "correct horse battery";
const CANARY_EMAIL = "qa.canary@mepmail.example";
const OTHER_EMAIL = "someone.else@mepmail.example";
const COOKIE = "__Host-mepmail_canary_signup";

/** 256 bits, base64url: what `openssl rand | base64` produces (unpadded, 43 chars). */
function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

let db: Db;
let close: () => Promise<void>;
let auth: Auth;
let token: string;

/** The deployment shape the canary is written for; individual tests flip fields. */
const BASE_ENV = {
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-1234",
  APP_BASE_URL: BASE_URL,
  IS_CLOUD: "true",
  ALLOW_SIGNUP: "false",
  // Verification on: sender + SES reach (the same pair emailVerificationEnabled reads).
  AUTH_EMAIL_FROM: "MepMail <no-reply@mail.example.com>",
  AWS_ACCESS_KEY_ID: "test-key",
  AWS_SECRET_ACCESS_KEY: "test-secret",
  AWS_DEFAULT_CHAIN: "",
  // The challenge the canary requires to be enforced and configured.
  SIGNUP_BOT_PROTECTION: "true",
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
} as const;

function canaryEnv(digest = sha256Hex(token), expiresAt?: string) {
  return {
    MEPMAIL_CANARY_SIGNUP: "true",
    MEPMAIL_CANARY_SIGNUP_EMAIL: CANARY_EMAIL,
    MEPMAIL_CANARY_SIGNUP_TOKEN_SHA256: digest,
    MEPMAIL_CANARY_SIGNUP_EXPIRES_AT: expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function stubEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
}

/** One POST to the endpoint the sign-up form uses, with the same origin. */
function signUp(email: string, headers: Record<string, string> = {}): Promise<Response> {
  return auth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL, ...headers },
      body: JSON.stringify({ name: "QA Operator", email, password: PASSWORD }),
    }),
  );
}

async function usersWith(email: string): Promise<{ id: string; email: string }[]> {
  return db
    .select({ id: schema.user.id, email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.email, email));
}

/** The Cloudflare siteverify answer a solved challenge produces. */
function mockSiteVerify(
  result: Record<string, unknown> = { success: true, hostname: "localhost", action: "auth" },
) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  token = newToken();
  // The public door is closed once an account exists: seat the instance.
  await db
    .insert(schema.user)
    .values({ id: "seeded", name: "Seeded", email: "seeded@mepmail.example" });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await close();
});

describe("the closed public door keeps refusing through the real handler", () => {
  it("refuses a stranger and creates no row", async () => {
    stubEnv(BASE_ENV);
    auth = createAuth(db, { send: async () => {} });

    const response = await signUp(OTHER_EMAIL);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: "Signup is disabled." });
    expect(await usersWith(OTHER_EMAIL)).toEqual([]);
  });
});

describe("the canary door admits exactly one request shape, end to end", () => {
  it("creates the bound address when the operator cookie carries the token", async () => {
    stubEnv({ ...BASE_ENV, ...canaryEnv() });
    auth = createAuth(db, { send: async () => {} });
    const fetchCalls = mockSiteVerify();

    const response = await signUp(CANARY_EMAIL, {
      cookie: `${COOKIE}=${token}`,
      "x-captcha-response": "turnstile-token",
      "cf-connecting-ip": "203.0.113.7",
    });

    expect(response.status).toBe(200);
    // The row exists, which it cannot if the user.create hook re-derived a
    // refusal: this is the proof that Better Auth transported the request
    // context (headers + path) into the database hook.
    const rows = await usersWith(CANARY_EMAIL);
    expect(rows).toHaveLength(1);
    // Verification is required, so the account exists unverified and no
    // session was minted: the same terms a public sign-up would get.
    const [created] = await db
      .select({ emailVerified: schema.user.emailVerified })
      .from(schema.user)
      .where(eq(schema.user.email, CANARY_EMAIL));
    expect(created?.emailVerified).toBe(false);
    // The challenge ran once, against Cloudflare, with this request's token.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(fetchCalls[0]?.body).toMatchObject({ response: "turnstile-token" });
  });

  it("refuses the same cookie for any other address", async () => {
    stubEnv({ ...BASE_ENV, ...canaryEnv() });
    auth = createAuth(db, { send: async () => {} });
    mockSiteVerify();

    const response = await signUp(OTHER_EMAIL, {
      cookie: `${COOKIE}=${token}`,
      "x-captcha-response": "turnstile-token",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ message: "Signup is disabled." });
    expect(await usersWith(OTHER_EMAIL)).toEqual([]);
  });

  it("refuses the bound address without the cookie", async () => {
    stubEnv({ ...BASE_ENV, ...canaryEnv() });
    auth = createAuth(db, { send: async () => {} });
    mockSiteVerify();

    const response = await signUp(CANARY_EMAIL, { "x-captcha-response": "turnstile-token" });

    expect(response.status).toBe(403);
    expect(await usersWith(CANARY_EMAIL)).toEqual([]);
  });

  it("refuses a wrong, truncated or padded token", async () => {
    stubEnv({ ...BASE_ENV, ...canaryEnv() });
    auth = createAuth(db, { send: async () => {} });
    mockSiteVerify();

    for (const presented of [
      newToken(),
      token.slice(0, -1),
      `${token}A`,
      `${token}=`,
      sha256Hex(token), // the digest is not the bearer
    ]) {
      const response = await signUp(CANARY_EMAIL, {
        cookie: `${COOKIE}=${presented}`,
        "x-captcha-response": "turnstile-token",
      });
      expect(response.status, presented).toBe(403);
    }
    expect(await usersWith(CANARY_EMAIL)).toEqual([]);
  });
});

describe("Turnstile stays a gate for the canary account", () => {
  it("refuses an admitted canary request with no challenge token", async () => {
    stubEnv({ ...BASE_ENV, ...canaryEnv() });
    auth = createAuth(db, { send: async () => {} });
    const fetchCalls = mockSiteVerify();

    const response = await signUp(CANARY_EMAIL, { cookie: `${COOKIE}=${token}` });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "SIGNUP_BOT_VERIFICATION_REQUIRED",
    });
    expect(await usersWith(CANARY_EMAIL)).toEqual([]);
    // It never reached Cloudflare: a missing token is refused locally.
    expect(fetchCalls).toEqual([]);
  });

  it("refuses when Cloudflare answers for another hostname or action", async () => {
    stubEnv({ ...BASE_ENV, ...canaryEnv() });
    auth = createAuth(db, { send: async () => {} });

    for (const result of [
      { success: true, hostname: "app.example.com", action: "auth" },
      { success: true, hostname: "localhost", action: "login" },
      { success: false, hostname: "localhost", action: "auth" },
    ]) {
      mockSiteVerify(result);
      const response = await signUp(CANARY_EMAIL, {
        cookie: `${COOKIE}=${token}`,
        "x-captcha-response": "turnstile-token",
      });
      expect(response.status, JSON.stringify(result)).toBe(403);
      vi.unstubAllGlobals();
    }
    expect(await usersWith(CANARY_EMAIL)).toEqual([]);
  });
});

describe("the canary refuses itself when its premises drift", () => {
  const drifted: Array<[string, Record<string, string>]> = [
    ["a self-host deployment", { IS_CLOUD: "false", SIGNUP_BOT_PROTECTION: "false" }],
    ["Turnstile not enforced", { SIGNUP_BOT_PROTECTION: "false" }],
    ["Turnstile keys missing", { TURNSTILE_SITE_KEY: "", TURNSTILE_SECRET_KEY: "" }],
    ["e-mail verification off", { AUTH_EMAIL_FROM: "" }],
  ];
  for (const [name, env] of drifted) {
    it(`stays closed on ${name}, even with the exact cookie and address`, async () => {
      stubEnv({ ...BASE_ENV, ...canaryEnv(), ...env });
      auth = createAuth(db, { send: async () => {} });
      mockSiteVerify();

      const response = await signUp(CANARY_EMAIL, {
        cookie: `${COOKIE}=${token}`,
        "x-captcha-response": "turnstile-token",
      });

      expect(response.status, name).toBe(403);
      expect(await usersWith(CANARY_EMAIL), name).toEqual([]);
    });
  }

  it("goes inert when ALLOW_SIGNUP opens the public door, which then admits on its own", async () => {
    stubEnv({ ...BASE_ENV, ALLOW_SIGNUP: "true", ...canaryEnv() });
    auth = createAuth(db, { send: async () => {} });
    mockSiteVerify();

    // The canary contributes nothing here — it is blocked, not merely shadowed.
    expect(canarySignupSettingNow()).toMatchObject({ status: "blocked" });

    const response = await signUp(OTHER_EMAIL, { "x-captcha-response": "turnstile-token" });

    expect(response.status).toBe(200);
    expect(await usersWith(OTHER_EMAIL)).toHaveLength(1);
  });
});

describe("a broken canary configuration closes only the canary", () => {
  it("keeps auth working when the canary is partial or expired", async () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["no digest", { ...canaryEnv(), MEPMAIL_CANARY_SIGNUP_TOKEN_SHA256: "" }],
      [
        "a raw token where the digest belongs",
        { ...canaryEnv(), MEPMAIL_CANARY_SIGNUP_TOKEN_SHA256: token },
      ],
      [
        "an expired window",
        { ...canaryEnv(undefined, new Date(Date.now() - 60_000).toISOString()) },
      ],
    ];
    for (const [name, env] of cases) {
      stubEnv({ ...BASE_ENV, ...env });
      // createAuth must construct and serve: a canary problem is not a boot
      // failure for the rest of the process.
      auth = createAuth(db, { send: async () => {} });
      mockSiteVerify();

      const canary = await signUp(CANARY_EMAIL, {
        cookie: `${COOKIE}=${token}`,
        "x-captcha-response": "turnstile-token",
      });
      expect(canary.status, name).toBe(403);
      expect(await usersWith(CANARY_EMAIL), name).toEqual([]);
      vi.unstubAllGlobals();
    }
  });

  it("rolls back with the switch alone, leaving the auxiliary values in place", async () => {
    stubEnv({ ...BASE_ENV, ...canaryEnv(), MEPMAIL_CANARY_SIGNUP: "false" });
    auth = createAuth(db, { send: async () => {} });
    mockSiteVerify();

    const response = await signUp(CANARY_EMAIL, {
      cookie: `${COOKIE}=${token}`,
      "x-captcha-response": "turnstile-token",
    });

    expect(response.status).toBe(403);
    expect(await usersWith(CANARY_EMAIL)).toEqual([]);
  });

  it("still admits the first account of an empty instance (bootstrap untouched)", async () => {
    await db.delete(schema.user);
    stubEnv({
      ...BASE_ENV,
      ...canaryEnv(undefined, new Date(Date.now() - 60_000).toISOString()),
    });
    auth = createAuth(db, { send: async () => {} });
    mockSiteVerify();

    const response = await signUp(OTHER_EMAIL, { "x-captcha-response": "turnstile-token" });

    expect(response.status).toBe(200);
    expect(await usersWith(OTHER_EMAIL)).toHaveLength(1);
  });
});
