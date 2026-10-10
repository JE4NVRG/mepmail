import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
import "@/styles/globals.css";
import { env } from "@millionsend/config";
import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { AdvertisingConsent } from "@/components/advertising-consent";
import { Providers } from "@/components/providers";
import { UmamiAnalytics } from "@/components/umami-analytics";
import { SERVER_ONLY_NAMESPACES } from "@/lib/client-messages";
import { THEME_INIT_SCRIPT, THEME_KEY } from "@/lib/theme";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#000000",
};

// metadataBase comes from the runtime APP_BASE_URL, so a self-hosted instance
// emits its own absolute Open Graph URLs rather than ours. Copy mirrors the
// LP's meta (mepmail-lp src/messages) so a shared app link reads the same
// as the site's; keep the two in step.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common");
  return {
    ...(env.APP_BASE_URL ? { metadataBase: new URL(env.APP_BASE_URL) } : {}),
    title: { default: t("appName"), template: `%s · ${t("appName")}` },
    description: t("meta.description"),
    // Everything behind the sign-in is private; the auth pages opt back in.
    robots: { index: false, follow: false },
    icons: {
      icon: "/logo/mepmail-favicon.svg",
      apple: [{ url: "/logo/mepmail-app-180.png", sizes: "180x180", type: "image/png" }],
    },
    applicationName: t("appName"),
    appleWebApp: { capable: true, title: t("appName"), statusBarStyle: "default" },
    openGraph: {
      siteName: t("appName"),
      type: "website",
      title: t("meta.title"),
      description: t("meta.description"),
      images: [{ url: "/og.jpg", width: 1280, height: 640, alt: t("appName") }],
    },
    twitter: { card: "summary_large_image" },
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  // Cookie mirror of the localStorage preference lets SSR paint the right
  // theme; the inline script below corrects any stale cookie pre-paint.
  const theme = (await cookies()).get(THEME_KEY)?.value;
  // The browser gets only what client components read: the public pages render
  // these long namespaces on the server, and shipping them made every page (the 404
  // included) carry ~110 KB of copy it never uses.
  const messages = Object.fromEntries(
    Object.entries(await getMessages()).filter(([ns]) => !SERVER_ONLY_NAMESPACES.has(ns)),
  );
  return (
    <html
      lang={locale}
      {...(theme === "light" ? { "data-theme": "light" } : {})}
      suppressHydrationWarning
    >
      <body className="ms">
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static theme bootstrap, no user input */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <UmamiAnalytics />
        <NextIntlClientProvider messages={messages}>
          <Providers>
            {children}
            <AdvertisingConsent />
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
