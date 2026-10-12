import type { AppLocale } from "@/lib/locale-cookie";

/**
 * The public pages pick their language from the NEXT_LOCALE cookie or the
 * browser's Accept-Language, on one URL. Search engines crawl without either,
 * so they only ever saw the English copy. `?lang=pt-BR` gives the Portuguese
 * copy its own URL to crawl and index; English stays on the plain path, which
 * is also the x-default that keeps negotiating for people.
 */
export const LANG_PARAM = "lang";

/** Set by the proxy from `?lang=`, only when the URL itself names the language. */
export const URL_LOCALE_HEADER = "x-mepmail-url-locale";

/** The URL of a public page in a locale: the plain path for English, `?lang=pt-BR` for Portuguese. */
export function localizedPath(path: string, locale: AppLocale): string {
  return locale === "en" ? path : `${path}?${LANG_PARAM}=${locale}`;
}

/** hreflang alternates for a public page: each language's URL plus the negotiating x-default. */
export function languageAlternates(path: string): Record<string, string> {
  return {
    en: localizedPath(path, "en"),
    "pt-BR": localizedPath(path, "pt-BR"),
    "x-default": path,
  };
}
