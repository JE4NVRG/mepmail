import type { AdConsentState } from "./ad-consent";

const configuredPixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID;
export const META_PIXEL_ID =
  configuredPixelId && /^[0-9]{5,30}$/.test(configuredPixelId)
    ? configuredPixelId
    : "1418150576403119";
export const META_ORIGIN = "https://mepmail.dev";
/** Public offer documents that may load the Pixel after consent (CSP mirrors this in next.config.ts). */
export const META_PUBLIC_PATHS: ReadonlySet<string> = new Set(["/", "/pricing", "/correio"]);
const PUBLIC_PATHS = META_PUBLIC_PATHS;
/** Product pages: ViewContent on arrival instead of when the plans section shows. */
const VIEW_CONTENT = new Map([
  ["/pricing", { content_ids: ["send-pro"], content_name: "MepMail Send Pro" }],
  ["/correio", { content_ids: ["mail-correio"], content_name: "MepMail Correio" }],
]);
const UTM_KEYS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]);
const AD_ID_KEYS = new Set(["campaign_id", "adset_id", "ad_id"]);
const META_REFERRER_ORIGINS = new Set([
  "https://www.facebook.com",
  "https://l.facebook.com",
  "https://lm.facebook.com",
  "https://www.instagram.com",
  "https://l.instagram.com",
]);
const FACEBOOK_LINK_ORIGINS = new Set(["https://l.facebook.com", "https://lm.facebook.com"]);
export const PUBLIC_HASHES: ReadonlySet<string> = new Set([
  "",
  "#planos",
  "#como-funciona",
  "#comparativo",
  "#mcp",
]);

/** Parses a page or referrer URL, refusing control characters, credentials and dot tricks. */
export function contextUrl(value: string): URL | null {
  // URL parsing otherwise drops control characters or accepts embedded credentials.
  if (value.trim() !== value || value.includes("\\")) return null;
  for (let index = 0; index < value.length; index++) {
    const character = value.charCodeAt(index);
    if (character <= 31 || character === 127) return null;
  }
  try {
    const url = new URL(value);
    const path = /^https:\/\/[^/?#]+([^?#]*)/.exec(value)?.[1];
    // Do not approve an original referrer with a private path hidden by dot normalization.
    return url.username || url.password || path === undefined || (path || "/") !== url.pathname
      ? null
      : url;
  } catch {
    return null;
  }
}

/** Pixel sees document URL/referrer itself: reject unsafe context before loading it. */
export function safeMetaUrl(value: string): URL | null {
  const url = contextUrl(value);
  if (
    !url ||
    url.origin !== META_ORIGIN ||
    !PUBLIC_PATHS.has(url.pathname) ||
    !PUBLIC_HASHES.has(url.hash)
  )
    return null;
  const seen = new Set<string>();
  for (const [key, item] of url.searchParams) {
    if (seen.has(key)) return null;
    seen.add(key);
    if (key === "fbclid") {
      if (!/^[A-Za-z0-9_-]{10,256}$/.test(item)) return null;
    } else if (AD_ID_KEYS.has(key)) {
      // Canonical, bounded decimal identifiers only; never arbitrary campaign metadata.
      if (!/^[1-9][0-9]{4,29}$/.test(item)) return null;
    } else if (
      !UTM_KEYS.has(key) ||
      !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,79}$/.test(item) ||
      /(?:token|secret|password|authorization|bearer|session|jwt|api.?key)/i.test(item) ||
      /[A-Za-z0-9]{32,}/.test(item)
    )
      return null;
  }
  return url;
}

export function safeMetaContext(href: string, referrer: string): boolean {
  if (!safeMetaUrl(href)) return false;
  if (!referrer) return true;
  if (safeMetaUrl(referrer)) return true;
  const url = contextUrl(referrer);
  if (!url || !META_REFERRER_ORIGINS.has(url.origin) || url.hash) return false;
  if (url.pathname === "/" && !url.search) return true;
  if (!FACEBOOK_LINK_ORIGINS.has(url.origin) || url.pathname !== "/l.php") return false;
  // The SDK can transmit the original referrer. Validate every parameter, including
  // the optional link-shim hash; sanitizing manual event data cannot hide an unsafe URL.
  const seen = new Set<string>();
  for (const [key, item] of url.searchParams) {
    if (seen.has(key)) return false;
    seen.add(key);
    if (key === "u") {
      if (!safeMetaUrl(item)) return false;
    } else if (
      key !== "h" ||
      !/^[A-Za-z0-9_-]{10,256}$/.test(item) ||
      /(?:token|secret|password|authorization|bearer|session|jwt|api.?key)/i.test(item)
    ) {
      return false;
    }
  }
  return seen.has("u");
}

export type MetaCommand = (...args: unknown[]) => void;
export interface MetaPublicPort {
  href(): string;
  referrer(): string;
  consent(): AdConsentState;
  load(): Promise<MetaCommand>;
  watchPlans(callback: () => void): () => void;
  leaveDocument(href: string): void;
}

