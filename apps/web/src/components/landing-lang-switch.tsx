"use client";

import { useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import { type AppLocale, LOCALES, setLocaleCookie } from "@/lib/locale-cookie";
import { LANG_PARAM } from "@/lib/public-locale-url";

const DISPLAY_ORDER: AppLocale[] = ["pt-BR", "en"];
const SHORT: Record<AppLocale, string> = { "pt-BR": "PT", en: "EN" };

/**
 * Landing language control. Two plain buttons that remember the choice in the
 * NEXT_LOCALE cookie and refresh the server tree, which re-renders the page
 * (copy, metadata and <html lang>) in the chosen locale. On a URL that names
 * its language (?lang=pt-BR, which outranks the cookie) the URL changes too.
 */
export function LandingLangSwitch({ label }: { label: string }) {
  const locale = useLocale();
  const router = useRouter();
  const order = DISPLAY_ORDER.filter((value) => (LOCALES as readonly string[]).includes(value));

  return (
    <fieldset className="gtm-lang">
      <legend>{label}</legend>
      {order.map((value) => (
        <button
          key={value}
          type="button"
          className={value === locale ? "is-current" : undefined}
          aria-pressed={value === locale}
          onClick={() => {
            if (value === locale) return;
            setLocaleCookie(value);
            const url = new URL(window.location.href);
            if (!url.searchParams.has(LANG_PARAM)) {
              router.refresh();
              return;
            }
            if (value === "en") url.searchParams.delete(LANG_PARAM);
            else url.searchParams.set(LANG_PARAM, value);
            router.replace(`${url.pathname}${url.search}${url.hash}`);
          }}
        >
          {SHORT[value]}
        </button>
      ))}
    </fieldset>
  );
}
