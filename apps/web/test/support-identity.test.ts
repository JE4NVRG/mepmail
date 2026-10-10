import { createHmac } from "node:crypto";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEloziSupportSession,
  ELOZI_IDENTITY_ENDPOINT,
  fetchEloziIdentityToken,
} from "@/lib/elozi-support";
import { openSupportChat, SUPPORT_CHAT_PATH } from "@/lib/support-chat";
import {
  eloziIdentityKey,
  signEloziIdentity,
  supportIdentityClaims,
} from "@/server/support-identity";

const KEY = { secret: "s".repeat(24) + "-literal-utf8-secret-0123456789", kid: "kid_2026_10" };
const CHANNEL = "6376dfa3-1def-441e-bb46-e9d99fb64d4b";
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("Elozi verified identity", () => {
  it("signs HS256 with the literal secret, the kid header and a 10-minute expiry", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    const token = signEloziIdentity(
      {
        sub: "user_1",
        email: "ana@example.com",
        email_verified: true,
        name: "Ana",
        locale: "pt-BR",
        ctx: { teamId: "team_1", teamName: "Acme", plan: "pro+correio", mailboxes: 2 },
      },
      KEY,
      CHANNEL,
      now,
    );
    const [header, payload, signature] = token.split(".");
    expect(decode(header ?? "")).toEqual({ alg: "HS256", typ: "JWT", kid: "kid_2026_10" });
    const claims = decode(payload ?? "");
    expect(claims).toMatchObject({
      iss: "https://mepmail.dev",
      aud: `elozi:webchat:${CHANNEL}`,
      sub: "user_1",
      email: "ana@example.com",
      ctx: { teamId: "team_1", teamName: "Acme", plan: "pro+correio", mailboxes: 2 },
    });
    expect(claims.exp - claims.iat).toBe(600);
    expect(claims.iat).toBe(Math.floor(now.getTime() / 1000));
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
    const expected = createHmac("sha256", Buffer.from(KEY.secret, "utf8"))
      .update(`${header}.${payload}`)
      .digest("base64url");
    expect(signature).toBe(expected);
    // Every token is single-use for Elozi: a fresh jti each time.
    const again = decode(
      signEloziIdentity(decode(payload ?? ""), KEY, CHANNEL, now).split(".")[1] ?? "",
    );
    expect(again.jti).not.toBe(claims.jti);
  });

  it("is off without a usable key", () => {
    expect(eloziIdentityKey({})).toBeNull();
    expect(
      eloziIdentityKey({ ELOZI_IDENTITY_SECRET: "short", ELOZI_IDENTITY_KID: "k" }),
    ).toBeNull();
    expect(
      eloziIdentityKey({ ELOZI_IDENTITY_SECRET: KEY.secret, ELOZI_IDENTITY_KID: "bad kid" }),
    ).toBeNull();
    expect(
      eloziIdentityKey({ ELOZI_IDENTITY_SECRET: KEY.secret, ELOZI_IDENTITY_KID: KEY.kid }),
    ).toEqual(KEY);
  });
});

describe("support identity claims", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ db, close } = await createTestDb());
  });
  afterEach(() => close());

  it("names the active team and its plan, and nothing about billing or content", async () => {
    const teamId = await createTeam(db, "acme-support");
    await db
      .insert(schema.user)
      .values({ id: "u_support", name: "Ana Souza", email: "ana@acme.test" });
    await db.insert(schema.teamMembers).values({ teamId, userId: "u_support", role: "owner" });
    const claims = await supportIdentityClaims(
      db,
      { id: "u_support", email: "ana@acme.test", name: "Ana Souza", emailVerified: true },
      "en",
    );
    expect(claims).toEqual({
      sub: "u_support",
      email: "ana@acme.test",
      email_verified: true,
      name: "Ana Souza",
      locale: "en",
      ctx: { teamId, teamName: "acme-support", plan: "free", mailboxes: 0 },
    });
  });

  it("returns nothing for a person without a team", async () => {
    await db.insert(schema.user).values({ id: "u_lonely", name: "Solo", email: "solo@acme.test" });
    expect(
      await supportIdentityClaims(
        db,
        { id: "u_lonely", email: "solo@acme.test", name: "Solo", emailVerified: false },
        "pt-BR",
      ),
    ).toBeNull();
  });
});

describe("support chat from the dashboard", () => {
  it("opens the chat window, or the same tab when a popup is blocked", () => {
    const focus = vi.fn();
    const open = vi.fn(() => ({ focus }) as unknown as Window);
    const assign = vi.fn();
    openSupportChat({ open, location: { assign } as unknown as Location });
    expect(open).toHaveBeenCalledWith(
      SUPPORT_CHAT_PATH,
      "mepmail-support",
      expect.stringContaining("width=440"),
    );
    expect(focus).toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    openSupportChat({ open: vi.fn(() => null), location: { assign } as unknown as Location });
    expect(assign).toHaveBeenCalledWith(SUPPORT_CHAT_PATH);
  });

  it("reads the token from the same-origin endpoint and falls back to the visitor flow", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ token: "a.b.c" })));
    expect(await fetchEloziIdentityToken(ok as unknown as typeof fetch)).toBe("a.b.c");
    expect(ok).toHaveBeenCalledWith(ELOZI_IDENTITY_ENDPOINT, {
      credentials: "same-origin",
      cache: "no-store",
    });
    const missing = vi.fn(async () => new Response(null, { status: 404 }));
    expect(await fetchEloziIdentityToken(missing as unknown as typeof fetch)).toBeNull();
    const broken = vi.fn(async () => Promise.reject(new TypeError("offline")));
    expect(await fetchEloziIdentityToken(broken as unknown as typeof fetch)).toBeNull();
  });

  it("hands the identity callback to the widget only when asked to", async () => {
    const widget = { open: vi.fn(), destroy: vi.fn() };
    const module = { createWebchatWidget: vi.fn((_options: Record<string, unknown>) => widget) };
    const identity = vi.fn(async () => "a.b.c");
    const config = { tenantId: "499f0367", channelId: CHANNEL };
    await createEloziSupportSession(config, vi.fn(), async () => module, identity).open();
    expect(module.createWebchatWidget).toHaveBeenCalledWith(
      expect.objectContaining({ getIdentityToken: identity }),
    );
    module.createWebchatWidget.mockClear();
    await createEloziSupportSession(config, vi.fn(), async () => module).open();
    expect(module.createWebchatWidget.mock.calls[0]?.[0]).not.toHaveProperty("getIdentityToken");
  });
});
