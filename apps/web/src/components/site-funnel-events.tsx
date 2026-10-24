"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { trackEvent } from "@/lib/analytics";
import {
  clickContext,
  funnelClickProps,
  intentCookie,
  publicFunnelPath,
  trackedSignupHref,
} from "@/lib/funnel-tracking";

/** Captures only public navigation; no form values, IDs or authenticated content. */
export function SiteFunnelEvents() {
  const pathname = usePathname();
  useEffect(() => {
    if (!publicFunnelPath(pathname ?? window.location.pathname)) return;
    const origin = window.location.origin;
    const urlFor = (anchor: HTMLAnchorElement) => {
      try {
        return new URL(anchor.href, origin);
      } catch {
        return null;
      }
    };
    const contextFor = (anchor: HTMLAnchorElement) =>
      clickContext({
        href: anchor.href,
        search: window.location.search,
        cookie: document.cookie,
        origin,
        ...(anchor.dataset.funnelProduct ? { product: anchor.dataset.funnelProduct } : {}),
        ...(anchor.dataset.funnelPlan ? { plan: anchor.dataset.funnelPlan } : {}),
      });
    const enrich = (anchor: HTMLAnchorElement) => {
      const url = urlFor(anchor);
      if (!url || url.origin !== origin || url.pathname !== "/signup") return;
      const value = trackedSignupHref(anchor.href, contextFor(anchor), origin);
      if (anchor.getAttribute("href") !== value) anchor.setAttribute("href", value);
    };
    const refresh = () => {
      for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) enrich(anchor);
    };
    refresh();
    if (window.location.pathname === "/signup") {
      const context = clickContext({
        href: window.location.href,
        search: window.location.search,
        cookie: document.cookie,
        origin,
      });
      document.cookie = intentCookie(context, window.location.protocol === "https:");
    }
    const onClick = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const url = urlFor(anchor);
      if (!url || url.origin !== origin) return;
      if (url.pathname === "/signup") {
        const context = contextFor(anchor);
        anchor.href = trackedSignupHref(anchor.href, context, origin);
        document.cookie = intentCookie(context, window.location.protocol === "https:");
        const props = { ...funnelClickProps(context), page: window.location.pathname };
        if (context.product === "send" && context.plan === "free") {
          trackEvent("cta_send_free_click", props);
        }
        // SignupCta already emits signup_start from its React handler.
        if (!anchor.hasAttribute("data-funnel-signup")) trackEvent("signup_start", props);
      } else if (window.location.pathname === "/pricing" && url.pathname === "/pricing") {
        const to = url.searchParams.get("focus");
        const from =
          new URLSearchParams(window.location.search).get("focus") === "mail" ? "mail" : "send";
        if ((to === "send" || to === "mail") && to !== from) {
          const context = clickContext({
            href: "/signup",
            search: window.location.search,
            cookie: document.cookie,
            origin,
            product: to,
            plan: "choose",
          });
          trackEvent("pricing_toggle", {
            ...funnelClickProps(context),
            from_product: from,
            page: "/pricing",
          });
        }
      }
    };
    document.addEventListener("click", onClick, true);
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      document.removeEventListener("click", onClick, true);
    };
  }, [pathname]);
  return null;
}
