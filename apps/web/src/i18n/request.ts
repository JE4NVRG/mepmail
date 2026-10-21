import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import {
  type AppLocale,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALES,
  pickLocale,
} from "@/lib/locale-cookie";
import { URL_LOCALE_HEADER } from "@/lib/public-locale-url";

export { type AppLocale, DEFAULT_LOCALE, LOCALE_COOKIE, LOCALES };

const NAMESPACES = [
  "common",
  "audience",
  "block-editor",
  "auth",
  "broadcasts",
  "console",
  "deliverability",
  "alternatives",
  "landing",
  "envio",
  "integrations",
  "guides",
  "correio",
  "desktop",
  "changelog",
  "security",
  "support",
  "status",
  "public-metrics",
  "legal",
  "nav",
  "pricing",
  "emails",
  "bounce-guidance",
  "domains",
  "api-keys",
  "logs",
  "mailboxes",
  "mailboxes-agent",
  "mailboxes-clients",
  "mailboxes-offline",
  "mailboxes-rules",
  "mailboxes-blocks",
  "mailboxes-external",
  "mailboxes-activity",
  "mailboxes-service",
  "merge-fields",
  "metrics",
  "onboarding",
  "settings",
  "placeholders",
  "templates",
  "webhooks",
] as const;

function isAppLocale(value: string | undefined): value is AppLocale {
  return (LOCALES as readonly string[]).includes(value ?? "");
}

/**
 * Messages are namespaced by file: messages/<locale>/<ns>.json. The proxy
 * supplies the locale for canonical public paths (English by default) or an
 * explicit ?lang=. Elsewhere the cookie and then Accept-Language still decide,
 * including the first visit to an auth screen.
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const headerList = await headers();
  const urlLocale = headerList.get(URL_LOCALE_HEADER) ?? undefined;
  const cookieValue = store.get(LOCALE_COOKIE)?.value;
  const locale: AppLocale = isAppLocale(urlLocale)
    ? urlLocale
    : isAppLocale(cookieValue)
      ? cookieValue
      : pickLocale(headerList.get("accept-language"));
  const entries = await Promise.all(
    NAMESPACES.map(
      async (ns) => [ns, (await import(`../../messages/${locale}/${ns}.json`)).default] as const,
    ),
  );
  return { locale, messages: Object.fromEntries(entries) };
});
