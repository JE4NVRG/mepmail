import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  session: { user: { id: "user-a" } } as { user: { id: string } } | null,
  activeCookie: "stale-cookie",
  view: null as { teamId: string } | null,
  membership: { teamId: "effective-team" },
  locale: "pt-BR",
  membershipRead: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => ({ value: name === "active-team" ? state.activeCookie : "view-cookie" }),
  }),
}));
vi.mock("next-intl/server", () => ({ getLocale: async () => state.locale }));
vi.mock("@millionsend/db", () => ({ getDb: () => ({}) }));
vi.mock("@/server/auth", () => ({
  getAuth: () => ({ api: { getSession: async () => state.session } }),
}));
vi.mock("@/server/membership", () => ({
  ACTIVE_TEAM_COOKIE: "active-team",
  getActiveMembership: async (...args: unknown[]) => {
    state.membershipRead(...args);
    return state.membership;
  },
}));
vi.mock("@/server/support-view", () => ({
  SUPPORT_VIEW_COOKIE: "support-view",
  resolveSupportView: async () => state.view,
}));
vi.mock("@/app/(dashboard)/templates/editor", () => ({ TemplateEditor: () => null }));
vi.mock("@/app/(dashboard)/templates/new/starter-gallery", () => ({ StarterGallery: () => null }));
const { default: page } = await import("@/app/(dashboard)/templates/new/page");

describe("public template intent", () => {
  beforeEach(() => {
    state.session = { user: { id: "user-a" } };
    state.view = null;
    state.membershipRead.mockClear();
  });
  it("prefills an unsaved editor, scoped by resolved team and user", async () => {
    const result = await page({ searchParams: Promise.resolve({ starter: "welcome" }) });
    expect(result.props.starter.name).toBe("Boas-vindas");
    expect(result.props.initial).toBeUndefined();
    expect(result.props.draftKey).toBe("user-a:effective-team:welcome:pt-BR");
    expect(result.props.draftKey).not.toContain("stale-cookie");
  });
  it("uses the effective support team without reading the user's membership", async () => {
    state.view = { teamId: "support-team" };
    const result = await page({ searchParams: Promise.resolve({ starter: "welcome" }) });
    expect(result.props.draftKey).toBe("user-a:support-team:welcome:pt-BR");
    expect(state.membershipRead).not.toHaveBeenCalled();
  });
  it("does not turn an unknown key or repeated query into an editor", async () => {
    for (const starter of ["missing", ["welcome", "welcome"]]) {
      const result = await page({ searchParams: Promise.resolve({ starter }) });
      expect(result.props.starter).toBeUndefined();
    }
  });
  it("does not prefill a draft for an anonymous visitor", async () => {
    state.session = null;
    const result = await page({ searchParams: Promise.resolve({ starter: "welcome" }) });
    expect(result.props.starter).toBeUndefined();
  });
});
