import { env } from "@millionsend/config";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { SettingsTabs } from "../settings-tabs";
import { BillingView } from "./billing-view";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string | string[]; correio?: string | string[] }>;
}) {
  // Billing does not exist on self-host: not forbidden, absent.
  if (!env.IS_CLOUD) notFound();
  const t = await getTranslations("settings");
  const params = await searchParams;
  const raw = params.checkout;
  const checkout = raw === "success" || raw === "cancel" ? raw : null;
  // Arriving from the Correio offer preselects the Send + Mail combo; nothing is bought here.
  const requestedMail = params.correio === "1";
  return (
    <>
      <PageHeader title={t("tabs.billing")} />
      <SettingsTabs />
      <BillingView checkout={checkout} requestedMail={requestedMail} />
    </>
  );
}
