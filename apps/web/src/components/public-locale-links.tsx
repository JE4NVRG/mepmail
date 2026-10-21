"use client";

import { useLocale } from "next-intl";
import { useEffect } from "react";
import { type AppLocale, isAppLocale } from "@/lib/locale-cookie";
import { isCanonicalPublicPath, LANG_PARAM, linkHrefInLocale } from "@/lib/public-locale-url";

/**
 * Keeps a Portuguese visit in Portuguese (QA 2026-10-21, F1): public URLs are English
 * unless they carry ?lang=pt-BR, so a plain link from a Portuguese page used to land on
 * the English version. Just before the browser follows a same-site link (click, middle
 * click, keyboard, context menu), the link gains the page's ?lang=. The server-rendered
 * HTML keeps its canonical hrefs, so crawlers and hreflang are unchanged.
 */
export function PublicLocaleLinks() {
  const locale = useLocale();
  useEffect(() => {
    if (!isAppLocale(locale) || locale === "en") return;
    const page = new URL(window.location.href);
    if (!isCanonicalPublicPath(page.pathname) && !page.searchParams.has(LANG_PARAM)) return;
    const current: AppLocale = locale;
    const carry = (event: Event) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return;
      const next = linkHrefInLocale(new URL(anchor.href), new URL(window.location.href), current);
      if (next) anchor.setAttribute("href", next);
    };
    const events = ["click", "auxclick", "pointerdown", "keydown", "contextmenu"] as const;
    for (const name of events) document.addEventListener(name, carry, true);
    return () => {
      for (const name of events) document.removeEventListener(name, carry, true);
    };
  }, [locale]);
  return null;
}
