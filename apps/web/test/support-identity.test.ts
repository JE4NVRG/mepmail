import { createHmac } from "node:crypto";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEloziSupportSession,
  ELOZI_IDENTITY_ENDPOINT,
  fetchEloziIdentity,
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
        v: 2,
        accountId: "team_1",
        sub: "user_1",
        email: "ana@example.com",
        email_verified: true,
        name: "Ana",
        locale: "pt-BR",
        ctx: {
          teamId: "team_1",
          teamName: "Acme",
          plan: "pro+correio",
          mailboxes: 2,
          accountName: "Acme",
          product: "mepmail",
        },
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
      v: 2,
      accountId: "team_1",
      sub: "user_1",
      email: "ana@example.com",
      ctx: {
        teamId: "team_1",
        teamName: "Acme",
        plan: "pro+correio",
        mailboxes: 2,
        accountName: "Acme",
        product: "mepmail",
      },
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
      v: 2,
      accountId: teamId,
      sub: "u_support",
      email: "ana@acme.test",
      email_verified: true,
      name: "Ana Souza",
      locale: "en",
      ctx: {
        teamId,
        teamName: "acme-support",
        plan: "free",
        mailboxes: 0,
        accountName: "acme-support",
        product: "mepmail",
      },
    });
  });

  it("keeps the same user separate on two memberships and rejects an unavailable selection", async () => {
    const a = await createTeam(db, "account-a");
    const b = await createTeam(db, "account-b");
    const foreign = await createTeam(db, "foreign-account");
    const user = {
      id: "multi_support",
      name: "Ana",
      email: "ana@example.test",
      emailVerified: true,
    };
    await db.insert(schema.user).values(user);
    await db.insert(schema.teamMembers).values([
      { teamId: a, userId: user.id, role: "owner" },
      { teamId: b, userId: user.id, role: "member" },
    ]);
    const left = await supportIdentityClaims(db, user, "pt-BR", a);
    const right = await supportIdentityClaims(db, user, "pt-BR", b);
    expect(left?.sub).toBe(right?.sub);
    expect(left?.accountId).toBe(a);
    expect(right?.accountId).toBe(b);
    expect(await supportIdentityClaims(db, user, "pt-BR", foreign)).toBeNull();
    expect(await supportIdentityClaims(db, user, "pt-BR", "")).toBeNull();
    await db
      .delete(schema.teamMembers)
      .where(
        (await import("drizzle-orm")).and(
          (await import("drizzle-orm")).eq(schema.teamMembers.userId, user.id),
          (await import("drizzle-orm")).eq(schema.teamMembers.teamId, b),
        ),
      );
    expect(await supportIdentityClaims(db, user, "pt-BR", b)).toBeNull();
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

  it("requires an identity response from the same-origin endpoint", async () => {
    const identity = { accountId: "team_1", userId: "user_1" };
    const ok = vi.fn(async () => Response.json({ token: "a.b.c", identity }));
    expect(await fetchEloziIdentityToken(ok as unknown as typeof fetch)).toBe("a.b.c");
    expect(ok).toHaveBeenCalledWith(ELOZI_IDENTITY_ENDPOINT, {
      credentials: "same-origin",
      cache: "no-store",
    });
    await fetchEloziIdentity(identity, ok as unknown as typeof fetch);
    expect(ok).toHaveBeenLastCalledWith(
      `${ELOZI_IDENTITY_ENDPOINT}?accountId=team_1&userId=user_1`,
      {
        credentials: "same-origin",
        cache: "no-store",
      },
    );
    for (const code of [401, 403, 409, 503]) {
      await expect(
        fetchEloziIdentityToken(async () => new Response(null, { status: code })),
      ).rejects.toThrow();
    }
    await expect(
      fetchEloziIdentityToken(async () => {
        throw new TypeError("offline");
      }),
    ).rejects.toThrow();
    await expect(
      fetchEloziIdentity(identity, async () =>
        Response.json({
          token: "a.b.c",
          identity: { ...identity, accountId: "another" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("hands a verified account/user to the SaaS manager and destroys it on leaving", async () => {
    const identity = { accountId: "team_1", userId: "user_1" };
    const widget = { open: vi.fn(), destroy: vi.fn(), setAccount: vi.fn() };
    const module = { createSaasWebchat: vi.fn((_options: Record<string, unknown>) => widget) };
    const provider = vi.fn(async () => ({ token: "a.b.c", identity }));
    const config = { tenantId: "fixture_tenant", channelId: "fixture_channel" };
    const session = createEloziSupportSession(config, vi.fn(), async () => module, provider);
    expect(await session.open()).toBe(true);
    const options = module.createSaasWebchat.mock.calls[0]?.[0];
    expect(options).toMatchObject({ identity });
    const getToken = options?.getIdentityToken as (expected: typeof identity) => Promise<string>;
    expect(await getToken(identity)).toBe("a.b.c");
    expect(provider).toHaveBeenLastCalledWith(identity);
    provider.mockResolvedValueOnce({
      token: "other.b.c",
      identity: { ...identity, accountId: "team_2" },
    });
    expect(await session.reconcile()).toBe(true);
    expect(widget.setAccount).toHaveBeenLastCalledWith({ accountId: "team_2", userId: "user_1" });
    provider.mockRejectedValueOnce(new Error("signed out"));
    expect(await session.reconcile()).toBe(false);
    expect(widget.setAccount).toHaveBeenLastCalledWith(null);
    session.destroy();
    expect(widget.destroy).toHaveBeenCalledTimes(1);
  });

  it("does not mount an anonymous widget when signed-in identity fails", async () => {
    const module = { createWebchatWidget: vi.fn(), createSaasWebchat: vi.fn() };
    const status = vi.fn();
    const session = createEloziSupportSession(
      { tenantId: "fixture_tenant", channelId: "fixture_channel" },
      status,
      async () => module,
      async () => {
        throw new Error("unconfigured");
      },
    );
    expect(await session.open()).toBe(false);
    expect(module.createWebchatWidget).not.toHaveBeenCalled();
    expect(module.createSaasWebchat).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith("error");
  });
});
