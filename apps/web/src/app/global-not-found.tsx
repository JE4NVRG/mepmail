import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "@/styles/globals.css";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import { StatusPage } from "@/components/status-page";
import { THEME_INIT_SCRIPT, THEME_KEY } from "@/lib/theme";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common.notFound");
  return { title: `404 · ${t("title")} · MepMail`, robots: { index: false, follow: false } };
}

/** Unmatched URLs only; data-dependent notFound() keeps its existing route layout. */
export default async function GlobalNotFound() {
  const [locale, t, landing, status, store] = await Promise.all([
    getLocale(),
    getTranslations("common.notFound"),
    getTranslations("landing"),
    getTranslations("status"),
    cookies(),
  ]);
  const theme = store.get(THEME_KEY)?.value;
  return (
    <html
      lang={locale}
      {...(theme === "light" ? { "data-theme": "light" } : {})}
      suppressHydrationWarning
    >
      <body className="ms">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: existing static theme bootstrap, no request data */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <StatusPage
          code="404"
          title={t("title")}
          body={t("body")}
          actions={
            <>
              <a className="ms-btn ms-btn-primary" href="/emails">
                {t("cta")}
              </a>
              <a className="ms-btn ms-btn-secondary" href="/support">
                {landing("nav.support")}
              </a>
              <a className="ms-btn ms-btn-secondary" href="/status">
                {status("eyebrow")}
              </a>
            </>
          }
        />
      </body>
    </html>
  );
}
