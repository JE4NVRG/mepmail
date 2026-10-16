import enAuth from "../../messages/en/auth.json";
import enCommon from "../../messages/en/common.json";
import enCorreio from "../../messages/en/correio.json";
import enLanding from "../../messages/en/landing.json";
import ptAuth from "../../messages/pt-BR/auth.json";
import ptCommon from "../../messages/pt-BR/common.json";
import ptCorreio from "../../messages/pt-BR/correio.json";
import ptLanding from "../../messages/pt-BR/landing.json";

/** Namespaces read only through getTranslations (server); never needed by the browser. */
export const SERVER_ONLY_NAMESPACES = new Set([
  "alternatives",
  "changelog",
  "desktop",
  "guides",
  "integrations",
  "legal",
  "pricing",
  "security",
  "support",
  "status",
]);

export const PUBLIC_CLIENT_NAMESPACES = ["common", "landing", "auth", "correio"] as const;

/** Explicit public/auth routes only; unknown and authenticated paths keep the full fallback. */
export const PUBLIC_MESSAGE_PATHS = new Set([
  "/",
  "/alternatives/resend",
  "/changelog",
  "/correio",
  "/download",
  "/guides",
  "/integrations",
  "/pricing",
  "/security",
  "/support",
  "/support/chat",
  "/status",
  "/terms",
  "/privacy",
  "/refund",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/updates",
  "/updates/confirm",
]);

// Immutable public JSON modules are shared by locale, never a request/session.
// Public and auth use one union because Next preserves the root layout during
// their client-side transitions. Entry into the dashboard uses document navigation.
const PUBLIC_MESSAGES: Record<string, Record<string, unknown>> = {
  en: { common: enCommon, landing: enLanding, auth: enAuth, correio: enCorreio },
  "pt-BR": { common: ptCommon, landing: ptLanding, auth: ptAuth, correio: ptCorreio },
};

export function publicClientMessages(
  requestPath: string | null | undefined,
  locale: string,
): Record<string, unknown> | undefined {
  if (!requestPath?.startsWith("/") || requestPath.startsWith("//")) return undefined;
  const pathname = requestPath.split("?")[0]?.replace(/\/$/, "") || "/";
  if (!PUBLIC_MESSAGE_PATHS.has(pathname) && !/^\/guides\/[^/]+$/.test(pathname)) return undefined;
  return Object.hasOwn(PUBLIC_MESSAGES, locale) ? PUBLIC_MESSAGES[locale] : undefined;
}
