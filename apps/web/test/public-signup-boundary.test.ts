// @vitest-environment node

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterAll, beforeEach, describe, it } from "vitest";

// Only this test's VM resolver consumes server-only. No Vite/global alias is installed.
// The override is for bounded artifact rehearsals, never application resolution.
const root =
  process.env.MEPMAIL_SIGNUP_TEST_SOURCE_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const deps = createRequire(import.meta.url);
const esbuild = createRequire(deps.resolve("vitest/config"))("esbuild");
const React = deps("react");
const { renderToStaticMarkup } = deps("react-dom/server");
const realBaselines = [
  "apps/web/src/lib/nav.ts",
  "apps/web/src/lib/public-intent.ts",
  "apps/web/src/lib/mailbox-plans.ts",
  "apps/web/src/components/public-account.tsx",
  "apps/web/src/components/plan-card.tsx",
];
const realFiles = new Set([
  ...realBaselines,
  "apps/web/src/server/public-signup.ts",
  "apps/web/src/components/site-chrome.tsx",
  "apps/web/src/components/signup-cta.tsx",
  "apps/web/src/components/signup-availability.tsx",
  "apps/web/src/components/auth/signup-closed.tsx",
  "apps/web/src/lib/public-signup-copy.ts",
  "apps/web/src/app/page.tsx",
  "apps/web/src/app/home-v2.tsx",
  "apps/web/src/app/home-legacy.tsx",
  "apps/web/src/app/signup/page.tsx",
]);
const source = (name: string) => fs.readFileSync(path.join(root, name), "utf8");
const old = source;

