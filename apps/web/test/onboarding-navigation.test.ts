import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingForm } from "@/app/onboarding/onboarding-form";
import OnboardingPage from "@/app/onboarding/page";
import { AppShell } from "@/components/app-shell";
import { postAuthNext, withNext } from "@/lib/nav";

const h = vi.hoisted(() => ({
  session: null as unknown,
  membership: null as unknown,
  redirect: vi.fn(),
}));
vi.mock("@millionsend/config", () => ({ env: { IS_CLOUD: true, TURNSTILE_SITE_KEY: null } }));
vi.mock("@millionsend/db", () => ({ getDb: () => ({}) }));
vi.mock("@/server/account-locale", () => ({ syncAccountMailLocale: async () => {} }));
vi.mock("next-intl/server", () => ({ getLocale: async () => "en" }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (location: string) => {
    h.redirect(location);
    throw { location };
  },
}));
vi.mock("@/server/auth", () => ({
  getAuth: () => ({ api: { getSession: async () => h.session } }),
}));
vi.mock("@/server/membership", () => ({
  ACTIVE_TEAM_COOKIE: "fixture-team",
  getActiveMembership: async () => h.membership,
}));
vi.mock("@/server/storage", () => ({ uploadsEnabled: () => false }));
vi.mock("@/lib/api-base-url", () => ({ apiBaseUrl: () => "http://localhost:3001" }));
vi.mock("@/components/app-shell", () => ({ AppShell: () => null }));
vi.mock("@/app/onboarding/onboarding-form", () => ({ OnboardingForm: () => null }));
vi.mock("@/app/onboarding/onboarding-steps", () => ({ OnboardingSteps: () => null }));

beforeEach(() => {
  h.session = null;
  h.membership = null;
  vi.clearAllMocks();
});
const page = (next?: string | string[]) =>
  OnboardingPage({ searchParams: Promise.resolve(next === undefined ? {} : { next }) });

describe("onboarding return navigation", () => {
  it("carries an internal destination through login before creating a team", async () => {
    await expect(page("/settings/mcp?tab=tools")).rejects.toEqual({
      location: "/login?next=%2Fsettings%2Fmcp%3Ftab%3Dtools",
    });
  });
  it("shows team creation while membership is missing and preserves the current next URL", async () => {
    h.session = { user: { id: "fixture-user", email: "ada@example.com" } };
    expect((await page("/settings/mcp")).type).toBe(OnboardingForm);
    expect(h.redirect).not.toHaveBeenCalled();
  });
  it("returns a member to the validated destination", async () => {
    h.session = { user: { id: "fixture-user", email: "ada@example.com" } };
    h.membership = { teamName: "Fixture", logoUrl: null };
    await expect(page("/settings/mcp")).rejects.toEqual({ location: "/settings/mcp" });
  });
  it("keeps a member in the onboarding journey for invalid or missing destinations", async () => {
    h.session = { user: { id: "fixture-user", email: "ada@example.com" } };
    h.membership = { teamName: "Fixture", logoUrl: null };
    for (const next of [
      undefined,
      "//evil.example",
      "/onboarding",
      "/api/auth/sign-out",
      ["/emails", "/domains"],
    ]) {
      expect((await page(next)).type).toBe(AppShell);
    }
    expect(h.redirect).not.toHaveBeenCalled();
  });
  it("sends unauthenticated invalid destinations to a plain login", async () => {
    for (const next of ["//evil.example", "/login", "/api/auth/sign-out", "/%61pi/auth/sign-out"]) {
      await expect(page(next)).rejects.toEqual({ location: "/login" });
    }
  });
});

describe("post-auth destination guard", () => {
  it("rejects external, encoded, auth-cycle and endpoint targets", () => {
    for (const next of [
      "//evil.example",
      "/\\evil.example",
      "/\t//evil.example",
      "/login",
      "/signup/extra",
      "/forgot-password",
      "/reset-password",
      "/verify-email",
      "/onboarding?next=/emails",
      "/api",
      "/api/auth/sign-out",
      "/%61pi/auth/sign-out",
      "/%2f%2fevil.example",
      "/%5cevil.example",
      "/%ZZ",
      ["/emails"],
      null,
      123,
    ]) {
      expect(postAuthNext(next, "")).toBe("");
      expect(withNext("/onboarding", next)).toBe("/onboarding");
    }
  });
  it("retains internal query/hash and allows only the explicit signup onboarding destination", () => {
    expect(postAuthNext("/settings/mcp?tab=tools#connect")).toBe("/settings/mcp?tab=tools#connect");
    expect(withNext("/onboarding", "/settings/mcp")).toBe("/onboarding?next=%2Fsettings%2Fmcp");
    expect(withNext("/login", "/onboarding")).toBe("/login?next=%2Fonboarding");
    expect(withNext("/onboarding", "/onboarding")).toBe("/onboarding");
  });
});
