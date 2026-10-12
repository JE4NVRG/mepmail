import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { type LegalDoc, LegalDocument } from "@/components/legal-document";
import { publicPageUrls } from "@/server/public-seo";

export default async function PrivacyPage() {
  const t = await getTranslations("legal");
  const doc = t.raw("privacy") as LegalDoc;
  return (
    <LegalDocument
      doc={doc}
      links={{ terms: t("terms.title"), privacy: t("privacy.title"), refund: t("refund.title") }}
    />
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const seo = await publicPageUrls("/privacy");
  const t = await getTranslations("legal");
  // Legal pages are real public content (linked from the footer), so they opt
  // back into indexing against the private-by-default robots in layout.tsx.
  return {
    title: t("privacy.title"),
    description: t("privacy.intro"),
    alternates: seo.alternates,
    robots: { index: true, follow: true },
  };
}
