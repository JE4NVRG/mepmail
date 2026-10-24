// @vitest-environment jsdom
import { act, Fragment, createElement as h, type ReactNode, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({ path: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.path }));

import { PlanCard } from "@/components/plan-card";
import { SignupCta } from "@/components/signup-cta";
import { SiteFunnelEvents } from "@/components/site-funnel-events";
import { trackEvent } from "@/lib/analytics";
import {
  clickContext,
  intentCookie,
  publicFunnelPath,
  trackedSignupHref,
} from "@/lib/funnel-tracking";
import { EMPTY_PLAN_COPY, PLANS } from "@/lib/landing-plans";

type MeasuredWindow = Window & { umami?: { track: ReturnType<typeof vi.fn> } };
let root: Root | undefined;
let tracker: ReturnType<typeof vi.fn>;
function click(id: string) {
  const e = document.querySelector(id);
  if (!e) throw Error("fixture-missing-anchor");
  e.addEventListener("click", (event) => event.preventDefault(), { once: true });
  act(() => e.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
}
function mount(children: ReactNode) {
  const node = document.getElementById("mount");
  if (!node) throw Error("fixture-missing-root");
  root = createRoot(node);
  act(() => root?.render(children));
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  route.path = "/";
  window.history.replaceState(
    {},
    "",
    "/?utm_source=x&utm_medium=post&utm_campaign=send_launch&utm_content=hero&utm_term=api",
  );
  document.body.innerHTML = '<div id="mount"></div>';
  document.cookie = "mm_attr=; Max-Age=0; Path=/";
  document.cookie = "mm_funnel_intent=; Max-Age=0; Path=/";
  tracker = vi.fn();
  (window as MeasuredWindow).umami = { track: tracker };
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  delete (window as MeasuredWindow).umami;
  document.cookie = "mm_attr=; Max-Age=0; Path=/";
  document.cookie = "mm_funnel_intent=; Max-Age=0; Path=/";
});

describe("public funnel v2 metadata", () => {
  it("keeps the paid next destination, locale and five measured UTMs", () => {
    const ctx = clickContext({
      href: "/signup?next=%2Fsettings%2Fbilling%3Fplan%3Dpro_100k&lang=pt-BR",
      search: window.location.search,
    });
    expect(ctx).toMatchObject({
      product: "send",
      plan: "pro_100k",
      utm_source: "x",
      utm_medium: "post",
      utm_campaign: "send_launch",
      utm_content: "hero",
      utm_term: "api",
    });
    const out = new URL(
      trackedSignupHref("/signup?next=%2Fsettings%2Fbilling%3Fplan%3Dpro_100k&lang=pt-BR", ctx),
      "https://mepmail.dev",
    );
    expect(out.searchParams.get("next")).toBe("/settings/billing?plan=pro_100k");
    expect(out.searchParams.get("lang")).toBe("pt-BR");
    expect(out.searchParams.get("plan")).toBe("pro_100k");
    expect(out.searchParams.get("utm_term")).toBe("api");
  });
  it("recovers the channel after a clean internal navigation", () => {
    const cookie =
      "mm_attr=" +
      encodeURIComponent(
        JSON.stringify({
          source: "community",
          medium: "group",
          campaign: "send",
          content: "original",
          term: "smtp",
        }),
      );
    expect(clickContext({ href: "/signup", cookie })).toMatchObject({
      utm_source: "community",
      utm_term: "smtp",
    });
  });
  it("does not invent attribution for a direct arrival or expose email/secret campaign values", () => {
    expect(clickContext({ href: "/signup" })).toEqual({
      product: "send",
      plan: "free",
      plan_label: "Free",
    });
    expect(
      clickContext({
        href: "/signup",
        search: "?utm_source=person%40example.com&utm_medium=sk_live_do_not_collect",
      }),
    ).toEqual({ product: "send", plan: "free", plan_label: "Free" });
  });
  it("never rewrites an external signup or an unrelated action", () => {
    const ctx = clickContext({ href: "/signup" });
    expect(trackedSignupHref("https://other.example/signup", ctx)).toBe(
      "https://other.example/signup",
    );
    expect(trackedSignupHref("/settings/billing", ctx)).toBe("/settings/billing");
  });
  it("stores only bounded product intent, not identity or payment authority", () => {
    const c = intentCookie(
      { product: "mail", selection_state: "unselected", utm_source: "x" },
      true,
    );
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).not.toContain("utm");
    expect(c).not.toContain("team_id");
  });
  it("excludes private mail and settings surfaces", () => {
    expect(publicFunnelPath("/settings")).toBe(false);
    expect(publicFunnelPath("/mail")).toBe(false);
    expect(publicFunnelPath("/console")).toBe(false);
    expect(publicFunnelPath("/pricing")).toBe(true);
  });
});

