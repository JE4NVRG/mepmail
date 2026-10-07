import { createHash, randomBytes } from "node:crypto";
import { EnvKeyring } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { createAuth } from "@/server/auth";
import { linkClientsToResource } from "@/server/oauth-resources";
import { createApi } from "../../api/src/app.js";

// Production shape on 2026-10-07: dashboard and OAuth endpoints on
// mepmail.dev, a stable issuer identifier, the canonical API host, and the
// brand API host added in front of the same server.
const WEB = "https://mepmail.dev";
const ISSUER = "https://mepmail.je4ndev.com";
const API = "https://api-mepmail.je4ndev.com";
const BRAND_API = "https://api.mepmail.dev";
const OLD = `${API}/mcp`;
const NEW = `${BRAND_API}/mcp`;
const REDIRECT = "http://localhost:1234/callback";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await close?.();
  close = undefined;
});

type Auth = ReturnType<typeof createAuth>;
const call = (auth: Auth, path: string, init: RequestInit = {}) =>
  auth.handler(new Request(`${WEB}/api/auth${path}`, init));
const claimsOf = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as {
    aud: string;
    iss: string;
  };

async function register(auth: Auth): Promise<string> {
  const res = await call(auth, "/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Agent fixture",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** Authorization code + PKCE for `resource`; null when the server refuses the target. */
async function grant(auth: Auth, cookie: string, clientId: string, resource: string) {
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "offline_access audience:read",
    state: "fixture",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource,
  });
  const target = async (res: Response) =>
    res.headers.get("location") ?? ((await res.json()) as { url?: string }).url ?? "";
  const authorize = await call(auth, `/oauth2/authorize?${query}`, { headers: { cookie } });
  const consentUrl = new URL((await target(authorize)) || "about:blank", WEB);
  if (consentUrl.pathname !== "/oauth/consent") return null;
  const consent = await call(auth, "/oauth2/consent", {
    method: "POST",
    headers: { cookie, origin: WEB, "content-type": "application/json" },
    body: JSON.stringify({ accept: true, oauth_query: consentUrl.search.slice(1) }),
  });
  const callback = new URL(await target(consent));
  const token = await call(auth, "/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: callback.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource,
    }).toString(),
  });
  expect(token.status).toBe(200);
  return (await token.json()) as { access_token: string; refresh_token: string };
}

it("moves agents to the brand MCP host without dropping a grant", async () => {
  vi.stubEnv("BETTER_AUTH_SECRET", "advertised-mcp-test-secret-not-production-1234");
  vi.stubEnv("APP_BASE_URL", WEB);
  vi.stubEnv("OAUTH_ISSUER_URL", ISSUER);
  vi.stubEnv("PUBLIC_API_URL", API);
  vi.stubEnv("ALLOW_SIGNUP", "true");
  const testDb = await createTestDb();
  close = testDb.close;
  const db = testDb.db;

  // Before the brand host: an agent registers and connects on the old URL.
  const before = createAuth(db, { send: async () => {} });
  const teamId = await createTeam(db);
  const signup = await before.api.signUpEmail({
    body: { email: "agent-owner@example.com", name: "Owner", password: "fixture password only" },
    returnHeaders: true,
  });
  const cookie = signup.headers
    .getSetCookie()
    .map((v) => v.split(";")[0])
    .join("; ");
  await db
    .insert(schema.teamMembers)
    .values({ teamId, userId: signup.response.user.id, role: "owner" });
  const oldClient = await register(before);
  const oldGrant = await grant(before, cookie, oldClient, OLD);
  expect(oldGrant && claimsOf(oldGrant.access_token).aud).toBe(OLD);

  // The brand host arrives.
  vi.stubEnv("ADVERTISED_API_URL", BRAND_API);
  const after = createAuth(db, { send: async () => {} });
  const meta = (await (
    await after.handler(new Request(`${WEB}/.well-known/oauth-authorization-server`))
  ).json()) as { issuer: string; jwks_uri: string };
  expect(meta.issuer).toBe(ISSUER);

  // A client registered before it may only ask for the old identifier, until linked.
  expect(await grant(after, cookie, oldClient, NEW)).toBeNull();
  expect(await linkClientsToResource(db, OLD, NEW)).toBe(1);
  expect(await linkClientsToResource(db, OLD, NEW)).toBe(0);
  const movedGrant = await grant(after, cookie, oldClient, NEW);
  expect(movedGrant && claimsOf(movedGrant.access_token).aud).toBe(NEW);

  // A client registered now is linked to both.
  const newClient = await register(after);
  const links = await db
    .select({ resourceId: schema.oauthClientResource.resourceId })
    .from(schema.oauthClientResource)
    .where(eq(schema.oauthClientResource.clientId, newClient));
  expect(links.map((l) => l.resourceId).sort()).toEqual([NEW, OLD].sort());

  // The API answers on both hosts and accepts either binding.
  const jwks = await (await call(after, "/jwks")).json();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== meta.jwks_uri) throw new Error(`Unexpected network request: ${url}`);
    return Response.json(jwks);
  });
  const api = createApi({
    db,
    appBaseUrl: WEB,
    publicApiUrl: API,
    advertisedApiUrl: BRAND_API,
    oauthIssuerUrl: ISSUER,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    isCloud: false,
    enqueueEmailSend: async () => {
      throw new Error("No send allowed");
    },
  });
  const ping = (token: string, origin: string) =>
    api.request(`${origin}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
  for (const token of [oldGrant?.access_token ?? "", movedGrant?.access_token ?? ""]) {
    for (const origin of [API, BRAND_API]) expect((await ping(token, origin)).status).toBe(200);
  }
  const brandMeta = (await (
    await api.request(`${BRAND_API}/.well-known/oauth-protected-resource/mcp`)
  ).json()) as { resource: string; authorization_servers: string[] };
  expect(brandMeta).toMatchObject({ resource: NEW, authorization_servers: [ISSUER] });
  const oldMeta = (await (
    await api.request(`${API}/.well-known/oauth-protected-resource/mcp`)
  ).json()) as { resource: string };
  expect(oldMeta.resource).toBe(OLD);

  // The old agent's refresh keeps its binding and keeps working.
  const refreshed = await call(after, "/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: oldClient,
      refresh_token: oldGrant?.refresh_token ?? "",
    }).toString(),
  });
  expect(refreshed.status).toBe(200);
  const refreshedToken = ((await refreshed.json()) as { access_token: string }).access_token;
  expect(claimsOf(refreshedToken)).toMatchObject({ aud: OLD, iss: ISSUER });
  expect((await ping(refreshedToken, BRAND_API)).status).toBe(200);
}, 60_000);
