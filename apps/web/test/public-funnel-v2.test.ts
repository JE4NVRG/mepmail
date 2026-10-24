// @vitest-environment jsdom
import { act, Fragment, createElement as h, type ReactNode, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({ path: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.path }));

import { SignupCta } from "@/components/signup-cta";
import { SiteFunnelEvents } from "@/components/site-funnel-events";
import { trackEvent } from "@/lib/analytics";
import {
  clickContext,
  intentCookie,
  publicFunnelPath,
  trackedSignupHref,
} from "@/lib/funnel-tracking";

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
    expect(clickContext({ href: "/signup" })).toEqual({ product: "send", plan: "free" });
    expect(
      clickContext({
        href: "/signup",
        search: "?utm_source=person%40example.com&utm_medium=sk_live_do_not_collect",
      }),
    ).toEqual({ product: "send", plan: "free" });
  });
  it("never rewrites an external signup or an unrelated action", () => {
    const ctx = clickContext({ href: "/signup" });
    expect(trackedSignupHref("https://other.example/signup", ctx)).toBe(
      "https://other.example/signup",
    );
    expect(trackedSignupHref("/settings/billing", ctx)).toBe("/settings/billing");
  });
  it("stores only bounded product intent, not identity or payment authority", () => {
    const c = intentCookie({ product: "mail", plan: "choose", utm_source: "x" }, true);
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
    expect(tracker.mock.calls[0]?.[1]).toMatchObject({ product: "mail", plan: "choose" });
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
