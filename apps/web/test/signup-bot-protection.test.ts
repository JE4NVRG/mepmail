import type { SystemMailMessage } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { type Auth, createAuth } from "@/server/auth";

// Classifier lookups are covered independently; this suite must not perform
// DNS/RDAP lookups or emit network traffic while exercising real auth hooks.
vi.mock("@millionsend/core", async (original) => ({
  ...(await original<typeof import("@millionsend/core")>()),
  recordSignupRisk: vi.fn(async () => undefined),
}));

const BASE = "http://localhost:3000";
const VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const PASSWORD = "synthetic correct horse battery";
let db: Db;
let close: () => Promise<void>;
let auth: Auth;
let sent: SystemMailMessage[];
let verification: Record<string, unknown>;
let github: { id: number; email: string };
let used: Set<string>;
let siteverify: Mock<(init?: RequestInit) => Promise<Response>>;

beforeEach(async () => {
  for (const [key, value] of Object.entries({
    IS_CLOUD: "true",
    SIGNUP_BOT_PROTECTION: "true",
    BETTER_AUTH_SECRET: "synthetic-only-aaaaaaaaaaaaaaaaaaaaaaaa",
    APP_BASE_URL: BASE,
    ALLOW_SIGNUP: "true",
    BETA_MAX_USERS: "",
    AUTH_EMAIL_FROM: "",
    NOTIFICATIONS_EMAIL_FROM: "",
    AWS_ACCESS_KEY_ID: "",
    AWS_SECRET_ACCESS_KEY: "",
    AWS_DEFAULT_CHAIN: "",
    TELEGRAM_BOT_TOKEN: "",
    TURNSTILE_SITE_KEY: "synthetic-site",
    TURNSTILE_SECRET_KEY: "synthetic-secret",
    GITHUB_CLIENT_ID: "synthetic-client",
    GITHUB_CLIENT_SECRET: "synthetic-client-secret",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    MICROSOFT_CLIENT_ID: "",
    MICROSOFT_CLIENT_SECRET: "",
  }))
    vi.stubEnv(key, value);
  ({ db, close } = await createTestDb());
  sent = [];
  auth = createAuth(db, {
    send: async (message) => {
      sent.push(message);
    },
  });
  verification = { success: true, hostname: "localhost", action: "auth" };
  github = { id: 101, email: "social@example.com" };
  used = new Set();
  siteverify = vi.fn(async (init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { response: string };
    if (used.has(body.response)) return Response.json({ success: false });
    used.add(body.response);
    return Response.json(verification);
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === VERIFY) return siteverify(init);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "synthetic-access", token_type: "bearer" });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({
        id: github.id,
        login: "synthetic",
        name: "Synthetic",
        email: github.email,
      });
    }
    if (url === "https://api.github.com/user/emails") {
      return Response.json([{ email: github.email, primary: true, verified: true }]);
    }
    throw new Error("Unexpected external request in synthetic signup test");
  });
  // OAuth resource seeding starts asynchronously at construction. Finish it
  // before a test replaces auth with another configuration on this same DB.
  await auth.$context;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await close();
});

