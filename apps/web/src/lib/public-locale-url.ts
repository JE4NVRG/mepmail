import type { AppLocale } from "@/lib/locale-cookie";
import { GUIDE_SLUGS, guidePath } from "./guides";

/**
 * Indexable public pages have deterministic English URLs and a Portuguese
 * variant at ?lang=pt-BR. Utility/auth/private routes keep their existing
 * preference negotiation unless the URL explicitly selects a supported locale.
 */
export const LANG_PARAM = "lang";

/** Set only by the proxy, from the public path or an explicit supported ?lang=. */
export const URL_LOCALE_HEADER = "x-mepmail-url-locale";

const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/pricing",
  "/correio",
  "/download",
  "/desktop/correio/linux",
  "/alternatives/resend",
  "/integrations",
  "/security",
  "/support",
  "/status",
  "/changelog",
  "/guides",
  ...GUIDE_SLUGS.map(guidePath),
  "/terms",
  "/privacy",
  "/refund",
]);

/** Exact public pages only; never a prefix that could capture an auth/API route. */
export function isCanonicalPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname === "/" ? pathname : pathname.replace(/\/+$/, ""));
}

/** A URL update for public/explicit-locale navigation; null keeps cookie + refresh elsewhere. */
export function localeNavigationHref(url: URL, locale: AppLocale): string | null {
  if (!isCanonicalPublicPath(url.pathname) && !url.searchParams.has(LANG_PARAM)) return null;
  const target = new URL(url);
  if (locale === "en") target.searchParams.delete(LANG_PARAM);
  else target.searchParams.set(LANG_PARAM, locale);
  return `${target.pathname}${target.search}${target.hash}`;
}

/** The URL of a public page in a locale: the plain path for English, `?lang=pt-BR` for Portuguese. */
export function localizedPath(path: string, locale: AppLocale): string {
  return locale === "en" ? path : `${path}?${LANG_PARAM}=${locale}`;
}

/** hreflang alternates for a public page: English, Portuguese and English x-default. */
export function languageAlternates(path: string): Record<string, string> {
  return {
    en: localizedPath(path, "en"),
    "pt-BR": localizedPath(path, "pt-BR"),
    "x-default": path,
  };
}
