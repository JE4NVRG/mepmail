import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthForm } from "../src/components/auth/auth-form";
import { ForgotPasswordForm, ResetPasswordForm } from "../src/components/auth/recovery-forms";

// Harness sintético de hooks e cliente: testa handlers/estados, não OAuth ou backend real.
const h = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  params: new URLSearchParams(),
  push: vi.fn(),
  focus: vi.fn(),
  email: vi.fn(),
  signup: vi.fn(),
  social: vi.fn(),
  resend: vi.fn(),
  forgot: vi.fn(),
  reset: vi.fn(),
  token: vi.fn(),
  updates: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = h.cursor++;
    if (!(index in h.states)) h.states[index] = initial;
    return [
      h.states[index],
      (value: unknown) => {
        h.states[index] = typeof value === "function" ? value(h.states[index]) : value;
      },
    ];
  },
  useRef: () => ({ current: { focus: h.focus } }),
  useEffect: () => undefined,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.push }),
  useSearchParams: () => h.params,
}));
vi.mock("next-intl", () => ({
  useTranslations: (scope: string) =>
    Object.assign((key: string) => `${scope}.${key}`, { rich: (key: string) => `${scope}.${key}` }),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { email: h.email, social: h.social },
    signUp: { email: h.signup },
    sendVerificationEmail: h.resend,
    requestPasswordReset: h.forgot,
    resetPassword: h.reset,
  },
}));
vi.mock("@/components/turnstile", () => ({
  captchaHeaders: () => ({}),
  useTurnstile: () => ({ getToken: h.token, slot: null }),
}));

type Node = ReactElement<Record<string, unknown>>;
function nodes(value: ReactNode): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children as ReactNode)];
}
function find(tree: ReactNode, predicate: (node: Node) => boolean) {
  const node = nodes(tree).find(predicate);
  if (!node) throw new Error("Expected element missing");
  return node;
}
function render(
  mode: "login" | "signup" = "login",
  providers = { google: false, github: false, microsoft: false },
) {
  h.cursor = 0;
  return AuthForm({
    mode,
    providers,
    legal: { termsUrl: null, privacyUrl: null },
    forgotPassword: true,
    productUpdates: true,
  });
}
function input(tree: ReactNode, id: string, value: string) {
  const node = find(tree, (n) => n.props.id === id);
  (node.props.onChange as (event: unknown) => void)({ target: { value } });
}
async function submit(tree: ReactNode) {
  const form = find(tree, (n) => n.type === "form");
  await (form.props.onSubmit as (event: unknown) => Promise<void>)({ preventDefault: vi.fn() });
}
const button = (tree: ReactNode) => find(tree, (n) => n.props.type === "submit");
const alert = (tree: ReactNode) => find(tree, (n) => n.props.role === "alert");

beforeEach(() => {
  vi.clearAllMocks();
  h.states = [];
  h.cursor = 0;
  h.params = new URLSearchParams();
  h.token.mockResolvedValue(null);
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => callback());
  vi.stubGlobal("fetch", h.updates);
  h.updates.mockResolvedValue({ ok: true });
});

