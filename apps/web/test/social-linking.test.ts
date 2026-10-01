import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Auth, createAuth } from "@/server/auth";

const BASE = "http://localhost:3000";
let db: Db;
let close: () => Promise<void>;
let auth: Auth;
let github: { id: number; email: string; verified: boolean };

beforeEach(async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret-1234");
  vi.stubEnv("APP_BASE_URL", BASE);
  vi.stubEnv("ALLOW_SIGNUP", "true");
  vi.stubEnv("BETA_MAX_USERS", "");
  vi.stubEnv("AUTH_EMAIL_FROM", "");
  vi.stubEnv("GITHUB_CLIENT_ID", "fixture-client");
  vi.stubEnv("GITHUB_CLIENT_SECRET", "fixture-secret");
  vi.stubEnv("GOOGLE_CLIENT_ID", "");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
  vi.stubEnv("MICROSOFT_CLIENT_ID", "");
  vi.stubEnv("MICROSOFT_CLIENT_SECRET", "");
  ({ db, close } = await createTestDb());
  auth = createAuth(db);
  github = { id: 101, email: "ada@example.com", verified: true };
  // Only the external provider transport is mocked. State, signed cookies,
  // authenticated endpoints, callbacks and account persistence remain real.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({
        access_token: "fixture-access",
        token_type: "bearer",
        scope: "read:user,user:email",
      });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({
        id: github.id,
        login: "fixture",
        name: "Fixture",
        email: github.email,
      });
    }
    if (url === "https://api.github.com/user/emails") {
      return Response.json([{ email: github.email, primary: true, verified: github.verified }]);
    }
    throw new Error(`Unexpected network request: ${url}`);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await close();
});

function cookies(headers: Headers) {
  return headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

async function signUp(email: string) {
  const { headers, response } = await auth.api.signUpEmail({
    body: { name: email, email, password: "correct horse battery" },
    returnHeaders: true,
  });
  return { userId: response.user.id, cookie: cookies(headers) };
}

async function link(cookie: string, keepStateCookie = true) {
  const start = await auth.handler(
    new Request(`${BASE}/api/auth/link-social`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        callbackURL: `${BASE}/settings?linkedSocial=github`,
        errorCallbackURL: `${BASE}/settings?linkSocial=error`,
        disableRedirect: true,
      }),
    }),
  );
  expect(start.status).toBe(200);
  const { url } = await start.json();
  const authorization = new URL(url);
  expect(authorization.origin).toBe("https://github.com");
  expect(authorization.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/callback/github`);
  const state = authorization.searchParams.get("state");
  expect(state).toBeTruthy();
  const stateCookie = cookies(start.headers);
  expect(stateCookie).not.toBe("");
  return auth.handler(
    new Request(
      `${BASE}/api/auth/callback/github?${new URLSearchParams({
        code: "fixture-code",
        state: state!,
      })}`,
      { headers: { cookie: keepStateCookie ? `${cookie}; ${stateCookie}` : cookie } },
    ),
  );
}

function callbackError(response: Response) {
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location")!, BASE).searchParams.get("error");
}

describe("explicit social account linking", () => {
  it("adds verified same-email GitHub to the signed-in user and retains password access", async () => {
    const ada = await signUp("ada@example.com");
    const response = await link(ada.cookie);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${BASE}/settings?linkedSocial=github`);
    const accounts = await auth.api.listUserAccounts({
      headers: new Headers({ cookie: ada.cookie }),
    });
    expect(accounts.map((account) => account.providerId).sort()).toEqual(["credential", "github"]);
    expect(accounts.every((account) => account.userId === ada.userId)).toBe(true);
    expect(await db.select().from(schema.user)).toHaveLength(1);
    await expect(
      auth.api.signInEmail({
        body: { email: "ada@example.com", password: "correct horse battery" },
      }),
    ).resolves.toMatchObject({ user: { id: ada.userId } });
  });

  it("rejects a different email without adding an identity", async () => {
    const ada = await signUp("ada@example.com");
    github.email = "other@example.com";
    expect(callbackError(await link(ada.cookie))).toBe("email_does_not_match");
    expect(
      await db.select().from(schema.account).where(eq(schema.account.providerId, "github")),
    ).toHaveLength(0);
  });

  it("preserves an identity already owned by another user", async () => {
    const ada = await signUp("ada@example.com");
    const bob = await signUp("bob@example.com");
    github.email = "bob@example.com";
    expect((await link(bob.cookie)).status).toBe(302);
    github.email = "ada@example.com";
    expect(callbackError(await link(ada.cookie))).toBe("account_already_linked_to_different_user");
    const accounts = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.providerId, "github"));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.userId).toBe(bob.userId);
  });

  it("rejects an unverified provider email", async () => {
    const ada = await signUp("ada@example.com");
    github.verified = false;
    expect(callbackError(await link(ada.cookie))).toBe("unable_to_link_account");
    expect(
      await db.select().from(schema.account).where(eq(schema.account.providerId, "github")),
    ).toHaveLength(0);
  });

  it("rejects a callback without the signed state cookie before calling GitHub", async () => {
    const ada = await signUp("ada@example.com");
    expect(callbackError(await link(ada.cookie, false))).toBe("state_mismatch");
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await db.select().from(schema.account).where(eq(schema.account.providerId, "github")),
    ).toHaveLength(0);
  });
});
