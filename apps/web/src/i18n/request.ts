import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import {
  type AppLocale,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALES,
  pickLocale,
} from "@/lib/locale-cookie";

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
  "integrations",
  "correio",
  "changelog",
  "security",
  "support",
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
 * Cookie-based locale, no URL prefixes. Messages are namespaced by file:
 * messages/<locale>/<ns>.json → useTranslations("<ns>"). Without the cookie
 * (a visitor who never touched the dashboard switcher) the browser's own
 * Accept-Language decides, so a pt-BR visitor meets the auth screens in
 * Portuguese on the first visit.
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const headerList = await headers();
  const cookieValue = store.get(LOCALE_COOKIE)?.value;
  const locale: AppLocale = isAppLocale(cookieValue)
    ? cookieValue
    : pickLocale(headerList.get("accept-language"));
  const entries = await Promise.all(
    NAMESPACES.map(
      async (ns) => [ns, (await import(`../../messages/${locale}/${ns}.json`)).default] as const,
    ),
  );
  return { locale, messages: Object.fromEntries(entries) };
});
