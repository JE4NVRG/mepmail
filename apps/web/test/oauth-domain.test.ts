import { createHash, randomBytes } from "node:crypto";
import { EnvKeyring } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { createAuth } from "@/server/auth";
import { createApi } from "../../api/src/app.js";
import { foreignClaimsFixture } from "../../api/test/oauth-domain-fixture.js";

const ISSUER = "https://mepmail.je4ndev.com";
const API = "https://api-mepmail.je4ndev.com";
const RESOURCE = `${API}/mcp`;
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await close?.();
  close = undefined;
});

it.each([ISSUER, "https://mepmail.dev"])(
  "issues and verifies OAuth with stable issuer and web origin %s",
  async (web) => {
    vi.stubEnv("BETTER_AUTH_SECRET", "domain-test-only-secret-not-production-1234");
    vi.stubEnv("APP_BASE_URL", web);
    vi.stubEnv("OAUTH_ISSUER_URL", ISSUER);
    vi.stubEnv("PUBLIC_API_URL", API);
    vi.stubEnv("ALLOW_SIGNUP", "true");
    const testDb = await createTestDb();
    close = testDb.close;
    const db = testDb.db;
    const auth = createAuth(db, { send: async () => {} });
    const call = (path: string, init: RequestInit = {}) =>
      auth.handler(new Request(`${web}/api/auth${path}`, init));
    const meta = await (
      await auth.handler(new Request(`${web}/.well-known/oauth-authorization-server`))
    ).json();
    expect(auth.options.trustedOrigins).toEqual([web]);

    const teamId = await createTeam(db);
    const signup = await auth.api.signUpEmail({
      body: {
        email: "domain-test@example.com",
        name: "Domain fixture",
        password: "fixture password only",
      },
      returnHeaders: true,
    });
    const userId = signup.response.user.id;
    const cookie = signup.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    await db.insert(schema.teamMembers).values({ teamId, userId, role: "owner" });
    const redirect = "http://localhost:1234/callback";
    const register = await call("/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Domain fixture",
        redirect_uris: [redirect],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    expect(register.status).toBe(201);
    const { client_id: clientId } = await register.json();
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      scope: "offline_access audience:read",
      state: "domain-fixture",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource: RESOURCE,
    });
    const target = async (res: Response) => res.headers.get("location") ?? (await res.json()).url;
    const consentUrl = new URL(
      await target(await call(`/oauth2/authorize?${query}`, { headers: { cookie } })),
      web,
    );
    expect(consentUrl.pathname).toBe("/oauth/consent");
    const consent = await call("/oauth2/consent", {
      method: "POST",
      headers: { cookie, origin: web, "content-type": "application/json" },
      body: JSON.stringify({ accept: true, oauth_query: consentUrl.search.slice(1) }),
    });
    const callback = new URL(await target(consent));
    const tokenResponse = await call("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: callback.searchParams.get("code") ?? "",
        redirect_uri: redirect,
        code_verifier: verifier,
        resource: RESOURCE,
      }).toString(),
    });
    expect(tokenResponse.status).toBe(200);
    const { access_token: accessToken, refresh_token: refreshToken } = await tokenResponse.json();
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString());
    expect(claims.aud).toBe(RESOURCE);
    const fixture = await foreignClaimsFixture(claims);
    const jwks = await (await call("/jwks")).json();
    const requestedKeys: string[] = [];
    const keyResponses = new Map([[meta.jwks_uri, { keys: [...jwks.keys, fixture.jwk] }]]);
    // Transport-only fixture: real jose/JWKS/signature/issuer/audience checks remain active.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      requestedKeys.push(url);
      const response = keyResponses.get(url);
      if (!response) throw new Error(`Unexpected network request: ${url}`);
      return Response.json(response);
    });
    const api = createApi({
      db,
      appBaseUrl: web,
      publicApiUrl: API,
      oauthIssuerUrl: ISSUER,
      keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
      isCloud: false,
      enqueueEmailSend: async () => {
        throw new Error("No send allowed");
      },
    });
    const resourceMeta = await (
      await api.request("/.well-known/oauth-protected-resource/mcp")
    ).json();
    expect(resourceMeta.resource).toBe(RESOURCE);
    const ping = (token: string, via = api) =>
      via.request("/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
    expect((await ping(accessToken)).status).toBe(200);
    expect(requestedKeys).toEqual([meta.jwks_uri]);
    expect(claims.iss).toBe(ISSUER);
    expect(callback.searchParams.get("iss")).toBe(ISSUER);
    expect(meta.issuer).toBe(ISSUER);
    expect(meta.authorization_endpoint).toBe(`${web}/api/auth/oauth2/authorize`);
    expect(meta.token_endpoint).toBe(`${web}/api/auth/oauth2/token`);
    expect(meta.jwks_uri).toBe(`${web}/api/auth/jwks`);
    expect(resourceMeta.authorization_servers).toEqual([ISSUER]);
    expect((await ping(await fixture.sign({}))).status).toBe(200);
    expect((await ping(await fixture.sign({ iss: "https://foreign.example.com" }))).status).toBe(
      401,
    );
    expect((await ping(await fixture.sign({ aud: "https://wrong.example.com/mcp" }))).status).toBe(
      401,
    );
    if (web !== ISSUER) expect((await ping(await fixture.sign({ iss: web }))).status).toBe(401);

    // Reuse the persisted synthetic key and pre-transition token after the web origin changes.
    const otherWeb = web === ISSUER ? "https://mepmail.dev" : ISSUER;
    vi.stubEnv("APP_BASE_URL", otherWeb);
    const otherAuth = createAuth(db, { send: async () => {} });
    const otherMeta = await (
      await otherAuth.handler(new Request(`${otherWeb}/.well-known/oauth-authorization-server`))
    ).json();
    const otherJwks = await (
      await otherAuth.handler(new Request(`${otherWeb}/api/auth/jwks`))
    ).json();
    keyResponses.set(otherMeta.jwks_uri, { keys: [...otherJwks.keys, fixture.jwk] });
    const otherApi = createApi({
      db,
      appBaseUrl: otherWeb,
      publicApiUrl: API,
      oauthIssuerUrl: ISSUER,
      keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
      isCloud: false,
      enqueueEmailSend: async () => {
        throw new Error("No send allowed");
      },
    });
    expect(otherMeta.issuer).toBe(ISSUER);
    expect(otherMeta.jwks_uri).toBe(`${otherWeb}/api/auth/jwks`);
    expect((await ping(accessToken, otherApi)).status).toBe(200);
    expect(requestedKeys).toEqual([meta.jwks_uri, otherMeta.jwks_uri]);
    expect(otherAuth.options.trustedOrigins).toEqual([otherWeb]);
    const refreshed = await otherAuth.handler(
      new Request(`${otherWeb}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: refreshToken,
        }).toString(),
      }),
    );
    expect(refreshed.status).toBe(200);
    const refreshedToken = (await refreshed.json()).access_token;
    const refreshedClaims = JSON.parse(
      Buffer.from(refreshedToken.split(".")[1], "base64url").toString(),
    );
    expect(refreshedClaims.iss).toBe(ISSUER);
    expect(refreshedClaims.aud).toBe(RESOURCE);
    expect((await ping(refreshedToken, otherApi)).status).toBe(200);
  },
  60_000,
);

it.each([
  "/relative",
  "not a URL",
  "https://user:pass@example.com",
  "https://example.com/path",
  "https://example.com?query",
  "https://example.com#fragment",
])("rejects invalid explicit issuer %s before constructing auth", async (issuer) => {
  vi.stubEnv("BETTER_AUTH_SECRET", "domain-test-only-secret-not-production-1234");
  vi.stubEnv("APP_BASE_URL", "https://mepmail.dev");
  vi.stubEnv("PUBLIC_API_URL", API);
  vi.stubEnv("OAUTH_ISSUER_URL", issuer);
  const testDb = await createTestDb();
  close = testDb.close;
  expect(() => createAuth(testDb.db, { send: async () => {} })).toThrow(/OAUTH_ISSUER_URL/);
  expect(() =>
    createApi({
      db: testDb.db,
      appBaseUrl: "https://mepmail.dev",
      oauthIssuerUrl: issuer,
      publicApiUrl: API,
      isCloud: false,
      keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
      enqueueEmailSend: async () => {},
    }),
  ).toThrow(/OAUTH_ISSUER_URL/);
});

it.each([undefined, "/relative", "not a URL"])(
  "rejects migration with missing or malformed PUBLIC_API_URL %s in both servers",
  async (publicApi) => {
    vi.stubEnv("BETTER_AUTH_SECRET", "domain-test-only-secret-not-production-1234");
    vi.stubEnv("APP_BASE_URL", "https://mepmail.dev");
    vi.stubEnv("OAUTH_ISSUER_URL", ISSUER);
    vi.stubEnv("PUBLIC_API_URL", publicApi);
    const testDb = await createTestDb();
    close = testDb.close;
    expect(() => createAuth(testDb.db, { send: async () => {} })).toThrow(/PUBLIC_API_URL/);
    expect(() =>
      createApi({
        db: testDb.db,
        appBaseUrl: "https://mepmail.dev",
        oauthIssuerUrl: ISSUER,
        publicApiUrl: publicApi,
        isCloud: false,
        keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
        enqueueEmailSend: async () => {},
      }),
    ).toThrow(/PUBLIC_API_URL/);
  },
);
