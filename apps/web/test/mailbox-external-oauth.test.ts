import { createHash, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvKeyring, type Keyring } from "../../../packages/core/src/crypto/keyring.js";
import {
  createMailboxExternalAccount,
  mailboxExternalCredential,
  openMailboxExternalAccount,
} from "../../../packages/core/src/mailbox-external-accounts.js";
import {
  exchangeMailboxExternalOAuthCode,
  MailboxExternalOAuthError,
  type MailboxExternalOAuthGrant,
  mailboxExternalOAuthAuthorizeUrl,
  mailboxExternalOAuthAvailable,
  mailboxExternalOAuthSecret,
  mailboxExternalOAuthServers,
  readMailboxExternalOAuthSecret,
  refreshMailboxExternalOAuthToken,
} from "../../../packages/core/src/mailbox-external-oauth.js";

process.env.MASTER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

let db: Db;
let keys: Keyring;
let context: Record<string, unknown> = {};
vi.mock("@/server/trpc", () => ({ createContext: async () => context }));
vi.mock("@/server/mailboxes", () => ({
  mailboxRegistryEnabled: () => true,
  mailboxActorAccessEnabled: async () => true,
}));
vi.mock("@/server/routers/mailbox-external", () => ({ mailboxExternalOpen: () => true }));
vi.mock("@/server/keyring", () => ({ getKeyring: () => keys }));
vi.mock("@/server/audit", () => ({ recordAudit: async () => undefined }));
vi.mock("@/lib/api-base-url", () => ({ appBaseUrl: () => "https://mepmail.dev" }));

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const THUMBPRINT = "DA66D6C5AE253491937BA0563108256245FB6BC9";
const CONSUMER = "9188040d-6c67-4c5b-b112-36a304b66dad";

const savedEnv = { ...process.env };
function configure() {
  process.env.MICROSOFT_OAUTH_CLIENT_ID = "11111111-2222-4333-8444-555555555555";
  process.env.MICROSOFT_OAUTH_CERT_THUMBPRINT = THUMBPRINT;
  process.env.MICROSOFT_OAUTH_CERT_PRIVATE_KEY_B64 = Buffer.from(PEM).toString("base64");
  process.env.GOOGLE_OAUTH_CLIENT_ID = "google-client.apps.googleusercontent.com";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "google-secret";
}
afterEach(() => {
  process.env = { ...savedEnv };
});

const idToken = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

