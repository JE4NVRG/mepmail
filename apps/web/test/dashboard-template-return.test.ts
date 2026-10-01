import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  target: "/templates/new?starter=welcome",
  session: null as null | { user: { id: string } },
  membership: null as null | { teamName: string; logoUrl: null },
}));
vi.mock("@millionsend/config", () => ({ env: { UNSUBSCRIBE_BASE_URL: null } }));
vi.mock("@millionsend/db", () => ({ getDb: () => ({}) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-mepmail-next": h.target }),
  cookies: async () => ({ get: () => undefined }),
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
  ACTIVE_TEAM_COOKIE: "active-team",
  getActiveMembership: async () => h.membership,
}));
vi.mock("@/server/support-view", () => ({
  SUPPORT_VIEW_COOKIE: "support-view",
  resolveSupportView: async () => null,
}));
vi.mock("@/components/app-shell", () => ({ AppShell: () => null }));
vi.mock("@/components/confirm-dialog", () => ({ ConfirmDialogHost: () => null }));
vi.mock("@/components/deliverability-banner", () => ({ DeliverabilityBanner: () => null }));
vi.mock("@/components/events-health-banner", () => ({ EventsHealthBanner: () => null }));
vi.mock("@/components/region-breaker-banner", () => ({ RegionBreakerBanner: () => null }));
vi.mock("@/components/team-standing-banner", () => ({ TeamStandingBanner: () => null }));
vi.mock("@/components/support-view-banner", () => ({ SupportViewBanner: () => null }));
vi.mock("@/components/toast", () => ({ ToastHost: () => null }));
const { default: layout } = await import("@/app/(dashboard)/layout");
const { proxy } = await import("@/proxy");
beforeEach(() => {
  h.target = "/templates/new?starter=welcome";
  h.session = null;
  h.membership = null;
});
describe("template destination through authentication", () => {
  it("carries the requested starter through the login redirect", async () => {
    await expect(layout({ children: null })).rejects.toEqual({
      location: "/login?next=%2Ftemplates%2Fnew%3Fstarter%3Dwelcome",
    });
  });
  it("carries the starter through team creation for a new account", async () => {
    h.session = { user: { id: "u1" } };
    await expect(layout({ children: null })).rejects.toEqual({
      location: "/onboarding?next=%2Ftemplates%2Fnew%3Fstarter%3Dwelcome",
    });
  });
  it("rejects an external target", async () => {
    h.target = "//attacker.example";
    await expect(layout({ children: null })).rejects.toEqual({ location: "/login?next=%2Femails" });
  });
  it("overwrites a caller-supplied return header with the actual URL", () => {
    const response = proxy(
      new NextRequest("http://127.0.0.1:3186/templates/new?starter=welcome", {
        headers: { "x-mepmail-next": "//attacker.example" },
      }),
    );
    expect(response.headers.get("x-middleware-request-x-mepmail-next")).toBe(
      "/templates/new?starter=welcome",
    );
  });
});