function request(path: string, body: Record<string, unknown>, token?: string) {
  return auth.handler(
    new Request(`${BASE}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE,
        ...(token ? { "x-captcha-response": token } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}
function signup(email = "person@example.com", token?: string, extra: Record<string, unknown> = {}) {
  return request(
    "/sign-up/email",
    { name: "Synthetic", email, password: PASSWORD, ...extra },
    token,
  );
}
async function noAccountSideEffects() {
  expect(await db.select().from(schema.user)).toHaveLength(0);
  expect(await db.select().from(schema.account)).toHaveLength(0);
  expect(await db.select().from(schema.session)).toHaveLength(0);
  expect(await db.select().from(schema.teams)).toHaveLength(0);
  expect(await db.select().from(schema.apiKeys)).toHaveLength(0);
  expect(sent).toHaveLength(0);
}
function cookies(headers: Headers) {
  return headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}
async function socialCallback(start: Response) {
  expect(start.status).toBe(200);
  const { url } = await start.json();
  const state = new URL(url).searchParams.get("state");
  expect(state).toBeTruthy();
  return auth.handler(
    new Request(
      `${BASE}/api/auth/callback/github?${new URLSearchParams({
        code: "synthetic-code",
        state: state!,
      })}`,
      { headers: { cookie: cookies(start.headers) } },
    ),
  );
}

describe("cloud signup challenge through the real HTTP handler", () => {
  it("rejects direct signup without a token before creating a user or sending mail", async () => {
    const response = await signup();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "SIGNUP_BOT_VERIFICATION_REQUIRED" });
    expect(siteverify).not.toHaveBeenCalled();
    await noAccountSideEffects();
  });

  it("does not trust a token or proof supplied only in the JSON body", async () => {
    expect(
      (
        await signup("person@example.com", undefined, {
          "x-captcha-response": "synthetic-token",
          mepmailSignupBotVerified: true,
        })
      ).status,
    ).toBe(403);
    await noAccountSideEffects();
  });

  for (const keys of ["absent", "site-only", "secret-only"] as const) {
    it(`${keys} configuration fails only the signup operation with a recoverable 503`, async () => {
      vi.stubEnv("TURNSTILE_SITE_KEY", keys === "site-only" ? "synthetic-site" : "");
      vi.stubEnv("TURNSTILE_SECRET_KEY", keys === "secret-only" ? "synthetic-secret" : "");
      auth = createAuth(db, {
        send: async (message) => {
          sent.push(message);
        },
      });
      const response = await signup("person@example.com", "synthetic-token");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "SIGNUP_BOT_PROTECTION_UNAVAILABLE" });
      await noAccountSideEffects();
    });
  }

  for (const invalid of [
    { success: false, hostname: "localhost", action: "auth" },
    { success: true, hostname: "other.example.com", action: "auth" },
    { success: true, hostname: "localhost", action: "onboarding" },
    { success: true, action: "auth" },
  ]) {
    it(`rejects provider rejection or mismatched context: ${JSON.stringify(invalid)}`, async () => {
      verification = invalid;
      expect((await signup("person@example.com", "synthetic-token")).status).toBe(403);
      await noAccountSideEffects();
    });
  }

  for (const failure of ["timeout", "http", "json"] as const) {
    it(`fails closed on a ${failure} provider failure without account side effects`, async () => {
      siteverify.mockImplementation(async () => {
        if (failure === "http") return new Response("unavailable", { status: 503 });
        if (failure === "json") return new Response("invalid json");
        throw new DOMException("Synthetic timeout", "TimeoutError");
      });
      expect((await signup("person@example.com", "synthetic-token")).status).toBe(503);
      await noAccountSideEffects();
    });
  }

  it("accepts a valid token once, never double-verifies it through the legacy plugin", async () => {
    expect((await signup("first@example.com", "synthetic-token")).status).toBe(200);
    expect(siteverify).toHaveBeenCalledTimes(1);
    expect((await signup("second@example.com", "synthetic-token")).status).toBe(403);
    expect(await db.select().from(schema.user)).toHaveLength(1);
    expect(await db.select().from(schema.apiKeys)).toHaveLength(0);
  });

  it("keeps the gate active for normalized trailing-slash HTTP paths", async () => {
    const response = await request("/sign-up/email/", {
      name: "Synthetic",
      email: "person@example.com",
      password: PASSWORD,
    });
    expect(response.status).not.toBe(200);
    await noAccountSideEffects();
  });

  it("allows self-hosted setup and legacy cloud opt-out without a new challenge", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    vi.stubEnv("IS_CLOUD", "false");
    auth = createAuth(db);
    expect((await signup("selfhost@example.com")).status).toBe(200);
    vi.stubEnv("IS_CLOUD", "true");
    vi.stubEnv("SIGNUP_BOT_PROTECTION", "false");
    auth = createAuth(db);
    expect((await signup("legacy@example.com")).status).toBe(200);
    expect(siteverify).not.toHaveBeenCalled();
  });

  it("keeps email login working when protected signup has no configured keys", async () => {
    expect((await signup("existing@example.com", "synthetic-token")).status).toBe(200);
    vi.stubEnv("TURNSTILE_SITE_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    auth = createAuth(db);
    const login = await request("/sign-in/email", {
      email: "existing@example.com",
      password: PASSWORD,
    });
    expect(login.status).toBe(200);
    expect(await db.select().from(schema.user)).toHaveLength(1);
  });

  it("allows an existing email login without a challenge when the new gate and both keys are active", async () => {
    expect((await signup("existing@example.com", "synthetic-token")).status).toBe(200);
    siteverify.mockClear();
    const login = await request("/sign-in/email", {
      email: "existing@example.com",
      password: PASSWORD,
    });
    expect(login.status).toBe(200);
    expect(siteverify).not.toHaveBeenCalled();
    expect(await db.select().from(schema.user)).toHaveLength(1);
  });

  it("retains the legacy email login challenge when the explicit signup gate is off", async () => {
    vi.stubEnv("SIGNUP_BOT_PROTECTION", "false");
    auth = createAuth(db);
    const login = await request("/sign-in/email", {
      email: "existing@example.com",
      password: PASSWORD,
    });
    expect(login.status).toBe(400);
    expect(await login.json()).toMatchObject({ code: "MISSING_RESPONSE" });
    expect(siteverify).not.toHaveBeenCalled();
  });

  for (const path of ["/send-verification-email", "/request-password-reset"]) {
    it(`preserves the token requirement for ${path} with protected signup enabled`, async () => {
      const response = await request(path, { email: "person@example.com" });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "MISSING_RESPONSE" });
      expect(siteverify).not.toHaveBeenCalled();
      await noAccountSideEffects();
    });
  }

  it("protects explicit social signup before issuing a provider redirect", async () => {
    const start = await request("/sign-in/social", { provider: "github", requestSignUp: true });
    expect(start.status).toBe(403);
    await noAccountSideEffects();
  });

  it("reports social signup verification configuration failure before issuing a redirect", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    auth = createAuth(db);
    const start = await request("/sign-in/social", { provider: "github", requestSignUp: true });
    expect(start.status).toBe(503);
    await noAccountSideEffects();
  });

  it("carries server-only proof through the social callback without a second token", async () => {
    const start = await request(
      "/sign-in/social",
      { provider: "github", requestSignUp: true },
      "synthetic-social-token",
    );
    const callback = await socialCallback(start);
    expect(callback.status).toBe(302);
    expect(new URL(callback.headers.get("location")!, BASE).searchParams.get("error")).toBeNull();
    expect(await db.select().from(schema.user)).toHaveLength(1);
    expect(siteverify).toHaveBeenCalledTimes(1);
  });

  it("rejects implicit social user creation and forged additionalData proof", async () => {
    const start = await request("/sign-in/social", {
      provider: "github",
      additionalData: {
        mepmailSignupBotVerified: true,
        serverContext: { mepmailSignupBotVerified: true },
      },
    });
    await socialCallback(start);
    expect(siteverify).not.toHaveBeenCalled();
    await noAccountSideEffects();
  });

  it("keeps an existing social account login working without signup keys", async () => {
    await socialCallback(
      await request(
        "/sign-in/social",
        { provider: "github", requestSignUp: true },
        "synthetic-social-token",
      ),
    );
    vi.stubEnv("TURNSTILE_SITE_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    auth = createAuth(db);
    const callback = await socialCallback(await request("/sign-in/social", { provider: "github" }));
    expect(callback.status).toBe(302);
    expect(new URL(callback.headers.get("location")!, BASE).searchParams.get("error")).toBeNull();
    expect(await db.select().from(schema.user)).toHaveLength(1);
    expect(siteverify).toHaveBeenCalledTimes(1);
  });
});
