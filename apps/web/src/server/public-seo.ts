import type { Metadata } from "next";
import { headers } from "next/headers";
import { getLocale } from "next-intl/server";
import { isAppLocale } from "@/lib/locale-cookie";
import { languageAlternates, localizedPath, URL_LOCALE_HEADER } from "@/lib/public-locale-url";

/**
 * Canonical, hreflang and Open Graph URL of an indexable public page. A page
 * opened as `?lang=pt-BR` is its own canonical (the Portuguese copy search
 * engines index); the plain path, whatever language it negotiated for the
 * visitor, canonicalizes to itself, the English and x-default URL.
 */
export async function publicPageUrls(path: string): Promise<{
  alternates: NonNullable<Metadata["alternates"]>;
  url: string;
  ogLocale: string;
}> {
  const urlLocale = (await headers()).get(URL_LOCALE_HEADER);
  const url = localizedPath(path, isAppLocale(urlLocale) ? urlLocale : "en");
  return {
    alternates: { canonical: url, languages: languageAlternates(path) },
    url,
    // og:locale follows the copy actually rendered.
    ogLocale: (await getLocale()) === "pt-BR" ? "pt_BR" : "en_US",
  };
}