/** Only two manual public events. Checkout and payment belong to server CAPI. */
export function createMetaPublicController(port: MetaPublicPort) {
  let command: MetaCommand | undefined;
  let loading = false;
  let requested = false;
  let pageKey = "";
  let viewKey = "";
  let stopPlans: (() => void) | undefined;
  const eligible = () =>
    port.consent() === "accepted" && safeMetaContext(port.href(), port.referrer());
  const revoke = () => {
    command?.("consent", "revoke");
    stopPlans?.();
    stopPlans = undefined;
  };
  const currentKey = () => {
    const url = safeMetaUrl(port.href());
    return url ? `${url.pathname}${url.search}` : "";
  };
  const viewContent = () => {
    const key = currentKey();
    if (!command || !eligible() || !key || viewKey === key) return;
    viewKey = key;
    const product =
      VIEW_CONTENT.get(safeMetaUrl(port.href())?.pathname ?? "") ?? VIEW_CONTENT.get("/pricing")!;
    command("trackSingle", META_PIXEL_ID, "ViewContent", { ...product, content_type: "product" });
  };
  const reconcile = () => {
    if (!eligible()) {
      revoke();
      return;
    }
    if (!command) {
      if (loading) return;
      loading = requested = true;
      void port
        .load()
        .then((loaded) => {
          command = loaded;
          loading = false;
          // Late SDK load/consent response must never resurrect a withdrawn visit.
          reconcile();
        })
        .catch(() => {
          loading = false;
        });
      return;
    }
    command("consent", "grant");
    const key = currentKey();
    if (pageKey !== key) {
      pageKey = key;
      command("trackSingle", META_PIXEL_ID, "PageView");
      stopPlans?.();
      stopPlans = undefined;
    }
    if (VIEW_CONTENT.has(safeMetaUrl(port.href())?.pathname ?? "")) viewContent();
    else if (!stopPlans && viewKey !== key) stopPlans = port.watchPlans(viewContent);
  };
  return {
    reconcile,
    beforeNavigation(href: string): boolean {
      if (!requested || safeMetaContext(href, port.referrer())) return false;
      revoke();
      port.leaveDocument(href);
      return true;
    },
    dispose: revoke,
  };
}

type Fbq = MetaCommand & {
  queue: unknown[][];
  callMethod?: MetaCommand;
  push?: MetaCommand;
  loaded: boolean;
  version: string;
  disablePushState: boolean;
};
type MetaWindow = Window & { fbq?: Fbq; _fbq?: Fbq };

/** Meta's manual base snippet, loaded only after the server has accepted consent.
 * autoConfig=false and disablePushState are documented in Meta's own GTM template:
 * github.com/facebook/GoogleTagManager-WebTemplate-For-FacebookPixel/blob/main/template.tpl
 * No advanced matching fields and no optinMetaEnabledCapi command.
 */
export function loadManualMetaSdk(win: Window, doc: Document): Promise<MetaCommand> {
  const target = win as MetaWindow;
  if (target.fbq || target._fbq) return Promise.reject(new Error("foreign_meta_sdk"));
  const fbq = ((...args: unknown[]) => {
    if (fbq.callMethod) fbq.callMethod(...args);
    else fbq.queue.push(args);
  }) as Fbq;
  fbq.queue = [];
  fbq.push = fbq;
  fbq.loaded = true;
  fbq.version = "2.0";
  fbq.disablePushState = true;
  target.fbq = target._fbq = fbq;
  fbq("consent", "revoke");
  fbq("set", "autoConfig", false, META_PIXEL_ID);
  fbq("init", META_PIXEL_ID);
  return new Promise((resolve, reject) => {
    const script = doc.createElement("script");
    const timeout = setTimeout(() => reject(new Error("meta_sdk_unavailable")), 15_000);
    script.async = true;
    script.src = "https://connect.facebook.net/en_US/fbevents.js";
    script.referrerPolicy = "no-referrer";
    script.onload = () => {
      clearTimeout(timeout);
      if (typeof fbq.callMethod === "function") resolve(fbq);
      else reject(new Error("meta_sdk_unavailable"));
    };
    script.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("meta_sdk_unavailable"));
    };
    doc.head.appendChild(script);
  });
}

/** A loaded SDK belongs to this public document. Private navigation creates a new one. */
export function guardMetaNavigation(
  win: Window,
  doc: Document,
  controller: ReturnType<typeof createMetaPublicController>,
) {
  const click = (event: MouseEvent) => {
    if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (
      !(anchor instanceof HTMLAnchorElement) ||
      anchor.target === "_blank" ||
      anchor.hasAttribute("download")
    )
      return;
    const url = new URL(anchor.href, win.location.href);
    if (url.origin === win.location.origin && controller.beforeNavigation(url.href)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const pop = () => {
    if (!controller.beforeNavigation(win.location.href)) controller.reconcile();
  };
  const push = win.history.pushState;
  const replace = win.history.replaceState;
  const wrap =
    (original: typeof push): typeof push =>
    (data, unused, url) => {
      if (url != null) {
        const next = new URL(String(url), win.location.href);
        if (next.origin === win.location.origin && controller.beforeNavigation(next.href)) return;
      }
      original.call(win.history, data, unused, url);
      controller.reconcile();
    };
  const guardedPush = wrap(push);
  const guardedReplace = wrap(replace);
  win.history.pushState = guardedPush;
  win.history.replaceState = guardedReplace;
  doc.addEventListener("click", click, true);
  win.addEventListener("popstate", pop);
  win.addEventListener("hashchange", pop);
  return () => {
    doc.removeEventListener("click", click, true);
    win.removeEventListener("popstate", pop);
    win.removeEventListener("hashchange", pop);
    if (win.history.pushState === guardedPush) win.history.pushState = push;
    if (win.history.replaceState === guardedReplace) win.history.replaceState = replace;
  };
}
