import { describe, expect, it, vi } from "vitest";

vi.mock("@millionsend/config", () => ({ env: {}, signupOpen: () => true }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/components/auth/auth-form", () => ({ AuthForm: vi.fn() }));
vi.mock("@/server/auth", () => ({ hasSession: async () => true, enabledSocialProviders: vi.fn() }));
vi.mock("@/server/public-seo", () => ({
  publicPageUrls: async (path: string) => ({ alternates: { canonical: path } }),
}));
vi.mock("@/server/ses-pause", () => ({ accountMailDelayed: vi.fn() }));
vi.mock("@/server/system-mail", () => ({ passwordRecoveryEnabled: vi.fn() }));

import LoginPage, { generateMetadata as loginMetadata } from "../src/app/login/page";
import SignupPage, { generateMetadata as signupMetadata } from "../src/app/signup/page";

describe.each([
  ["login", LoginPage],
  ["signup", SignupPage],
] as const)("signed-in %s return target", (_name, page) => {
  it("opens the selected template rather than discarding its query", async () => {
    await expect(
      page({ searchParams: Promise.resolve({ next: "/templates/new?starter=welcome" }) }),
    ).rejects.toThrow("redirect:/templates/new?starter=welcome");
  });

  it.each([
    { next: "https://outside.invalid" },
    { next: "/api/auth/sign-out" },
    { next: "/signup" },
    { next: ["/emails", "/templates"] },
  ])("rejects unsafe, looping or ambiguous destinations: $next", async ({ next }) => {
    await expect(page({ searchParams: Promise.resolve({ next }) })).rejects.toThrow(
      `redirect:${_name === "login" ? "/post-login" : "/"}`,
    );
  });
});

it("sends an already authenticated plain login to the server-resolved dashboard, not landing", async () => {
  await expect(LoginPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
    "redirect:/post-login",
  );
});

describe.each([
  ["/login", loginMetadata],
  ["/signup", signupMetadata],
] as const)("utility auth metadata: %s", (path, metadata) => {
  it("uses noindex/follow and the parameter-free canonical while return-target tests stay intact", async () => {
    const value = await metadata();
    expect(value.robots).toEqual({ index: false, follow: true });
    expect(value.alternates?.canonical).toBe(path);
  });
});
