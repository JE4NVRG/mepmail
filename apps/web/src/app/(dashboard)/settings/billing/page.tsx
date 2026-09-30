import { env } from "@millionsend/config";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { paidRung } from "@/lib/purchase-intent";
import { SettingsTabs } from "../settings-tabs";
import { BillingView } from "./billing-view";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string | string[]; rung?: string | string[] }>;
}) {
  // Billing does not exist on self-host: not forbidden, absent.
  if (!env.IS_CLOUD) notFound();
  const t = await getTranslations("settings");
  const params = await searchParams;
  const raw = params.checkout;
  const requestedRung = paidRung(params.rung);
  const checkout = raw === "success" || raw === "cancel" ? raw : null;
  return (
    <>
      <PageHeader title={t("tabs.billing")} />
      <SettingsTabs />
      <BillingView
        key={requestedRung ?? "current"}
        checkout={checkout}
        requestedRung={requestedRung}
      />
    </>
  );
}
