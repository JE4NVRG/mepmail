import { beforeEach, describe, expect, it, vi } from "vitest";
import PostLoginPage from "@/app/post-login/page";
import { POST_LOGIN_PATH, postAuthNext, withNext } from "@/lib/nav";

const h = vi.hoisted(() => ({
  session: null as unknown,
  membership: null as unknown,
  live: null as unknown,
  db: {},
  active: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("@millionsend/core", async () => ({
  parseOperationsAccess: (await import("../../../packages/core/src/operations-access"))
    .parseOperationsAccess,
}));
vi.mock("@millionsend/db", () => ({ getDb: () => h.db }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => ({ value: "selected-team" }) }),
}));
vi.mock("next/navigation", () => ({
  redirect: (location: string) => {
    throw { location };
  },
}));
vi.mock("@/server/auth", () => ({
  getAuth: () => ({ api: { getSession: async () => h.session } }),
}));
vi.mock("@/server/membership", () => ({
  ACTIVE_TEAM_COOKIE: "fixture-team",
  getActiveMembership: (...args: unknown[]) => {
    h.active(...args);
    return Promise.resolve(h.membership);
  },
}));
vi.mock("@/server/request-membership", () => ({
  resolveRequestMembership: (...args: unknown[]) => {
    h.resolve(...args);
    return Promise.resolve(h.live);
  },
}));

const access = { version: 1, userDirectoryRead: true, mailboxCreateDomainIds: [] };
const page = (next?: unknown) =>
  PostLoginPage({ searchParams: Promise.resolve({ next } as { next?: string | string[] }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.session = { user: { id: "fixture-user" } };
  h.membership = { teamId: "resolved-team", role: "owner" };
  h.live = { role: "member", operationsAccess: null, verified: true, suspendedAt: null };
});

describe("shared server post-login destination", () => {
  it.each(["owner", "admin", "member"])(
    "keeps ordinary %s on the existing email default",
    async (role) => {
      h.live = { role, operationsAccess: null, verified: true, suspendedAt: null };
      await expect(page()).rejects.toEqual({ location: "/emails" });
    },
  );

  it("resolves the selection cookie against membership and the live profile, not a stale owner role", async () => {
    h.live = { role: "member", operationsAccess: access, verified: true, suspendedAt: null };
    await expect(page()).rejects.toEqual({ location: "/operations/users" });
    expect(h.active).toHaveBeenCalledWith(h.db, "fixture-user", "selected-team");
    expect(h.resolve).toHaveBeenCalledWith({
      db: h.db,
      session: h.session,
      teamId: "resolved-team",
    });
  });

  it.each([
    {
      role: "member",
      operationsAccess: { ...access, userDirectoryRead: false },
      verified: true,
      suspendedAt: null,
    },
    { role: "member", operationsAccess: { version: 99 }, verified: true, suspendedAt: null },
    { role: "member", operationsAccess: access, verified: false, suspendedAt: null },
    { role: "member", operationsAccess: access, verified: true, suspendedAt: new Date(0) },
    { role: "admin", operationsAccess: access, verified: true, suspendedAt: null },
  ])(
    "never directs an invalid or directory-less restricted profile to the directory or console: %j",
    async (live) => {
      h.live = live;
      await expect(page()).rejects.toEqual({ location: "/mail" });
    },
  );

  it("onboards an account without a team", async () => {
    h.membership = null;
    await expect(page()).rejects.toEqual({ location: "/onboarding" });
    expect(h.resolve).not.toHaveBeenCalled();
  });

  it("does not trust a membership revoked between resolution and the live check", async () => {
    h.live = null;
    await expect(page()).rejects.toEqual({ location: "/onboarding" });
  });

  it.each([
    "/invite/signed-token",
    "/oauth/consent?client_id=fixture&state=opaque",
    "/templates/new?starter=welcome#edit",
    "/onboarding",
  ])(
    "preserves explicit authenticated targets, including before a first team exists: %s",
    async (next) => {
      h.membership = null;
      await expect(page(next)).rejects.toEqual({ location: next });
      expect(h.active).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://outside.invalid",
    "//outside.invalid",
    "/\\outside.invalid",
    "/api/auth/sign-out",
    "/%61pi/auth/sign-out",
    "/login",
    "/post-login?next=/emails",
    "/%70ost-login",
    ["/mail", "/emails"],
  ])("rejects unsafe/ambiguous/looping next values: %j", async (next) => {
    await expect(page(next)).rejects.toEqual({ location: "/emails" });
  });

  it("requires a real session before resolving a default or honoring an explicit destination", async () => {
    h.session = null;
    await expect(page()).rejects.toEqual({ location: "/login" });
    await expect(page("/invite/signed-token")).rejects.toEqual({
      location: "/login?next=%2Finvite%2Fsigned-token",
    });
    expect(h.active).not.toHaveBeenCalled();
  });

  it("keeps the same validated deep link through login and first-team onboarding", () => {
    const deepLink = "/settings/mcp?tab=tools#connect";
    expect(postAuthNext(deepLink, POST_LOGIN_PATH)).toBe(deepLink);
    expect(withNext("/login", deepLink)).toBe(
      "/login?next=%2Fsettings%2Fmcp%3Ftab%3Dtools%23connect",
    );
    expect(withNext("/onboarding", deepLink)).toBe(
      "/onboarding?next=%2Fsettings%2Fmcp%3Ftab%3Dtools%23connect",
    );
    expect(postAuthNext(null, POST_LOGIN_PATH)).toBe(POST_LOGIN_PATH);
  });
});
