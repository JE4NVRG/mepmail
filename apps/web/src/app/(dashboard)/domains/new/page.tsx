import { headers } from "next/headers";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Crumb, CrumbEnd, PageHeader } from "@/components/page-header";
import { purchaseReturnPath, withPurchaseReturn } from "@/lib/purchase-return";
import { getAuth } from "@/server/auth";
import { AddDomainForm } from "./add-domain-form";

export default async function NewDomainPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; next?: string }>;
}) {
  const [nav, t, session, params] = await Promise.all([
    getTranslations("nav"),
    getTranslations("domains"),
    headers().then((h) => getAuth().api.getSession({ headers: h })),
    searchParams,
  ]);
  const returnTo = purchaseReturnPath(params.next);
  return (
    <>
      <PageHeader
        actions={
          returnTo ? (
            <Link href={returnTo} className="ms-btn ms-btn-secondary">
              {t("purchaseReturn")}
            </Link>
          ) : undefined
        }
        title={t("new.title")}
        subtitle={t(params.created ? "new.stepLine2" : "new.stepLine")}
        breadcrumb={
          <>
            <Crumb href={withPurchaseReturn("/domains", returnTo)} label={nav("domains")} />
            <CrumbEnd label={t("new.title")} />
          </>
        }
      />
      {/* The dashboard layout already redirects unauthenticated users; the
          fallback only satisfies the nullable session type. */}
      <AddDomainForm userEmail={session?.user.email ?? ""} />
    </>
  );
}
