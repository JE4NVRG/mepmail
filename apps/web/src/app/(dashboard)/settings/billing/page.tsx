import { env } from "@millionsend/config";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { requestedPlan } from "@/lib/public-intent";
import { SettingsTabs } from "../settings-tabs";
import { BillingView } from "./billing-view";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{
    checkout?: string | string[];
    correio?: string | string[];
    pix?: string | string[];
    plan?: string | string[];
    interval?: string | string[];
  }>;
}) {
  // Billing does not exist on self-host: not forbidden, absent.
  if (!env.IS_CLOUD) notFound();
  const t = await getTranslations("settings");
  const params = await searchParams;
  const raw = params.checkout;
  // Back from a Pix Checkout: like a card return, the plan starts once Stripe confirms it.
  const checkout = raw === "success" || raw === "pix" ? "success" : raw === "cancel" ? raw : null;
  // Arriving from the Correio offer preselects the Send + Mail combo; nothing is bought here.
  const requestedMail = params.correio === "1";
  // A paid plan picked on the public pages (?plan=pro_100k) opens the comparison on it.
  const requestedRung = requestedPlan(params);
  return (
    <>
      <PageHeader title={t("tabs.billing")} />
      <SettingsTabs />
      <BillingView
        checkout={checkout}
        requestedMail={requestedMail}
        requestedRung={requestedRung}
        requestedInterval={params.interval === "year" ? "year" : "month"}
        pixReturned={params.pix === "paid"}
      />
    </>
  );
}
