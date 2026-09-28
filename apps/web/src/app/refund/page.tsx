import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { type LegalDoc, LegalDocument } from "@/components/legal-document";

export default async function RefundPage() {
  const t = await getTranslations("legal");
  const doc = t.raw("refund") as LegalDoc;
  return (
    <LegalDocument
      doc={doc}
      links={{ terms: t("terms.title"), privacy: t("privacy.title"), refund: t("refund.title") }}
    />
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("legal");
  // Legal pages are real public content (linked from the footer), so they opt
  // back into indexing against the private-by-default robots in layout.tsx.
  return {
    title: t("refund.title"),
    description: t("refund.intro"),
    robots: { index: true, follow: true },
  };
}
