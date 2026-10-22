import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MailPage from "@/app/(mail)/mail/page";
import LoginPage from "@/app/login/page";
import OnboardingPage from "@/app/onboarding/page";
import SignupPage from "@/app/signup/page";
import VerifyEmailPage from "@/app/verify-email/page";
import { postAuthNext, withNext } from "@/lib/nav";
import { requestedMailboxPurchase, signupMailboxHref } from "@/lib/public-intent";

const h = vi.hoisted(() => ({ signedIn: false, hasTeam: false }));
vi.mock("@millionsend/config", () => ({
  env: { IS_CLOUD: true, TURNSTILE_SITE_KEY: null },
  signupOpen: () => true,
}));
vi.mock("@millionsend/db", () => ({ getDb: () => ({}) }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  redirect: (location: string) => {
    throw { location };
  },
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "pt-BR",
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/server/auth", () => ({
  hasSession: async () => h.signedIn,
  enabledSocialProviders: () => [],
  getAuth: () => ({
    api: {
      getSession: async () =>
        h.signedIn ? { user: { id: "fixture", email: "owner@example.test" } } : null,
    },
  }),
}));
vi.mock("@/server/membership", () => ({
  ACTIVE_TEAM_COOKIE: "fixture-team",
  getActiveMembership: async () => (h.hasTeam ? { teamName: "Fixture", logoUrl: null } : null),
}));
vi.mock("@/server/account-locale", () => ({ syncAccountMailLocale: async () => {} }));
vi.mock("@/server/public-seo", () => ({ publicPageUrls: async () => ({ alternates: {} }) }));
vi.mock("@/server/ses-pause", () => ({ accountMailDelayed: async () => false }));
vi.mock("@/server/system-mail", () => ({ passwordRecoveryEnabled: () => true }));
vi.mock("@/server/storage", () => ({ uploadsEnabled: () => false }));
vi.mock("@/server/mail-page-prefetch", () => ({ prefetchMailPage: async () => null }));
vi.mock("@/lib/api-base-url", () => ({ apiBaseUrl: () => "https://api.example.test" }));
vi.mock("@/components/auth/auth-form", () => ({ AuthForm: () => null }));
vi.mock("@/components/auth/auth-screen", () => ({ AuthScreen: () => null }));
vi.mock("@/components/app-shell", () => ({ AppShell: () => null }));
vi.mock("@/app/onboarding/onboarding-form", () => ({ OnboardingForm: () => null }));
vi.mock("@/app/onboarding/onboarding-steps", () => ({ OnboardingSteps: () => null }));
vi.mock("@/app/(dashboard)/mailboxes/mailboxes-view", () => ({ MailboxesView: () => null }));

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children as ReactNode)];
}
beforeEach(() => {
  h.signedIn = false;
  h.hasTeam = false;
});

describe("Correio intent across the real auth and onboarding route boundaries", () => {
  it.each(["solo", "duo", "equipe"] as const)(
    "retains %s through signup, verification, login, team creation and Mail",
    async (plan) => {
      const signup = new URL(signupMailboxHref(plan), "https://mepmail.test");
      const next = signup.searchParams.get("next");
      if (!next) throw new Error("Correio signup must retain its destination");
      const signupView = await SignupPage({
        searchParams: Promise.resolve({ next }),
      });
      expect(signupView.props.mode).toBe("signup");

      // AuthForm transports this validated target in its verifyCallback; exercise the
      // verification route itself and follow its actual sign-in link without creating a purchase.
      const target = postAuthNext(next, "/onboarding", true);
      const verified = await VerifyEmailPage({ searchParams: Promise.resolve({ next: target }) });
      const login = nodes(verified).find((node) => typeof node.props.href === "string");
      if (!login) throw new Error("Missing verification sign-in link");
      const loginUrl = new URL(String(login.props.href), "https://mepmail.test");
      expect(loginUrl.pathname).toBe("/login");
      expect(loginUrl.searchParams.get("next")).toBe(target);

      h.signedIn = true;
      for (const page of [LoginPage, SignupPage])
        await expect(page({ searchParams: Promise.resolve({ next: target }) })).rejects.toEqual({
          location: target,
        });
      const onboardingUrl = new URL(withNext("/onboarding", target), "https://mepmail.test");
      const onboardingNext = onboardingUrl.searchParams.get("next");
      if (!onboardingNext) throw new Error("Team creation must retain the Correio destination");
      const teamCreation = await OnboardingPage({
        searchParams: Promise.resolve({ next: onboardingNext }),
      });
      expect(teamCreation.props.logoUploadsEnabled).toBe(false);
      h.hasTeam = true;
      await expect(
        OnboardingPage({ searchParams: Promise.resolve({ next: onboardingNext }) }),
      ).rejects.toEqual({ location: target });

      const destination = new URL(target, "https://mepmail.test");
      const view = await MailPage({
        searchParams: Promise.resolve(Object.fromEntries(destination.searchParams)),
      });
      expect(view.props.purchaseIntent).toEqual({ plan });
      // A URL is only a plan hint: no price, checkout, payment method or entitlement is propagated.
      expect(Object.keys(view.props.purchaseIntent as object)).toEqual(["plan"]);
    },
  );

  it("keeps the free external-account route free of any purchase intent", async () => {
    const target = postAuthNext("/mail");
    expect(withNext("/onboarding", target)).toBe("/onboarding?next=%2Fmail");
    expect((await MailPage({ searchParams: Promise.resolve({}) })).props.purchaseIntent).toBeNull();
    expect(requestedMailboxPurchase({ plan: "equipe" })).toBeNull();
  });

  it("preserves invites and Send/combo destinations without converting them into Correio purchases", () => {
    for (const target of [
      "/invite/fixture",
      "/settings/billing?plan=pro_100k",
      "/settings/billing?correio=1",
    ])
      expect(postAuthNext(target, "/onboarding", true)).toBe(target);
    for (const next of [
      "//outside.example",
      "/\\outside.example",
      "/onboarding?next=/mail",
      "/api/auth/sign-out",
    ])
      expect(postAuthNext(next, "")).toBe("");
  });
});
