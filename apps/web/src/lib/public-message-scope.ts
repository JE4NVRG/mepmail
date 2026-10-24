import { publicClientMessages } from "@/lib/client-messages";
import { isCanonicalPublicPath } from "@/lib/public-locale-url";

// The root survives public → auth client navigation: retain the whole auth
// namespace and public controls rather than choosing the current page's keys.
const PUBLIC_UTILITIES: ReadonlySet<string> = new Set([
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/updates",
  "/updates/confirm",
  "/support/chat",
]);

// These controls mount only in dashboard/console layouts, never public/auth.
// Do not mutate the imported catalog: other requests and server translations
// still need all keys, including the abandoned native-support namespace.
const APP_ONLY_COMMON_KEYS: ReadonlySet<string> = new Set([
  "supportView",
  "teamSwitcher",
  "commandPalette",
]);

/**
 * CLIENT serialization only. Pass the proxy-overwritten x-mepmail-next value,
 * not a caller-supplied pathname header. proxy.ts covers all matched page URLs
 * and replaces that header from nextUrl; this is not an authorization boundary.
 * Missing/malformed/unknown targets retain the existing full app fallback.
 * Never cache cookie/session/consent/team state in this module.
 */
export function publicMarketingMessages(
  trustedRequestTarget: string | null | undefined,
  locale: string,
): Record<string, unknown> | undefined {
  if (!trustedRequestTarget?.startsWith("/") || trustedRequestTarget.startsWith("//")) {
    return undefined;
  }
  const path = trustedRequestTarget.split("?")[0];
  if (!path || /[\\#%\s]/.test(path)) return undefined;
  const pathname = path === "/" ? path : path.replace(/\/+$/, "");
  if (!isCanonicalPublicPath(pathname) && !PUBLIC_UTILITIES.has(pathname)) return undefined;

  // Reuse the existing immutable public/auth union, including routes such as
  // /desktop/correio/linux that previously fell back to every app namespace.
  const messages = publicClientMessages("/", locale);
  if (!messages) return undefined;
  const common = messages.common as Record<string, unknown>;
  return {
    ...messages,
    common: Object.fromEntries(
      Object.entries(common).filter(([key]) => !APP_ONLY_COMMON_KEYS.has(key)),
    ),
  };
}
