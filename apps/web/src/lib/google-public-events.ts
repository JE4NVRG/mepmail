import type { AdConsentState } from "./ad-consent";
import { contextUrl, META_ORIGIN, META_PUBLIC_PATHS, PUBLIC_HASHES } from "./meta-public-events";

const configuredTagId = process.env.NEXT_PUBLIC_GOOGLE_TAG_ID;
/** GA4 web stream "MepMail site" (property MepMail, account JE4NDEV). */
export const GOOGLE_TAG_ID =
  configuredTagId && /^G-[A-Z0-9]{6,16}$/.test(configuredTagId) ? configuredTagId : "G-3624E08M6J";
const UTM_KEYS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]);
/** Google Ads auto-tagging: click identifiers plus its two bounded numeric markers. */
const CLICK_ID_KEYS = new Set(["gclid", "gbraid", "wbraid"]);
const NUMERIC_KEYS = new Map([
  ["gad_source", /^[0-9]{1,3}$/],
  ["gad_campaignid", /^[1-9][0-9]{4,19}$/],
]);
const SECRET = /(?:token|secret|password|authorization|bearer|session|jwt|api.?key)/i;
/** Consent Mode v2. Remarketing (ad_personalization) is never granted. */
const GRANTED = {
  analytics_storage: "granted",
  ad_storage: "granted",
  ad_user_data: "granted",
  ad_personalization: "denied",
} as const;
const DENIED = {
  analytics_storage: "denied",
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
} as const;

/** The tag reads the document URL itself: only public offer pages with known parameters. */
export function safeGoogleUrl(value: string): URL | null {
  const url = contextUrl(value);
  if (
    !url ||
    url.origin !== META_ORIGIN ||
    !META_PUBLIC_PATHS.has(url.pathname) ||
    !PUBLIC_HASHES.has(url.hash)
  )
    return null;
  const seen = new Set<string>();
  for (const [key, item] of url.searchParams) {
    if (seen.has(key)) return null;
    seen.add(key);
    const numeric = NUMERIC_KEYS.get(key);
    if (CLICK_ID_KEYS.has(key)) {
      if (!/^[A-Za-z0-9_-]{10,256}$/.test(item)) return null;
    } else if (numeric) {
      if (!numeric.test(item)) return null;
    } else if (
      // utm_term carries the Portuguese keyword (accents and spaces), never free text.
      !UTM_KEYS.has(key) ||
      !/^[\p{L}\p{N}][\p{L}\p{N}_. -]{0,79}$/u.test(item) ||
      SECRET.test(item) ||
      /[A-Za-z0-9]{32,}/.test(item)
    )
      return null;
  }
  return url;
}

/**
 * The referrer the tag may see: none, a public MepMail page, or another site's
 * bare origin (what strict-origin-when-cross-origin sends). Anything with a
 * path or query from elsewhere, or a private MepMail page, keeps the tag off.
 */
export function googleReferrer(referrer: string): string | null {
  if (!referrer) return "";
  const own = safeGoogleUrl(referrer);
  if (own) return `${own.origin}${own.pathname}`;
  const url = contextUrl(referrer);
  if (!url || url.protocol !== "https:" || url.origin === META_ORIGIN) return null;
  return url.pathname === "/" && !url.search && !url.hash ? `${url.origin}/` : null;
}

export function safeGoogleContext(href: string, referrer: string): boolean {
  return !!safeGoogleUrl(href) && googleReferrer(referrer) !== null;
}

export type GoogleCommand = (...args: unknown[]) => void;
export interface GooglePublicPort {
  href(): string;
  referrer(): string;
  consent(): AdConsentState;
  load(): Promise<GoogleCommand>;
  leaveDocument(href: string): void;
}

/**
 * Page views of public offer pages, plus `generate_lead` when a visitor leaves
 * for /signup. Nothing from the dashboard or the inboxes: a loaded tag never
 * survives a client navigation to a private route.
 */
export function createGooglePublicController(port: GooglePublicPort) {
  let command: GoogleCommand | undefined;
  let loading = false;
  let requested = false;
  let pageKey = "";
  const eligible = () =>
    port.consent() === "accepted" && safeGoogleContext(port.href(), port.referrer());
  const revoke = () => {
    command?.("consent", "update", DENIED);
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
          // A late tag load or consent response must never resurrect a withdrawn visit.
          reconcile();
        })
        .catch(() => {
          loading = false;
        });
      return;
    }
    command("consent", "update", GRANTED);
    const url = safeGoogleUrl(port.href());
    const key = url ? `${url.pathname}${url.search}` : "";
    if (url && pageKey !== key) {
      pageKey = key;
      command("event", "page_view", {
        send_to: GOOGLE_TAG_ID,
        page_location: `${url.origin}${key}`,
        page_referrer: googleReferrer(port.referrer()) ?? "",
      });
    }
  };
  return {
    reconcile,
    beforeNavigation(href: string): boolean {
      if (!requested || safeGoogleContext(href, port.referrer())) return false;
      const target = contextUrl(href);
      if (command && eligible() && target?.origin === META_ORIGIN && target.pathname === "/signup")
        command("event", "generate_lead", { send_to: GOOGLE_TAG_ID, transport_type: "beacon" });
      else revoke();
      port.leaveDocument(href);
      return true;
    },
    dispose: revoke,
  };
}

type GtagWindow = Window & { dataLayer?: unknown[]; gtag?: GoogleCommand };

/**
 * Google's gtag.js snippet, loaded only after the server has accepted consent.
 * Consent starts denied; the controller grants it. No automatic page view, no
 * Google signals, no ad personalization and redacted ad data.
 */
export function loadGoogleTag(win: Window, doc: Document): Promise<GoogleCommand> {
  const target = win as GtagWindow;
  if (target.gtag || target.dataLayer) return Promise.reject(new Error("foreign_google_tag"));
  const dataLayer: unknown[] = [];
  target.dataLayer = dataLayer;
  // gtag.js reads Arguments objects from the dataLayer, not arrays.
  function gtag() {
    // biome-ignore lint/complexity/noArguments: the documented gtag contract.
    dataLayer.push(arguments);
  }
  const command = gtag as GoogleCommand;
  target.gtag = command;
  command("consent", "default", DENIED);
  command("set", "ads_data_redaction", true);
  command("js", new Date());
  command("config", GOOGLE_TAG_ID, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });
  return new Promise((resolve, reject) => {
    const script = doc.createElement("script");
    const timeout = setTimeout(() => reject(new Error("google_tag_unavailable")), 15_000);
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${GOOGLE_TAG_ID}`;
    script.referrerPolicy = "no-referrer";
    script.onload = () => {
      clearTimeout(timeout);
      resolve(command);
    };
    script.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("google_tag_unavailable"));
    };
    doc.head.appendChild(script);
  });
}
