import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { type LegalDoc, LegalDocument } from "@/components/legal-document";
import { publicPageUrls } from "@/server/public-seo";
import "../landing.css";

/**
 * Public account-deletion page: the steps, what is deleted and what is kept. Google Play links
 * it from the MepMail app's listing (data safety, account deletion URL), so it must stay
 * reachable without signing in and name the app.
 */
export default async function AccountDeletionPage() {
  const t = await getTranslations("legal");
  const doc = t.raw("accountDeletion") as LegalDoc;
  return <LegalDocument doc={doc} />;
}

export async function generateMetadata(): Promise<Metadata> {
  const seo = await publicPageUrls("/account-deletion");
  const t = await getTranslations("legal");
  return {
    title: t("accountDeletion.title"),
    description: t("accountDeletion.intro"),
    alternates: seo.alternates,
    robots: { index: true, follow: true },
  };
}
