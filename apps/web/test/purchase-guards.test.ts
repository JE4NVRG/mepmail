import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardLayout from "../src/app/(dashboard)/layout";
import LoginPage from "../src/app/login/page";
import OnboardingPage from "../src/app/onboarding/page";
import SignupPage from "../src/app/signup/page";
import VerifyEmailPage from "../src/app/verify-email/page";

const h = vi.hoisted(() => ({
  session: true,
  team: false,
  next: "/settings/billing?rung=pro_200k",
}));
vi.mock("@millionsend/db", async (original) => ({
  ...(await original<typeof import("@millionsend/db")>()),
  getDb: () => ({}),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-mepmail-next": h.next }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/server/auth", () => ({
  getAuth: () => ({
    api: {
      getSession: async () =>
        h.session ? { user: { id: "fixture", email: "fixture@example.invalid" } } : null,
    },
  }),
  hasSession: async () => h.session,
  enabledSocialProviders: () => ({}),
}));
vi.mock("@/server/membership", () => ({
  ACTIVE_TEAM_COOKIE: "team",
  getActiveMembership: async () => (h.team ? { teamName: "Testes QA" } : null),
}));
vi.mock("@/server/support-view", () => ({
  SUPPORT_VIEW_COOKIE: "support",
  resolveSupportView: async () => null,
}));
vi.mock("@/server/storage", () => ({ uploadsEnabled: () => false }));
vi.mock("@/server/system-mail", () => ({ passwordRecoveryEnabled: () => true }));
vi.mock("@/components/app-shell", () => ({ AppShell: () => null }));
vi.mock("@/components/confirm-dialog", () => ({ ConfirmDialogHost: () => null }));
vi.mock("@/components/deliverability-banner", () => ({ DeliverabilityBanner: () => null }));
vi.mock("@/components/events-health-banner", () => ({ EventsHealthBanner: () => null }));
vi.mock("@/components/region-breaker-banner", () => ({ RegionBreakerBanner: () => null }));
vi.mock("@/components/support-view-banner", () => ({ SupportViewBanner: () => null }));
vi.mock("@/components/team-standing-banner", () => ({ TeamStandingBanner: () => null }));
vi.mock("@/components/toast", () => ({ ToastHost: () => null }));
vi.mock("@/components/auth/auth-form", () => ({ AuthForm: () => null }));
vi.mock("../src/app/onboarding/onboarding-form", () => ({ OnboardingForm: () => null }));
vi.mock("../src/app/onboarding/onboarding-steps", () => ({ OnboardingSteps: () => null }));

beforeEach(() => {
  h.session = true;
  h.team = false;
});
const props = (next: unknown = h.next) => ({
  searchParams: Promise.resolve({ next: next as string }),
});

describe("purchase guards with synthetic session/team, no database", () => {
  it("unauthenticated dashboard preserves the exact requested offer", async () => {
    h.session = false;
    await expect(DashboardLayout({ children: null })).rejects.toThrow(
      `REDIRECT /login?next=${encodeURIComponent(h.next)}`,
    );
  });
  it("team-less dashboard preserves offer through onboarding", async () => {
    await expect(DashboardLayout({ children: null })).rejects.toThrow(
      `REDIRECT /onboarding?next=${encodeURIComponent(h.next)}`,
    );
    expect(await OnboardingPage(props())).toBeTruthy();
    h.team = true;
    await expect(OnboardingPage(props())).rejects.toThrow(`REDIRECT ${h.next}`);
  });
  it("existing team renders dashboard without another redirect", async () => {
    h.team = true;
    expect(await DashboardLayout({ children: "sentinel" })).toBeTruthy();
  });
  it("general onboarding keeps the normal activation steps", async () => {
    h.team = true;
    expect(await OnboardingPage(props(null))).toBeTruthy();
  });
  it("onboarding without session preserves login return, without a cycle", async () => {
    h.session = false;
    await expect(OnboardingPage(props())).rejects.toThrow(
      `REDIRECT /login?next=${encodeURIComponent(h.next)}`,
    );
  });
  it.each([LoginPage, SignupPage, VerifyEmailPage])(
    "signed-in entry resumes safe offer",
    async (page) => {
      await expect(page(props())).rejects.toThrow(`REDIRECT ${h.next}`);
    },
  );
  it.each(["/onboarding?next=/onboarding", ["/settings/billing?rung=starter"], "//evil.invalid"])(
    "invalid onboarding target %j is ignored",
    async (next) => {
      h.team = true;
      expect(await OnboardingPage(props(next))).toBeTruthy();
    },
  );
});
