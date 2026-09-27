// Client-safe half of the locale plumbing: src/i18n/request.ts reads
// next/headers and cannot be imported from client components, so the cookie
// name and the languages live here and it imports them from here.
export const LOCALES = ["en", "pt-BR"] as const;
export type AppLocale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: AppLocale = "en";
export const LOCALE_COOKIE = "NEXT_LOCALE";
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Locale for a request without the cookie: the first language the browser
 * asks for that we speak, "pt" (any region) resolving to pt-BR and "en"
 * (any region) to en; English when nothing matches.
 */
export function pickLocale(acceptLanguage: string | null | undefined): AppLocale {
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().toLowerCase().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const quality = qParam ? Number(qParam.trim().slice(2)) : 1;
      return { tag, quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((entry) => entry.tag !== "")
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { tag } of ranked) {
    if (tag === "pt" || tag.startsWith("pt-")) return "pt-BR";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return DEFAULT_LOCALE;
}

/** Remembers the interface language for a year; the caller refreshes the tree so the server re-renders in it. */
export function setLocaleCookie(locale: AppLocale): void {
  // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API is unavailable in Safari.
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}`;
}
