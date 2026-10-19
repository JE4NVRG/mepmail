import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { publicPageUrls } from "@/server/public-seo";
import { CorreioLegacy } from "./correio-legacy";
import { CorreioV2 } from "./correio-v2";

const canonical = "/correio";
const earlyAccessOpen = () => process.env.MAILBOX_EARLY_ACCESS_OPEN === "true";

export async function generateMetadata(): Promise<Metadata> {
  const seo = await publicPageUrls(canonical);
  const t = await getTranslations("correio");
  return {
    title: { absolute: t("meta.title") },
    description: t("meta.description"),
    alternates: seo.alternates,
    robots: { index: earlyAccessOpen(), follow: true },
    openGraph: {
      title: t("meta.title"),
      description: t("meta.description"),
      url: seo.url,
      locale: seo.ogLocale,
      type: "website",
      // The share image is ./opengraph-image.tsx, in the visitor's language.
    },
  };
}

/**
 * /correio. Sold on its own (production), the v2 page leads with the domain email, the
 * agent's permissions and the three plans; closed or only as a Send add-on, the earlier
 * page keeps the preview, the add-on calculator and their eligibility rules.
 */
export default async function CorreioPage() {
  const standaloneOpen = earlyAccessOpen() && process.env.MAILBOX_STANDALONE_OPEN === "true";
  // Called, not mounted: the page resolves the whole tree, as before the split.
  return standaloneOpen ? CorreioV2() : CorreioLegacy();
}