describe("real public callers with isolated collector", () => {
  it("emits one Free click and one enriched signup_start, no duplicate React/global event", () => {
    mount(h(Fragment, null, h(SiteFunnelEvents), h(SignupCta, { label: "Start free" })));
    click("a");
    expect(tracker.mock.calls.map((c) => c[0])).toEqual(["cta_send_free_click", "signup_start"]);
    for (const [, props] of tracker.mock.calls)
      expect(props).toMatchObject({
        product: "send",
        plan: "free",
        utm_source: "x",
        utm_medium: "post",
        utm_campaign: "send_launch",
        utm_content: "hero",
        utm_term: "api",
        measurement_version: "2",
      });
    expect(document.querySelector("a")?.getAttribute("href")).toContain("product=send");
  });
  it("does not call a paid Send plan a Free CTA", () => {
    mount(
      h(
        Fragment,
        null,
        h(SiteFunnelEvents),
        h(SignupCta, { label: "Choose Pro", plan: "Pro", rung: "pro_100k" }),
      ),
    );
    click("a");
    expect(tracker.mock.calls.map((c) => c[0])).toEqual(["signup_start", "cta_pricing_click"]);
    expect(tracker.mock.calls[0]?.[1]).toMatchObject({ product: "send", plan: "pro_100k" });
  });
  it("covers plain Mail signup links without counting a Send acquisition", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      '<a id="mail-link" href="/signup?next=%2Fmail%3Fsetup%3Dcorreio">Mail</a>',
    );
    mount(h(SiteFunnelEvents));
    click("#mail-link");
    expect(tracker.mock.calls.map((c) => c[0])).toEqual(["signup_start"]);
    expect(tracker.mock.calls[0]?.[1]).toMatchObject({
      product: "mail",
      selection_state: "unselected",
    });
    expect(document.getElementById("mail-link")?.getAttribute("href")).toContain(
      "next=%2Fmail%3Fsetup%3Dcorreio",
    );
  });
  it("measures only an actual Send/Mail selection change", () => {
    route.path = "/pricing";
    window.history.replaceState({}, "", "/pricing?focus=send&utm_source=x");
    document.body.insertAdjacentHTML(
      "beforeend",
      '<a id="send" href="/pricing?focus=send">Send</a><a id="mail" href="/pricing?focus=mail">Mail</a>',
    );
    mount(h(SiteFunnelEvents));
    click("#send");
    click("#mail");
    expect(tracker).toHaveBeenCalledTimes(1);
    expect(tracker).toHaveBeenCalledWith(
      "pricing_toggle",
      expect.objectContaining({ product: "mail", from_product: "send", utm_source: "x" }),
    );
  });
  it("does not duplicate listeners under StrictMode reruns", () => {
    mount(h(StrictMode, null, h(SiteFunnelEvents), h(SignupCta, { label: "Start free" })));
    click("a");
    expect(tracker.mock.calls.map((c) => c[0])).toEqual(["cta_send_free_click", "signup_start"]);
  });
  it("does not install public instrumentation on a private account page", () => {
    route.path = "/settings";
    window.history.replaceState({}, "", "/settings");
    document.body.insertAdjacentHTML("beforeend", '<a id="x" href="/signup">link</a>');
    mount(h(SiteFunnelEvents));
    click("#x");
    expect(tracker).not.toHaveBeenCalled();
    expect(document.getElementById("x")?.getAttribute("href")).toBe("/signup");
  });
  it("never lets a missing or throwing collector break navigation", () => {
    delete (window as MeasuredWindow).umami;
    expect(() => trackEvent("signup_start")).not.toThrow();
    (window as MeasuredWindow).umami = {
      track: vi.fn(() => {
        throw Error("fixture-collector-failure");
      }),
    };
    expect(() => trackEvent("signup_start")).not.toThrow();
  });
});