type VmValue = ReturnType<typeof vm.runInThisContext>;
let state: VmValue, modules: Map<string, VmValue>;
class APIError extends Error {
  constructor(
    public status: string,
    public body: { message: string },
  ) {
    super(body.message);
  }
}
function reset(o: VmValue = {}) {
  state = {
    allow: false,
    count: 1,
    cap: undefined,
    locale: "en",
    session: false,
    subscriptions: false,
    mail: false,
    error: null,
    calls: 0,
    dbCalls: 0,
    ...o,
  };
  modules = new Map();
  process.env.MAILBOX_EARLY_ACCESS_OPEN = String(state.mail);
  process.env.MAILBOX_STANDALONE_OPEN = String(state.mail);
}
function compile(code: string, n: string, rq: (id: string) => VmValue) {
  const c = esbuild.transformSync(code, {
      loader: n.endsWith("tsx") ? "tsx" : "ts",
      jsx: "automatic",
      format: "cjs",
      target: "es2023",
    }).code,
    m: { exports: VmValue } = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${c}\n})`, { filename: n })(
    rq,
    m,
    m.exports,
  );
  return m.exports;
}
const auth = old("apps/web/src/server/auth.ts"),
  start = auth.indexOf("export async function assertSignupAllowed("),
  assertion = auth.slice(start, auth.indexOf("\n/**", start));
function trans(ns: string) {
  const parts = ns.split(".");
  let c = JSON.parse(old(`apps/web/messages/${state.locale}/${parts.shift()}.json`));
  for (const p of parts) c = c[p];
  const raw = (k: string): VmValue => k.split(".").reduce((o: VmValue, p: string) => o[p], c);
  const t = (k: string, v: VmValue = {}) =>
    String(raw(k)).replace(/\{(\w+)\}/g, (_, p) => String(v[p] ?? `{${p}}`));
  t.raw = raw;
  t.rich = (k: string, v: VmValue) => t(k, v).replace(/<\/?\w+>/g, "");
  return t;
}
const nil = () => null,
  kids = (p: VmValue) => React.createElement(React.Fragment, null, p.children);
function ext(id: string): VmValue {
  if (id === "server-only") return {};
  if (id === "react" || id === "react/jsx-runtime") return deps(id);
  if (id === "better-auth/api") return { APIError };
  if (id === "@millionsend/config")
    return { signupOpen: () => state.allow, betaMaxUsers: () => state.cap, env: {} };
  if (id === "@millionsend/db")
    return {
      getDb: () => ({
        select: () => ({
          from: () => ({
            limit: async (n: number) => {
              state.dbCalls++;
              if (state.error) throw state.error;
              return Array.from({ length: Math.min(state.count, n) }, (_, id) => ({ id }));
            },
          }),
        }),
      }),
    };
  if (id === "next-intl/server")
    return {
      getLocale: async () => {
        if (state.localeError) throw state.localeError;
        return state.locale;
      },
      getTranslations: async (n: string) => trans(n),
    };
  if (id === "next-intl") return { useTranslations: () => (k: string) => k };
  if (id === "next/navigation")
    return {
      usePathname: () => "/",
      useRouter: () => ({ refresh: nil }),
      redirect: (href: string) => {
        throw Object.assign(new Error("NEXT_REDIRECT"), { href });
      },
    };
  if (id === "@millionsend/core/plans") return ext("@millionsend/core");
  if (id === "@millionsend/core")
    return {
      CHECKS: [],
      PLAN_RUNGS: [
        { key: "free", included: 100, period: "day", priceCents: 0, brlPriceCents: 0 },
        { key: "starter", included: 1000, period: "month", priceCents: 100, brlPriceCents: 100 },
        { key: "pro", included: 550000, period: "month", priceCents: 1000, brlPriceCents: 1000 },
      ],
    };
  if (id === "@millionsend/core/mcp-tools") return { MCP_TOOLS: [] };
  const s = id.replace(/^@\//, "");
  if (s === "server/auth")
    return {
      assertSignupAllowed: async (db: VmValue, allow: boolean) => {
        state.calls++;
        const real = compile(
          'import {APIError} from "better-auth/api";\nimport {betaMaxUsers} from "@millionsend/config";\nconst schema={user:{id:"id"}};\n' +
            assertion,
          "assertion.ts",
          ext,
        );
        return real.assertSignupAllowed(db, allow);
      },
      hasSession: async () => state.session,
      enabledSocialProviders: () => ({ google: true, github: true, microsoft: false }),
    };
  if (s === "server/new-subscriptions")
    return { newSubscriptionsPaused: () => state.subscriptions };
  if (s === "server/ses-pause") return { accountMailDelayed: async () => false };
  if (s === "server/public-seo")
    return {
      publicPageUrls: async (p: string) => ({
        url: p,
        ogLocale: state.locale,
        alternates: { canonical: p },
      }),
    };
  if (s === "lib/auth-client")
    return {
      authClient: {
        useSession: () => ({
          data: state.session ? { user: { name: "Existing" } } : null,
          isPending: false,
        }),
        signOut: async () => ({}),
      },
    };
  if (s === "components/auth/auth-form")
    return {
      AuthForm: (p: VmValue) =>
        React.createElement(
          "form",
          { "data-open-signup": "1" },
          React.createElement("input", { name: "email" }),
          p.mode,
        ),
    };
  if (s === "components/subscriptions-paused-notice") return { SubscriptionsPausedNotice: nil };
  if (s === "components/landing-lang-switch") return { LandingLangSwitch: nil };
  if (s === "components/advertising-consent") return { AdvertisingSettingsButton: nil };
  if (s === "components/landing-nav") return { LandingNav: kids };
  if (s === "components/user-avatar") return { UserAvatar: nil };
  if (s === "components/public-events")
    return {
      ArrivalTracker: nil,
      McpConfigCopy: nil,
      DocsLink: (p: VmValue) => React.createElement("a", p, p.children),
      GithubLink: (p: VmValue) => React.createElement("a", p, p.children),
    };

  if (s === "lib/analytics")
    return {
      trackEvent: () => {
        throw Error("unexpected tracking");
      },
    };
  if (s === "lib/funnel-tracking") return { clickContext: nil, funnelClickProps: nil };
  if (s === "lib/public-funnel") return { visitSource: nil };
  if (s === "lib/desktop-download")
    return {
      WINDOWS_STORE_URL: "/download",
      DESKTOP_DOWNLOAD_URL: "/download",
      LINUX_DOWNLOAD_URL: "/download",
    };
  if (s === "lib/docs-links") return { MCP_DOCS_URL: "https://docs.mepmail.dev" };
  if (s === "lib/title-phrases") return { titlePhrases: (s: string) => [s] };
  if (s === "lib/legal-links")
    return { legalLinks: () => ({ terms: "/terms", privacy: "/privacy", refund: "/refund" }) };
  if (s === "lib/structured-data")
    return {
      faqJsonLd: nil,
      organizationJsonLd: nil,
      websiteJsonLd: nil,
      siteBaseUrl: () => "https://mepmail.dev",
    };
  if (s === "lib/stack-logos") return { HOME_STACK_LOGOS: [] };
  if (s === "lib/landing-pricing")
    return {
      COMPARISON_FX: { date: "2026-10-01", brlPerUsd: 5 },
      comparisonRowsForLocale: () => [],
      formatBrlPrice: String,
      formatUsd: String,
      formatVolume: String,
      formatWholeComparisonPrice: String,
      formatComparisonPrice: String,
    };
  if (s === "lib/launch-offer")
    return {
      CORREIO_FROM_BRL_CENTS: 100,
      CORREIO_FROM_CENTS: 100,
      LAUNCH_OFFER: {
        correioPlans: [
          { id: "duo", brlMonthlyCents: 100, monthlyCents: 100 },
          { id: "equipe", brlMonthlyCents: 200, monthlyCents: 200 },
        ],
        mailboxes: [{ monthlyCents: 100 }],
        sending: {
          brlFirstMonthlyCents: 100,
          firstMonthlyCents: 100,
          brlMonthlyCents: 100,
          monthlyCents: 100,
        },
      },
    };
  if (s === "lib/landing-plans")
    return {
      plansWithCopy: (items: VmValue[]) =>
        items.map((copy: VmValue, i: number) => ({
          copy,
          rung: i === 0 ? "free" : "starter",
          name: copy.name || `Plan ${i}`,
          price: i === 0 ? "US$ 0" : "100",
        })),
    };
  const m: Record<string, string> = {
    "components/public-starter-gallery": "PublicStarterGallery",
    "components/structured-data": "StructuredData",
    "components/comparison-reference": "ComparisonReference",
    "components/integration-tabs": "IntegrationTabs",
    "components/landing-calculator": "LandingCalculator",
    "components/landing-motion": "LandingMotion",
    "components/stack-logos": "StackLogoRow",
  };
  if (m[s]) return { [m[s]]: nil };
  throw Error("Unapproved dependency " + id);
}
function load(n: string): VmValue {
  if (modules.has(n)) return modules.get(n);
  const rq = (id: string): VmValue => {
    if (id.endsWith(".css"))
      return { default: new Proxy({}, { get: (_, k) => String(k) }), __esModule: true };
    let t: string | undefined;
    if (id.startsWith("@/")) t = "apps/web/src/" + id.slice(2);
    else if (id.startsWith("."))
      t = path.posix.normalize(path.posix.join(path.posix.dirname(n), id));
    if (t) {
      for (const e of [".ts", ".tsx"]) {
        const f = t + e;
        if (realFiles.has(f) || realBaselines.includes(f)) return load(f);
      }
      if (id === "./correio/agent-demo") return { AgentDemo: nil };
      if (id.startsWith(".")) return ext("@/" + t.replace("apps/web/src/", ""));
    }
    return ext(id);
  };
  // Explicit relative fallbacks avoid accidental private application resolution.
  const realRq = (id: string): VmValue => {
    if (id.startsWith(".") && !id.endsWith(".css")) {
      const t = path.posix.normalize(path.posix.join(path.posix.dirname(n), id));
      if (![".ts", ".tsx"].some((e) => realFiles.has(t + e) || realBaselines.includes(t + e))) {
        if (id === "./correio/agent-demo") return { AgentDemo: nil };
        return ext("@/" + t.replace("apps/web/src/", ""));
      }
    }
    return rq(id);
  };
  const m = compile(source(n), n, realRq);
  modules.set(n, m);
  return m;
}
async function expand(n: VmValue): Promise<VmValue> {
  if (Array.isArray(n)) return Promise.all(React.Children.toArray(n).map(expand));
  if (!React.isValidElement(n)) return n;
  if (typeof n.type === "function" && n.type.constructor.name === "AsyncFunction") {
    const resolved = await expand(await n.type(n.props));
    return React.isValidElement(resolved)
      ? React.cloneElement(resolved, { key: n.key ?? resolved.key })
      : resolved;
  }
  return n.props.children === undefined
    ? n
    : React.cloneElement(n, {}, await expand(n.props.children));
}
async function html(n: VmValue) {
  return renderToStaticMarkup(await expand(n));
}

const originalStandaloneFlags = {
  MAILBOX_EARLY_ACCESS_OPEN: process.env.MAILBOX_EARLY_ACCESS_OPEN,
  MAILBOX_STANDALONE_OPEN: process.env.MAILBOX_STANDALONE_OPEN,
};
afterAll(() => {
  for (const [name, value] of Object.entries(originalStandaloneFlags)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    assert.equal(process.env[name], value);
  }
});
beforeEach(() => reset());
describe("public signup server-boundary regression", () => {
  it("scopes the closed login CTA above generic auth links without altering its route", async () => {
    const css = source("apps/web/src/components/auth/auth.module.css");
    const rule = css.match(/\.column\s+a\.closedLogin\s*\{([^}]*)\}/)?.[1];
    assert.ok(rule, "a scoped auth-link override must remain present");
    assert.match(rule, /color:\s*var\(--ms-ground\)/);
    assert.match(rule, /text-decoration:\s*none/);
    for (const locale of ["en", "pt-BR"]) {
      reset({ locale });
      for (const availability of ["paused", "full"]) {
        const markup = await html(
          await load("apps/web/src/components/auth/signup-closed.tsx").SignupClosed({
            availability,
          }),
        );
        const links = [...markup.matchAll(/<a\b(?=[^>]*href="\/login")[^>]*>/g)];
        assert.equal(links.length, 1);
        assert.match(links[0][0], /class="[^"]*\bclosedLogin\b[^"]*"/);
      }
    }
  });
  it.each([
    { name: "paused", expected: "paused" },
    { name: "bootstrap", count: 0, expected: "open" },
    { name: "open", allow: true, count: 3, expected: "open" },
    { name: "below cap", allow: true, count: 1, cap: 2, expected: "open" },
    { name: "exact cap", allow: true, count: 2, cap: 2, expected: "full" },
    { name: "above cap", allow: true, count: 3, cap: 2, expected: "full" },
    { name: "bootstrap with cap", count: 0, cap: 2, expected: "open" },
  ])("delegates unchanged authority: $name", async (fixture) => {
    reset(fixture);
    assert.equal(
      await load("apps/web/src/server/public-signup.ts").publicSignupAvailability(),
      fixture.expected,
    );
    assert.equal(state.calls, 1);
  });
  it.each([
    new Error("storage unavailable"),
    new APIError("FORBIDDEN", { message: "Unknown denial" }),
    new APIError("INTERNAL_SERVER_ERROR", { message: "Signup is disabled." }),
  ])("propagates unknown failures without inferring permission", async (error) => {
    reset({ error, allow: false });
    await assert.rejects(
      load("apps/web/src/server/public-signup.ts").publicSignupAvailability(),
      (actual: unknown) => actual === error,
    );
  });
  for (const locale of ["en", "pt-BR"])
    for (const mode of ["paused", "full"])
      it(`closed signup SSR ${locale}/${mode}`, async () => {
        reset({ locale, allow: mode === "full", count: 2, cap: mode === "full" ? 2 : undefined });
        const markup = await html(
          await load("apps/web/src/app/signup/page.tsx").default({
            searchParams: Promise.resolve({}),
          }),
        );
        const copy = load("apps/web/src/lib/public-signup-copy.ts").publicSignupCopy(locale);
        assert.ok(markup.includes(copy[mode]));
        for (const href of ["/login", "/status", "/source", "/support"])
          assert.ok(markup.includes(`href="${href}"`));
        assert.doesNotMatch(
          markup,
          /<input|<form|oauth|Google|GitHub|instant|minute|na hora|minuto/i,
        );
      });
  it("retains open social-provider props and the bootstrap path", async () => {
    for (const fixture of [{ allow: true }, { count: 0 }]) {
      reset(fixture);
      const view = await load("apps/web/src/app/signup/page.tsx").default({
        searchParams: Promise.resolve({}),
      });
      assert.equal(view.props.mode, "signup");
      assert.deepEqual(view.props.providers, { google: true, github: true, microsoft: false });
    }
  });
  it("redirects authenticated users before any availability or database access", async () => {
    for (const next of [
      "/templates/new?starter=welcome",
      "https://evil.invalid",
      "/signup",
      "/api/test",
      ["/emails"],
    ]) {
      reset({ session: true, error: Error("must not query") });
      await assert.rejects(
        load("apps/web/src/app/signup/page.tsx").default({
          searchParams: Promise.resolve({ next }),
        }),
        (e: VmValue) =>
          e.message === "NEXT_REDIRECT" &&
          e.href === (typeof next === "string" && next.startsWith("/templates/") ? next : "/"),
      );
      assert.equal(state.calls, 0);
      assert.equal(state.dbCalls, 0);
    }
  });
  for (const locale of ["en", "pt-BR"])
    for (const mode of ["status", "unknown", "open", "paused", "full"])
      it(`chrome SSR ${locale}/${mode}`, async () => {
        reset({
          locale,
          allow: mode === "open" || mode === "full",
          cap: mode === "full" ? 1 : undefined,
          error: ["status", "unknown"].includes(mode) ? Error("storage unavailable") : null,
        });
        const l = trans("landing"),
          labels = {
            skip: l("skip"),
            brandAria: l("brandAria"),
            navAria: l("navAria"),
            langAria: l("lang.aria"),
            nav: l.raw("nav"),
            footer: l.raw("footer"),
          };
        for (const component of ["PublicHeader", "PublicFooter"]) {
          const markup = await html(
            await load("apps/web/src/components/site-chrome.tsx")[component]({
              labels,
              page: mode === "status" ? "status" : "pricing",
              contact: "/support",
              legal: { terms: "/terms", privacy: "/privacy", refund: "/refund" },
            }),
          );
          const copy = load("apps/web/src/lib/public-signup-copy.ts").publicSignupCopy(locale);
          assert.match(markup, /href="\/login"/);
          const anchors = [
            ...markup.matchAll(/<a\b[^>]*href="\/signup[^"]*"[^>]*>([\s\S]*?)<\/a>/g),
          ];
          assert.ok(anchors.length);
          if (mode === "open") assert.match(markup, /data-funnel-signup/);
          else {
            for (const a of anchors) assert.ok(a[1].includes(copy.check));
            assert.doesNotMatch(markup, /data-funnel-signup/);
            assert.ok(!markup.includes(copy.paused) && !markup.includes(copy.full));
          }
        }
        if (mode === "status") {
          assert.equal(state.calls, 0);
          assert.equal(state.dbCalls, 0);
        }
      });
  it("does not swallow locale/catalog failures", async () => {
    const error = Error("catalog unavailable");
    reset({ localeError: error });
    const chrome = load("apps/web/src/components/site-chrome.tsx");
    for (const name of ["PublicHeader", "PublicFooter"])
      await assert.rejects(chrome[name]({ page: "status" }), (e: unknown) => e === error);
  });
  it("preserves both root branches and provider, including closed CTA and unknown failure", async () => {
    for (const mail of [false, true])
      for (const allow of [false, true]) {
        reset({ mail, allow });
        const markup = await html(await load("apps/web/src/app/page.tsx").default());
        assert.match(markup, /href="\/login"/);
        assert.match(markup, /gtm-footer/);
        assert.equal(markup.includes('class="v2-door'), mail);
        const copy = load("apps/web/src/lib/public-signup-copy.ts").publicSignupCopy("en");
        if (allow) assert.match(markup, /data-funnel-signup/);
        else {
          assert.ok(markup.includes(copy.paused));
          assert.ok(markup.includes(copy.check));
          assert.doesNotMatch(markup, /data-funnel-signup/);
        }
      }
    const error = Error("unknown root lookup");
    reset({ error });
    await assert.rejects(load("apps/web/src/app/page.tsx").default(), (e: unknown) => e === error);
  });
  it("retains the real Correio selector without turning a URL into entitlement", () => {
    const intent = load("apps/web/src/lib/public-intent.ts");
    for (const plan of ["solo", "duo", "equipe"]) {
      const url = new URL(intent.signupMailboxHref(plan), "https://fixture.test");
      const next = url.searchParams.get("next");
      assert.ok(next, "Correio selector destination must remain present");
      const target = new URL(next, url);
      assert.equal(target.pathname, "/mail");
      assert.deepEqual(intent.requestedMailboxPurchase(Object.fromEntries(target.searchParams)), {
        plan,
      });
    }
    assert.equal(intent.requestedMailboxPurchase({ plan: "equipe" }), null);
  });
});