/** A token endpoint that answers `answer` and records what it was sent. */
function tokenEndpoint(answer: Record<string, unknown>, status = 200) {
  const sent: { url: string; body: URLSearchParams }[] = [];
  const fetcher = (async (url: string, init: { body: URLSearchParams }) => {
    sent.push({ url, body: new URLSearchParams(init.body.toString()) });
    return new Response(JSON.stringify(answer), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, sent };
}

describe("Contas externas: Microsoft and Google sign-in (provider side)", () => {
  it("offers Microsoft with its certificate, Google only when switched on", () => {
    expect(mailboxExternalOAuthAvailable()).toEqual({ microsoft: false, google: false });
    configure();
    expect(mailboxExternalOAuthAvailable()).toEqual({ microsoft: true, google: false });
    process.env.MAILBOX_EXTERNAL_GOOGLE_OAUTH = "1";
    expect(mailboxExternalOAuthAvailable()).toEqual({ microsoft: true, google: true });
    process.env.MICROSOFT_OAUTH_CERT_THUMBPRINT = "not-hex";
    expect(mailboxExternalOAuthAvailable().microsoft).toBe(false);
  });

  it("sends the browser to consent with PKCE and the mail scopes", () => {
    configure();
    const microsoft = new URL(
      mailboxExternalOAuthAuthorizeUrl("microsoft", {
        redirectUri: "https://mepmail.dev/api/mailboxes/external/oauth/microsoft/callback",
        state: "s1",
        codeChallenge: "c1",
        loginHint: "ana@outlook.com",
      }),
    );
    expect(microsoft.origin + microsoft.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(microsoft.searchParams.get("scope")).toContain(
      "https://outlook.office.com/IMAP.AccessAsUser.All",
    );
    expect(microsoft.searchParams.get("scope")).toContain("offline_access");
    expect(microsoft.searchParams.get("code_challenge_method")).toBe("S256");
    expect(microsoft.searchParams.get("login_hint")).toBe("ana@outlook.com");
    const google = new URL(
      mailboxExternalOAuthAuthorizeUrl("google", {
        redirectUri: "https://mepmail.dev/api/mailboxes/external/oauth/google/callback",
        state: "s2",
        codeChallenge: "c2",
      }),
    );
    expect(google.searchParams.get("scope")).toContain("https://mail.google.com/");
    expect(google.searchParams.get("access_type")).toBe("offline");
    expect(google.searchParams.get("prompt")).toBe("consent");
  });

  it("proves the Microsoft app with a JWT signed by the certificate key, no secret", async () => {
    configure();
    const { fetcher, sent } = tokenEndpoint({
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_in: 3600,
      id_token: idToken({ preferred_username: "Ana@Outlook.com", tid: CONSUMER }),
    });
    const grant = await exchangeMailboxExternalOAuthCode(
      "microsoft",
      { code: "code-1", codeVerifier: "verifier-1", redirectUri: "https://x/cb" },
      fetcher,
    );
    expect(grant).toMatchObject({
      accessToken: "at-1",
      refreshToken: "rt-1",
      address: "ana@outlook.com",
      consumer: true,
    });
    const body = sent[0]!.body;
    expect(sent[0]!.url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(body.get("client_secret")).toBeNull();
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("client_assertion_type")).toBe(
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    );
    const [header, payload, signature] = body.get("client_assertion")!.split(".");
    const head = JSON.parse(Buffer.from(header!, "base64url").toString());
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(head).toMatchObject({ alg: "RS256", typ: "JWT" });
    expect(Buffer.from(head.x5t, "base64url").toString("hex").toUpperCase()).toBe(THUMBPRINT);
    expect(claims).toMatchObject({
      aud: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      iss: "11111111-2222-4333-8444-555555555555",
      sub: "11111111-2222-4333-8444-555555555555",
    });
    expect(claims.exp).toBeGreaterThan(claims.iat);
    expect(
      createVerify("RSA-SHA256")
        .update(`${header}.${payload}`)
        .verify(publicKey, Buffer.from(signature!, "base64url")),
    ).toBe(true);
  });

  it("refuses a grant without a refresh token or a verified address", async () => {
    configure();
    process.env.MAILBOX_EXTERNAL_GOOGLE_OAUTH = "1";
    const input = { code: "c", codeVerifier: "v", redirectUri: "https://x/cb" };
    await expect(
      exchangeMailboxExternalOAuthCode(
        "google",
        input,
        tokenEndpoint({ access_token: "a", id_token: idToken({ email: "ana@gmail.com" }) }).fetcher,
      ),
    ).rejects.toMatchObject({ reason: "incomplete" });
    await expect(
      exchangeMailboxExternalOAuthCode(
        "google",
        input,
        tokenEndpoint({
          access_token: "a",
          refresh_token: "r",
          id_token: idToken({ email: "ana@gmail.com", email_verified: false }),
        }).fetcher,
      ),
    ).rejects.toMatchObject({ reason: "incomplete" });
    const google = tokenEndpoint({
      access_token: "a",
      refresh_token: "r",
      id_token: idToken({ email: "Ana@Gmail.com", email_verified: true }),
    });
    await expect(
      exchangeMailboxExternalOAuthCode("google", input, google.fetcher),
    ).resolves.toMatchObject({ address: "ana@gmail.com", consumer: false });
    expect(google.sent[0]!.body.get("client_secret")).toBe("google-secret");
  });

  it("reads a revoked grant as invalid_grant and keeps a refresh token that was not rotated", async () => {
    configure();
    await expect(
      refreshMailboxExternalOAuthToken(
        "microsoft",
        "rt-old",
        tokenEndpoint({ error: "invalid_grant" }, 400).fetcher,
      ),
    ).rejects.toMatchObject({ reason: "invalid_grant" });
    await expect(
      refreshMailboxExternalOAuthToken("microsoft", "rt-old", tokenEndpoint({}, 503).fetcher),
    ).rejects.toMatchObject({ reason: "unavailable" });
    const kept = await refreshMailboxExternalOAuthToken(
      "microsoft",
      "rt-old",
      tokenEndpoint({ access_token: "at", expires_in: 3600 }).fetcher,
    );
    expect(kept.refreshToken).toBe("rt-old");
  });

  it("uses the provider's fixed servers (personal Microsoft accounts on smtp-mail)", () => {
    expect(
      mailboxExternalOAuthServers("microsoft", { address: "a@hotmail.com", consumer: true }),
    ).toMatchObject({
      provider: "outlook",
      imapHost: "outlook.office365.com",
      smtpHost: "smtp-mail.outlook.com",
      smtpPort: 587,
      smtpSecurity: "starttls",
      username: "a@hotmail.com",
    });
    expect(
      mailboxExternalOAuthServers("microsoft", { address: "a@empresa.com", consumer: false })
        .smtpHost,
    ).toBe("smtp.office365.com");
    expect(
      mailboxExternalOAuthServers("google", { address: "a@gmail.com", consumer: false }),
    ).toMatchObject({ provider: "gmail", smtpHost: "smtp.gmail.com", smtpPort: 465 });
    expect(readMailboxExternalOAuthSecret(mailboxExternalOAuthSecret("rt"))).toBe("rt");
    expect(readMailboxExternalOAuthSecret("abcd efgh ijkl mnop")).toBeNull();
  });
});

const base = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
let team: string;

async function boot() {
  const client = new PGlite();
  for (const name of readdirSync(base)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await client.transaction(async (tx) => {
      for (const statement of readFileSync(base + name, "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => s.trim()))
        await tx.exec(statement);
    });
  const database = drizzle(client, { schema });
  db = database as unknown as Db;
  await migrate(database, { migrationsFolder: extension, migrationsTable: "__mailbox_migrations" });
  keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
  const [row] = await db.insert(schema.teams).values({ name: "T", slug: "oauth-t" }).returning();
  team = row!.id;
  for (const id of ["ana", "bia"])
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.invalid`, emailVerified: true });
  await db.insert(schema.teamMembers).values([
    { teamId: team, userId: "ana", role: "owner" },
    { teamId: team, userId: "bia", role: "member" },
  ]);
}

describe("Contas externas: OAuth accounts (credentials and the callback)", () => {
  beforeEach(boot);

  const domain = "00000000-0000-4000-8000-000000000001";
  const operations = {
    version: 1 as const,
    userDirectoryRead: true,
    mailboxCreateDomainIds: [domain],
  };
  const membership = () =>
    and(eq(schema.teamMembers.teamId, team), eq(schema.teamMembers.userId, "bia"));
  const accountInput = (address = "bia@example.invalid") => ({
    address,
    label: "Synthetic external account",
    servers: mailboxExternalOAuthServers("microsoft", { address, consumer: true }),
    secret: mailboxExternalOAuthSecret("synthetic-refresh-token"),
    auth: "oauth_microsoft" as const,
  });

  it("refuses active or malformed operational profiles before redirect and callback provider calls", async () => {
    configure();
    const { startMailboxExternalOAuth, finishMailboxExternalOAuth, MAILBOX_EXTERNAL_OAUTH_COOKIE } =
      await import("../src/server/mailbox-external-oauth");
    // The same already-resolved context remains deliberately stale throughout.
    context = { db, session: { user: { id: "bia" } }, teamId: team, role: "member" };
    const start = () =>
      startMailboxExternalOAuth(
        new Request("https://mepmail.dev/api/mailboxes/external/oauth/microsoft/start"),
        "microsoft",
      );
    const exchange = vi.fn(
      async (): Promise<MailboxExternalOAuthGrant> => ({
        accessToken: "synthetic-access-token",
        refreshToken: "synthetic-refresh-token",
        expiresAt: new Date(Date.now() + 3_600_000),
        address: "bia@example.invalid",
        name: "Synthetic",
        consumer: true,
      }),
    );
    const check = vi.fn(async () => undefined);
    for (const profile of [
      operations,
      { ...operations, mailboxCreateDomainIds: [domain, domain] },
    ]) {
      await db.update(schema.teamMembers).set({ operationsAccess: null }).where(membership());
      const started = await start();
      const consent = new URL(started.headers.get("location")!);
      expect(consent.hostname).toBe("login.microsoftonline.com");
      const cookie = started.headers
        .get("set-cookie")!
        .match(new RegExp(`${MAILBOX_EXTERNAL_OAUTH_COOKIE}=([^;]+)`))![1]!;
      await db.update(schema.teamMembers).set({ operationsAccess: profile }).where(membership());

      const blockedStart = await start();
      const startLocation = new URL(blockedStart.headers.get("location")!);
      expect(startLocation.origin).toBe("https://mepmail.dev");
      expect(startLocation.searchParams.get("reason")).toBe("forbidden");
      expect(blockedStart.headers.get("set-cookie")).toBeNull();
      const callback = await finishMailboxExternalOAuth(
        new Request(
          `https://mepmail.dev/api/mailboxes/external/oauth/microsoft/callback?code=synthetic&state=${consent.searchParams.get("state")}`,
        ),
        "microsoft",
        cookie,
        { exchange, check },
      );
      expect(new URL(callback.headers.get("location")!).searchParams.get("reason")).toBe(
        "forbidden",
      );
      expect(callback.headers.get("set-cookie")).toMatch(/Max-Age=0/);
      expect(exchange).not.toHaveBeenCalled();
      expect(check).not.toHaveBeenCalled();
    }
    expect(await db.select().from(schema.mailboxes)).toEqual([]);
    expect(await db.select().from(schema.mailboxExternalAccounts)).toEqual([]);
  });

  it("guards direct core creation and reconnect while preserving ordinary member and foreign-owner rules", async () => {
    const { replaceMailboxExternalSecret: reconnectExternal } = await import(
      "../../../packages/core/src/mailbox-external-accounts.js"
    );
    const actor = { teamId: team, userId: "bia" };
    // An ordinary member can connect before any restricted profile is assigned.
    const { mailboxId } = await createMailboxExternalAccount(db, keys, actor, accountInput());
    const before = await db.select().from(schema.mailboxExternalAccounts);
    for (const profile of [
      operations,
      { ...operations, mailboxCreateDomainIds: [domain, domain] },
    ]) {
      await db.update(schema.teamMembers).set({ operationsAccess: profile }).where(membership());
      await expect(
        createMailboxExternalAccount(db, keys, actor, accountInput("second@example.invalid")),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        reconnectExternal(db, keys, actor, {
          mailboxId,
          secret: mailboxExternalOAuthSecret("synthetic-replacement"),
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(await db.select().from(schema.mailboxExternalAccounts)).toEqual(before);
      expect(await db.select({ id: schema.mailboxes.id }).from(schema.mailboxes)).toEqual([
        { id: mailboxId },
      ]);
    }
    await db.update(schema.teamMembers).set({ operationsAccess: null }).where(membership());
    await expect(
      reconnectExternal(
        db,
        keys,
        { teamId: team, userId: "ana" },
        { mailboxId, secret: mailboxExternalOAuthSecret("synthetic-foreign-owner") },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await db.select().from(schema.mailboxExternalAccounts)).toEqual(before);
    await reconnectExternal(db, keys, actor, {
      mailboxId,
      secret: mailboxExternalOAuthSecret("synthetic-normal-member-reconnect"),
    });
    const account = (await openMailboxExternalAccount(db, keys, mailboxId))!;
    expect(readMailboxExternalOAuthSecret(account.secret)).toBe(
      "synthetic-normal-member-reconnect",
    );
  });

  it("preserves normal OAuth access in the person's own other team", async () => {
    configure();
    await db.update(schema.teamMembers).set({ operationsAccess: operations }).where(membership());
    const [own] = await db
      .insert(schema.teams)
      .values({ name: "Synthetic own team", slug: "synthetic-own-team" })
      .returning();
    await db.insert(schema.teamMembers).values({ teamId: own!.id, userId: "bia", role: "owner" });
    context = { db, session: { user: { id: "bia" } }, teamId: own!.id, role: "owner" };
    const { startMailboxExternalOAuth, finishMailboxExternalOAuth, MAILBOX_EXTERNAL_OAUTH_COOKIE } =
      await import("../src/server/mailbox-external-oauth");
    const started = await startMailboxExternalOAuth(
      new Request("https://mepmail.dev/api/mailboxes/external/oauth/microsoft/start"),
      "microsoft",
    );
    const consent = new URL(started.headers.get("location")!);
    expect(consent.hostname).toBe("login.microsoftonline.com");
    const cookie = started.headers
      .get("set-cookie")!
      .match(new RegExp(`${MAILBOX_EXTERNAL_OAUTH_COOKIE}=([^;]+)`))![1]!;
    const exchange = vi.fn(
      async (): Promise<MailboxExternalOAuthGrant> => ({
        accessToken: "synthetic-own-access-token",
        refreshToken: "synthetic-own-refresh-token",
        expiresAt: new Date(Date.now() + 3_600_000),
        address: "bia@example.invalid",
        name: "Synthetic",
        consumer: true,
      }),
    );
    const check = vi.fn(async () => undefined);
    const done = await finishMailboxExternalOAuth(
      new Request(
        `https://mepmail.dev/api/mailboxes/external/oauth/microsoft/callback?code=synthetic&state=${consent.searchParams.get("state")}`,
      ),
      "microsoft",
      cookie,
      { exchange, check },
    );
    const landed = new URL(done.headers.get("location")!);
    expect(landed.searchParams.get("external")).toBe("connected");
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(1);
    const [box] = await db
      .select({ teamId: schema.mailboxes.teamId, ownerUserId: schema.mailboxes.ownerUserId })
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.id, landed.searchParams.get("mailbox")!));
    expect(box).toEqual({ teamId: own!.id, ownerUserId: "bia" });
  });

  it("trades the refresh token for an access token, seals a rotated one, caches the rest", async () => {
    const { mailboxId } = await createMailboxExternalAccount(
      db,
      keys,
      { teamId: team, userId: "ana" },
      {
        address: "ana@outlook.com",
        label: "Ana",
        servers: mailboxExternalOAuthServers("microsoft", {
          address: "ana@outlook.com",
          consumer: true,
        }),
        secret: mailboxExternalOAuthSecret("rt-1"),
        auth: "oauth_microsoft",
      },
    );
    let calls = 0;
    const refresh = (async (_provider: string, token: string) => {
      calls++;
      expect(token).toBe("rt-1");
      return {
        accessToken: "at-1",
        refreshToken: "rt-2",
        expiresAt: new Date(Date.now() + 3_600_000),
      };
    }) as typeof refreshMailboxExternalOAuthToken;
    const account = (await openMailboxExternalAccount(db, keys, mailboxId))!;
    expect(account.auth).toBe("oauth_microsoft");
    expect(await mailboxExternalCredential(db, keys, account, refresh)).toEqual({
      accessToken: "at-1",
    });
    const reopened = (await openMailboxExternalAccount(db, keys, mailboxId))!;
    expect(readMailboxExternalOAuthSecret(reopened.secret)).toBe("rt-2");
    // The cached token answers while it is fresh and tied to the stored refresh token.
    expect(await mailboxExternalCredential(db, keys, reopened, refresh)).toEqual({
      accessToken: "at-1",
    });
    expect(calls).toBe(1);
    const revoked = (async () => {
      throw new MailboxExternalOAuthError("invalid_grant");
    }) as typeof refreshMailboxExternalOAuthToken;
    await expect(
      mailboxExternalCredential(
        db,
        keys,
        { ...reopened, secret: mailboxExternalOAuthSecret("rt-9") },
        revoked,
      ),
    ).rejects.toMatchObject({ reason: "invalid_grant" });
    expect(
      await mailboxExternalCredential(db, keys, { ...reopened, auth: "password", secret: "pw" }),
    ).toEqual({ password: "pw" });
  });

  it("connects through the callback only with its own state cookie, then signs in again", async () => {
    configure();
    const { startMailboxExternalOAuth, finishMailboxExternalOAuth, MAILBOX_EXTERNAL_OAUTH_COOKIE } =
      await import("../src/server/mailbox-external-oauth");
    context = { db, session: { user: { id: "ana" } }, teamId: team, role: "owner" };
    const started = await startMailboxExternalOAuth(
      new Request("https://mepmail.dev/api/mailboxes/external/oauth/microsoft/start?return=/mail"),
      "microsoft",
    );
    expect(started.status).toBe(303);
    const consent = new URL(started.headers.get("location")!);
    expect(consent.hostname).toBe("login.microsoftonline.com");
    const state = consent.searchParams.get("state")!;
    const cookie = started.headers
      .get("set-cookie")!
      .match(new RegExp(`${MAILBOX_EXTERNAL_OAUTH_COOKIE}=([^;]+)`))![1]!;
    expect(started.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(started.headers.get("set-cookie")).toMatch(/Path=\/api\/mailboxes\/external\/oauth/);

    const exchange = vi.fn(
      async (
        _provider: string,
        input: { codeVerifier: string },
      ): Promise<MailboxExternalOAuthGrant> => {
        // The verifier behind the challenge sent to Microsoft.
        expect(createHash("sha256").update(input.codeVerifier).digest("base64url")).toBe(
          consent.searchParams.get("code_challenge"),
        );
        return {
          accessToken: "at",
          refreshToken: "rt-1",
          expiresAt: new Date(Date.now() + 3_600_000),
          address: "ana@outlook.com",
          name: "Ana Souza",
          consumer: true,
        };
      },
    );
    const check = vi.fn(async () => undefined);
    const callback = (query: string) =>
      new Request(`https://mepmail.dev/api/mailboxes/external/oauth/microsoft/callback?${query}`);

    // A forged state, a missing cookie and another person never connect anything.
    const forged = await finishMailboxExternalOAuth(
      callback(`code=c&state=other`),
      "microsoft",
      cookie,
      { exchange, check },
    );
    expect(new URL(forged.headers.get("location")!).searchParams.get("reason")).toBe("expired");
    const noCookie = await finishMailboxExternalOAuth(
      callback(`code=c&state=${state}`),
      "microsoft",
      undefined,
      { exchange, check },
    );
    expect(new URL(noCookie.headers.get("location")!).searchParams.get("reason")).toBe("expired");
    context = { db, session: { user: { id: "bia" } }, teamId: team, role: "member" };
    const stranger = await finishMailboxExternalOAuth(
      callback(`code=c&state=${state}`),
      "microsoft",
      cookie,
      { exchange, check },
    );
    expect(new URL(stranger.headers.get("location")!).searchParams.get("reason")).toBe("forbidden");
    expect(exchange).not.toHaveBeenCalled();

    context = { db, session: { user: { id: "ana" } }, teamId: team, role: "owner" };
    const done = await finishMailboxExternalOAuth(
      callback(`code=c&state=${state}`),
      "microsoft",
      cookie,
      { exchange, check },
    );
    const landed = new URL(done.headers.get("location")!);
    expect(landed.pathname).toBe("/mail");
    expect(landed.searchParams.get("external")).toBe("connected");
    expect(done.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ imapHost: "outlook.office365.com", username: "ana@outlook.com" }),
      { accessToken: "at" },
    );
    const mailboxId = landed.searchParams.get("mailbox")!;
    const account = (await openMailboxExternalAccount(db, keys, mailboxId))!;
    expect(account).toMatchObject({ auth: "oauth_microsoft", address: "ana@outlook.com" });
    expect(readMailboxExternalOAuthSecret(account.secret)).toBe("rt-1");
    const [box] = await db
      .select()
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.id, mailboxId));
    expect(box).toMatchObject({ origin: "external", label: "Ana Souza", ownerUserId: "ana" });

    // "Entrar de novo": the same address replaces the refresh token; another is refused.
    const again = await startMailboxExternalOAuth(
      new Request(
        `https://mepmail.dev/api/mailboxes/external/oauth/microsoft/start?mailbox=${mailboxId}`,
      ),
      "microsoft",
    );
    const againState = new URL(again.headers.get("location")!).searchParams.get("state")!;
    const againCookie = again.headers
      .get("set-cookie")!
      .match(new RegExp(`${MAILBOX_EXTERNAL_OAUTH_COOKIE}=([^;]+)`))![1]!;
    exchange.mockResolvedValueOnce({
      accessToken: "at",
      refreshToken: "rt-x",
      expiresAt: new Date(Date.now() + 3_600_000),
      address: "someone@outlook.com",
      name: null,
      consumer: true,
    });
    const wrong = await finishMailboxExternalOAuth(
      callback(`code=c&state=${againState}`),
      "microsoft",
      againCookie,
      { exchange, check },
    );
    expect(new URL(wrong.headers.get("location")!).searchParams.get("reason")).toBe(
      "other_account",
    );
    exchange.mockResolvedValueOnce({
      accessToken: "at",
      refreshToken: "rt-2",
      expiresAt: new Date(Date.now() + 3_600_000),
      address: "ana@outlook.com",
      name: null,
      consumer: true,
    });
    const reconnected = await finishMailboxExternalOAuth(
      callback(`code=c&state=${againState}`),
      "microsoft",
      againCookie,
      { exchange, check },
    );
    expect(new URL(reconnected.headers.get("location")!).searchParams.get("external")).toBe(
      "reconnected",
    );
    const after = (await openMailboxExternalAccount(db, keys, mailboxId))!;
    expect(readMailboxExternalOAuthSecret(after.secret)).toBe("rt-2");

    // The person said no at Microsoft: back to the Correio, nothing to explain.
    const cancelled = await finishMailboxExternalOAuth(
      callback(`error=access_denied&state=${againState}`),
      "microsoft",
      againCookie,
      { exchange, check },
    );
    expect(new URL(cancelled.headers.get("location")!).searchParams.get("reason")).toBe(
      "cancelled",
    );
  });
});
