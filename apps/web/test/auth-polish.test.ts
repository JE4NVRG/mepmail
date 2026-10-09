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
  useLocale: () => "en",
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
  mailDelayed = false,
) {
  h.cursor = 0;
  return AuthForm({
    mode,
    providers,
    legal: { termsUrl: null, privacyUrl: null },
    forgotPassword: true,
    mailDelayed,
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
});

describe("auth UX: synthetic component state harness", () => {
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
  it("signup asks only name, email and password and keeps the invite email", async () => {
    // The signup was trimmed to three fields (no confirm-email or
    // confirm-password); one eye toggles the password.
    h.params = new URLSearchParams("email=preview%40example.invalid&next=%2Finvite%2Ftest");
    const tree = render("signup");
    expect(
      nodes(tree)
        .filter((n) => n.type === "input")
        .map((n) => n.props.id),
    ).toEqual(["name", "email", "password"]);
    expect(find(tree, (n) => n.props.id === "email").props.value).toBe("preview@example.invalid");
    expect(find(tree, (n) => n.props.id === "password").props.minLength).toBe(8);
    expect(
      nodes(tree).filter((n) =>
        /^auth\.signup\.(show|hide)Password$/.test(String(n.props["aria-label"] ?? "")),
      ),
    ).toHaveLength(1);
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
  it("while account mail runs late, signup points at Google before the email form", async () => {
    const google = { google: true, github: false, microsoft: false };
    const texts = (tree: ReactNode) => nodes(tree).map((n) => n.props.children);
    expect(texts(render("signup", google))).not.toContain("auth.shell.mailDelayed");
    const tree = render("signup", google, true);
    const order = texts(tree);
    const notice = order.indexOf("auth.shell.mailDelayed");
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(
      order.findIndex((c) => Array.isArray(c) && c.includes("auth.social.google")),
    );
    expect(texts(render("signup", undefined, true))).toContain("auth.shell.mailDelayedPlain");
    // A password signup that is already waiting for its link is offered Google too.
    h.signup.mockResolvedValue({ data: { token: null }, error: null });
    input(render("signup", google, true), "name", "Preview");
    input(render("signup", google, true), "email", "preview@example.invalid");
    input(render("signup", google, true), "password", "synthetic-test-only");
    await submit(render("signup", google, true));
    const waiting = render("signup", google, true);
    expect(texts(waiting)).toContain("auth.shell.mailDelayedVerify");
    const social = find(waiting, (n) => n.type === "button" && Array.isArray(n.props.children));
    h.social.mockResolvedValue({ error: null });
    await (social.props.onClick as () => Promise<void>)();
    expect(h.social).toHaveBeenCalledWith(expect.objectContaining({ provider: "google" }));
  });
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