describe("catalog-bound browser plan normalization", () => {
  it.each([
    ["free", "free", "Free"],
    ["Free", "free", "Free"],
    ["choose", undefined, undefined],
    ["Pro110K", "pro_100k", "Pro 110K"],
    ["Starter", "starter", "Starter"],
  ])("normalizes observed legacy value %s without changing event names", (input, code, name) => {
    for (const event of ["plan_card_view", "cta_pricing_click"]) {
      trackEvent(event, { product: "send", plan: input });
      expect(tracker.mock.lastCall?.[0]).toBe(event);
      const props = tracker.mock.lastCall?.[1];
      if (code) expect(props).toMatchObject({ product: "send", plan: code, plan_label: name });
      else {
        expect(props).not.toHaveProperty("plan");
        expect(props).toMatchObject({ selection_state: "unselected" });
      }
    }
  });
  it.each(["Pro", "pro_300k", "unknown", "pro_110k", "person@example.com"])(
    "never invents a paid plan for %s",
    (plan) => {
      trackEvent("plan_card_view", { product: "send", plan });
      expect(tracker.mock.lastCall?.[1]).toMatchObject({ selection_state: "unknown" });
      expect(tracker.mock.lastCall?.[1]).not.toHaveProperty("plan");
      expect(tracker.mock.lastCall?.[1]).not.toHaveProperty("plan_label");
    },
  );
  it("keeps other Pro tiers distinct using the public catalog", () => {
    trackEvent("plan_card_view", { product: "send", plan: "Pro 220K" });
    expect(tracker.mock.lastCall?.[1]).toMatchObject({ plan: "pro_200k" });
  });
  it("does not infer a card's intent from a previous Mail/Send cookie", () => {
    document.cookie = intentCookie({ product: "mail", plan: "duo" }, false);
    trackEvent("plan_card_view", { plan: "Starter" });
    expect(tracker.mock.lastCall?.[1]).toMatchObject({ product: "send", plan: "starter" });
    document.cookie = intentCookie({ product: "send", plan: "pro_100k" }, false);
    trackEvent("cta_pricing_click", { product: "mail", plan: "Duo" });
    expect(tracker.mock.lastCall?.[1]).toMatchObject({ product: "mail", plan: "duo" });
    trackEvent("plan_card_view", { product: "mail", plan: "Starter" });
    expect(tracker.mock.lastCall?.[1]).toMatchObject({
      product: "mail",
      selection_state: "unknown",
    });
    expect(tracker.mock.lastCall?.[1]).not.toHaveProperty("plan");
  });
  it("carries unselected intent without a purchasable choose code", () => {
    const context = clickContext({ href: "/signup?product=mail&plan=choose" });
    expect(context).toMatchObject({ product: "mail", selection_state: "unselected" });
    expect(context).not.toHaveProperty("plan");
    const href = trackedSignupHref("/signup?product=mail&plan=choose&lang=pt-BR", context);
    expect(new URL(href, "https://mepmail.dev").searchParams.has("plan")).toBe(false);
    document.cookie = intentCookie(context, false);
    trackEvent("signup_start");
    expect(tracker.mock.lastCall?.[1]).toMatchObject({
      product: "mail",
      selection_state: "unselected",
    });
    expect(tracker.mock.lastCall?.[1]).not.toHaveProperty("plan");
  });
  it("preserves explicit signup intent over a different cookie and includes all five UTMs", () => {
    document.cookie = intentCookie({ product: "mail", plan: "solo" }, false);
    trackEvent("signup_start", { product: "send", plan: "Starter" });
    expect(tracker.mock.lastCall?.[1]).toMatchObject({
      product: "send",
      plan: "starter",
      utm_source: "x",
      utm_medium: "post",
      utm_campaign: "send_launch",
      utm_content: "hero",
      utm_term: "api",
    });
  });
  it("exercises a real catalog PlanCard view and click without duplicate signup", () => {
    let observe: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: typeof observe) {
          observe = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const plan = PLANS.find((p) => p.rung === "pro_100k");
    if (!plan) throw Error("missing-public-plan");
    try {
      mount(
        h(
          Fragment,
          null,
          h(SiteFunnelEvents),
          h(PlanCard, {
            plan: { ...plan, copy: EMPTY_PLAN_COPY },
            labels: {
              perMonth: "/month",
              limitsLabel: "Limits",
              overageLabel: "Overage",
              attachmentLabel: "Attachments",
              cta: "Choose Pro",
              ctaNote: "",
              featuredBadge: "Featured",
            },
          }),
        ),
      );
      act(() => observe?.([{ isIntersecting: true }]));
      click("a");
      expect(tracker.mock.calls.map((c) => c[0])).toEqual([
        "plan_card_view",
        "signup_start",
        "cta_pricing_click",
      ]);
      for (const [, props] of tracker.mock.calls)
        expect(props).toMatchObject({ product: "send", plan: "pro_100k", plan_label: "Pro 110K" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("uses the real Mail CTA with tracker absent and leaves navigation intact", () => {
    delete (window as MeasuredWindow).umami;
    mount(
      h(
        Fragment,
        null,
        h(SiteFunnelEvents),
        h(SignupCta, { label: "Choose mail", mailboxPlan: "choose" }),
      ),
    );
    expect(() => click("a")).not.toThrow();
    expect(document.querySelector("a")?.getAttribute("href")).toContain("product=mail");
    expect(
      new URL(
        document.querySelector("a")?.getAttribute("href") ?? "",
        "https://mepmail.dev",
      ).searchParams.has("plan"),
    ).toBe(false);
  });
});

describe("intent state survives delegated navigation", () => {
  it.each(["unknown", "unselected"] as const)(
    "round-trips Send %s without silently selecting Free",
    (selection_state) => {
      const context = { product: "send" as const, selection_state };
      const href = trackedSignupHref("/signup?lang=pt-BR", context);
      expect(clickContext({ href })).toMatchObject(context);
      document.cookie = intentCookie(context, false);
      trackEvent("signup_start");
      expect(tracker.mock.lastCall?.[1]).toMatchObject(context);
      expect(tracker.mock.lastCall?.[1]).not.toHaveProperty("plan");
      trackEvent("cta_pricing_click", context);
      expect(tracker.mock.lastCall?.[1]).toMatchObject(context);
      expect(tracker.mock.lastCall?.[1]).not.toHaveProperty("plan");
    },
  );
  it("uses requested signup URL intent instead of a stale different-product cookie", () => {
    document.cookie = intentCookie({ product: "mail", plan: "solo" }, false);
    window.history.replaceState({}, "", "/signup?product=send&plan=starter&utm_source=x");
    trackEvent("signup_start");
    expect(tracker.mock.lastCall?.[1]).toMatchObject({ product: "send", plan: "starter" });
  });
  it("the real Mail CTA carries its own plan and emits only one signup", () => {
    document.cookie = intentCookie({ product: "send", plan: "pro_100k" }, false);
    mount(
      h(
        Fragment,
        null,
        h(SiteFunnelEvents),
        h(SignupCta, { label: "Duo", plan: "Duo", mailboxPlan: "duo" }),
      ),
    );
    click("a");
    expect(tracker.mock.calls.map((c) => c[0])).toEqual(["signup_start", "cta_pricing_click"]);
    for (const [, props] of tracker.mock.calls)
      expect(props).toMatchObject({
        product: "mail",
        plan: "duo",
        plan_label: "Duo",
        utm_term: "api",
      });
  });
});
