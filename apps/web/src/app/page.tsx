import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { publicPageUrls } from "@/server/public-seo";
import { LegacyHome, standaloneMailOpen } from "./home-legacy";
import { HomeV2 } from "./home-v2";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await publicPageUrls("/");
  const t = await getTranslations("landing");
  const domain = standaloneMailOpen();
  const title = t(domain ? "meta.domainTitle" : "meta.title");
  const description = t(domain ? "meta.domainDescription" : "meta.description");
  return {
    title: { absolute: title },
    description,
    alternates: seo.alternates,
    robots: { index: true, follow: true },
    openGraph: {
      title,
      description,
      type: "website",
      url: seo.url,
      locale: seo.ogLocale,
      images: [{ url: "/og.jpg", width: 1280, height: 640, alt: "MepMail" }],
    },
  };
}

/**
 * The public home. While Correio is sold on its own (production), the v2 home leads with
 * the two products side by side; with Mail closed or only as a Send add-on, the earlier
 * home keeps describing what those flags actually sell.
 */
export default async function RootPage() {
  // Called, not mounted: the page resolves the whole tree, as before the split.
  return standaloneMailOpen() ? HomeV2() : LegacyHome();
}