describe("auth UX: synthetic component state harness", () => {
  it("Free verification keeps the normal onboarding destination after login", async () => {
    h.params = new URLSearchParams({ next: "/onboarding" });
    await submit(render());
    h.email.mockResolvedValue({ data: { token: "fixture" }, error: null });
    await submit(render());
    expect(h.push).toHaveBeenCalledWith("/onboarding");
  });
  it("login keeps the offer in the verification resend callback", async () => {
    const next = "/settings/billing?rung=pro_200k";
    h.params = new URLSearchParams({ next });
    await submit(render());
    h.email.mockResolvedValue({ error: { code: "EMAIL_NOT_VERIFIED" } });
    await submit(render());
    expect(h.email).toHaveBeenCalledWith(expect.objectContaining({ callbackURL: next }));
    expect(h.push).not.toHaveBeenCalled();
  });
  it("preserves a paid offer on recovery, verification and OAuth failure", async () => {
    const next = "/settings/billing?rung=pro_200k";
    h.params = new URLSearchParams({ next });
    await submit(render());
    expect(
      nodes(render()).some(
        (n) => n.props.href === `/forgot-password?next=${encodeURIComponent(next)}`,
      ),
    ).toBe(true);
    h.social.mockResolvedValue({ error: null });
    const social = find(
      render("login", { google: true, github: false, microsoft: false }),
      (n) => n.type === "button" && Array.isArray(n.props.children),
    );
    await (social.props.onClick as () => Promise<void>)();
    expect(h.social).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackURL: next,
        errorCallbackURL: `/login?next=${encodeURIComponent(next)}`,
      }),
    );
    h.states = [];
    h.signup.mockResolvedValue({ data: { token: null }, error: null });
    await submit(render("signup"));
    expect(h.signup).toHaveBeenCalledWith(
      expect.objectContaining({ callbackURL: `/verify-email?next=${encodeURIComponent(next)}` }),
    );
  });
  it("preserves recovery return links and reset callback without submission to a real backend", async () => {
    const next = "/settings/billing?rung=pro_100k";
    const recovery = () => {
      h.cursor = 0;
      return ForgotPasswordForm({ minutes: 60, ...{ next } });
    };
    expect(
      nodes(recovery()).some((n) => n.props.href === `/login?next=${encodeURIComponent(next)}`),
    ).toBe(true);
    h.forgot.mockResolvedValue({ error: null });
    await submit(recovery());
    expect(h.forgot).toHaveBeenCalledWith(
      expect.objectContaining({ redirectTo: `/reset-password?next=${encodeURIComponent(next)}` }),
    );
    h.states = [];
    h.cursor = 0;
    const reset = ResetPasswordForm({ token: null, ...{ next } });
    expect(
      nodes(reset).some(
        (n) => n.props.href === `/forgot-password?next=${encodeURIComponent(next)}`,
      ),
    ).toBe(true);
  });
  it("email-first reveals/focuses password without a request, preserving safe next", async () => {
    h.params = new URLSearchParams("next=%2Finvite%2Ftest");
    let tree = render();
    expect(button(tree).props.children).toBe("auth.continueEmail");
    input(tree, "email", "preview@example.invalid");
    await submit(render());
    tree = render();
    expect(h.focus).toHaveBeenCalled();
    expect(h.email).not.toHaveBeenCalled();
    expect(find(tree, (n) => n.props.id === "password")).toBeTruthy();
    expect(find(tree, (n) => n.props.href === "/signup?next=%2Finvite%2Ftest")).toBeTruthy();
  });
  it("email pending disables duplicates; rejected network restores controls and values", async () => {
    input(render(), "email", "preview@example.invalid");
    await submit(render());
    input(render(), "password", "synthetic-test-only");
    let reject!: (error: Error) => void;
    h.email.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const operation = submit(render());
    await Promise.resolve();
    await Promise.resolve();
    expect(button(render()).props.disabled).toBe(true);
    expect(find(render(), (n) => n.props.role === "status").props.children).toBe(
      "auth.pending.email",
    );
    await submit(render());
    expect(h.email).toHaveBeenCalledTimes(1);
    reject(new Error("synthetic offline"));
    await operation;
    const tree = render();
    expect(button(tree).props.disabled).toBe(false);
    expect(alert(tree).props.children).toBe("auth.networkError");
    expect(find(tree, (n) => n.props.id === "email").props.value).toBe("preview@example.invalid");
    expect(find(tree, (n) => n.props.id === "password").props.value).toBe("synthetic-test-only");
  });
  it("signup keeps three essential fields, invite, password rules and opt-in off", async () => {
    h.params = new URLSearchParams("email=preview%40example.invalid&next=%2Finvite%2Ftest");
    const tree = render("signup");
    expect(
      nodes(tree).filter((n) => n.type === "input" && n.props.type !== "checkbox"),
    ).toHaveLength(3);
    expect(
      nodes(tree).filter((n) => n.props["aria-label"] === "auth.signup.showPassword"),
    ).toHaveLength(1);
    expect(find(tree, (n) => n.props.id === "email").props.value).toBe("preview@example.invalid");
    expect(find(tree, (n) => n.props.id === "product-updates").props.checked).toBe(false);
    expect(find(tree, (n) => n.props.id === "password").props.minLength).toBe(8);
    h.signup.mockResolvedValue({ data: { token: null }, error: null });
    await submit(render("signup"));
    expect(h.signup).toHaveBeenCalledWith(
      expect.objectContaining({ callbackURL: "/verify-email?next=%2Finvite%2Ftest" }),
    );
    expect(h.updates).not.toHaveBeenCalled();
  });
  it("explicit opt-in requests the existing double opt-in only after signup succeeds", async () => {
    const tree = render("signup");
    input(tree, "email", "preview@example.invalid");
    const checkbox = find(tree, (n) => n.props.id === "product-updates");
    (checkbox.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    h.signup.mockResolvedValue({ data: { token: null }, error: null });
    await submit(render("signup"));
    expect(h.updates).toHaveBeenCalledWith(
      "/api/updates/subscribe",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "preview@example.invalid", source: "updates" }),
      }),
    );
    expect(
      nodes(render("signup")).some(
        (n) =>
          Array.isArray(n.props.children) &&
          n.props.children.includes("auth.legal.updatesRequested"),
      ),
    ).toBe(true);
  });
  it("a failed signup never requests updates even when checked", async () => {
    const checkbox = find(render("signup"), (n) => n.props.id === "product-updates");
    (checkbox.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    h.signup.mockResolvedValue({ error: { code: "MISSING_RESPONSE" } });
    await submit(render("signup"));
    expect(h.updates).not.toHaveBeenCalled();
  });
  it("updates network failure preserves created account and provides separate retry", async () => {
    input(render("signup"), "email", "preview@example.invalid");
    const checkbox = find(render("signup"), (n) => n.props.id === "product-updates");
    (checkbox.props.onChange as (event: unknown) => void)({ target: { checked: true } });
    h.signup.mockResolvedValue({ data: { token: null }, error: null });
    h.updates.mockRejectedValue(new Error("offline"));
    await submit(render("signup"));
    expect(nodes(render("signup")).some((n) => n.props.href === "/updates")).toBe(true);
    expect(
      nodes(render("signup")).some(
        (n) =>
          Array.isArray(n.props.children) && n.props.children.includes("auth.legal.updatesFailed"),
      ),
    ).toBe(true);
  });
  for (const provider of ["google", "github", "microsoft"] as const) {
    it(`${provider}: respects flags, announces pending and recovers rejection`, async () => {
      expect(nodes(render()).some((n) => n.props.children === `auth.social.${provider}`)).toBe(
        false,
      );
      const providers = { google: false, github: false, microsoft: false, [provider]: true };
      let reject!: (error: Error) => void;
      h.social.mockImplementation(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      );
      const tree = render("login", providers);
      const social = find(tree, (n) => n.type === "button" && Array.isArray(n.props.children));
      const operation = (social.props.onClick as () => Promise<void>)();
      expect(
        find(render("login", providers), (n) => n.props.role === "status").props.children,
      ).toBe(`auth.pending.${provider}`);
      reject(new Error("synthetic offline"));
      await operation;
      expect(alert(render("login", providers)).props.children).toBe("auth.networkError");
      expect(button(render("login", providers)).props.disabled).toBe(false);
    });
  }
  it("login never displays provider/server account details", async () => {
    await submit(render());
    h.email.mockResolvedValue({
      error: { message: "private account detail", code: "INVALID_PASSWORD" },
    });
    await submit(render());
    expect(alert(render()).props.children).toBe("auth.login.error");
  });
  it("forgot network rejection preserves email and neutral failure", async () => {
    const recovery = () => {
      h.cursor = 0;
      return ForgotPasswordForm({ minutes: 60, initialEmail: "preview@example.invalid" });
    };
    h.forgot.mockRejectedValue(new Error("synthetic offline"));
    await submit(recovery());
    const tree = recovery();
    expect(alert(tree).props.children).toBe("auth.networkError");
    expect(button(tree).props.disabled).toBe(false);
    expect(find(tree, (n) => n.props.id === "email").props.value).toBe("preview@example.invalid");
  });
  it("forgot known/unknown response has the same neutral state", async () => {
    const recovery = () => {
      h.cursor = 0;
      return ForgotPasswordForm({ minutes: 60 });
    };
    h.forgot.mockResolvedValue({ error: null });
    await submit(recovery());
    expect(nodes(recovery()).some((n) => n.props.children === "auth.forgot.sent")).toBe(true);
    h.states = [];
    h.forgot.mockResolvedValue({ error: { status: 400 } });
    await submit(recovery());
    expect(nodes(recovery()).some((n) => n.props.children === "auth.forgot.sent")).toBe(true);
  });
  it("reset network failure unlocks the same filled form", async () => {
    const reset = () => {
      h.cursor = 0;
      return ResetPasswordForm({ token: "synthetic-token-not-real" });
    };
    input(reset(), "password", "synthetic-test-only");
    input(reset(), "confirm", "synthetic-test-only");
    h.reset.mockRejectedValue(new Error("synthetic offline"));
    await submit(reset());
    expect(alert(reset()).props.children).toBe("auth.networkError");
    expect(button(reset()).props.disabled).toBe(false);
  });
});
