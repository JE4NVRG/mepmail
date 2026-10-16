"use client";

import { useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import { type AppLocale, LOCALES, setLocaleCookie } from "@/lib/locale-cookie";
import { localeNavigationHref } from "@/lib/public-locale-url";

const DISPLAY_ORDER: AppLocale[] = ["pt-BR", "en"];
const SHORT: Record<AppLocale, string> = { "pt-BR": "PT", en: "EN" };

/**
 * Landing language control. Two plain buttons that remember the choice in the
 * NEXT_LOCALE cookie. Public URLs also change to the selected language; other
 * routes keep cookie-based refresh unless they already name a locale.
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
            const href = localeNavigationHref(new URL(window.location.href), value);
            if (href === null) {
              router.refresh();
              return;
            }
            router.replace(href);
          }}
        >
          {SHORT[value]}
        </button>
      ))}
    </fieldset>
  );
}
