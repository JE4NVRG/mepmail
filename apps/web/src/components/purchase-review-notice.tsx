"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { SignupReviewRequest } from "@/components/signup-review-request";
import { BtnSpinner } from "@/components/spinner";
import { purchaseDomainReviewHref } from "@/lib/purchase-return";
import { useTRPC } from "@/lib/trpc";

/** A checkout rejection can race a previously successful read-only preflight. */
export function isPurchaseReviewFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.startsWith("PURCHASE_REVIEW_")
  );
}

/** Only new purchases use this gate; existing invoices, cancellation and management stay separate. */
export function usePurchaseReview(enabled = true) {
  const trpc = useTRPC();
  const queries = useQueryClient();
  const eligibility = useQuery(
    trpc.billing.purchaseEligibility.queryOptions(undefined, { enabled, retry: false }),
  );
  const request = useMutation(
    trpc.billing.requestPurchaseReview.mutationOptions({
      onSuccess: async (result) => {
        queries.setQueryData(trpc.billing.purchaseEligibility.queryKey(), result);
        await queries.invalidateQueries(trpc.team.standing.queryFilter());
      },
    }),
  );
  return {
    enabled,
    eligibility,
    request,
    allowed:
      !enabled ||
      (!eligibility.isError && eligibility.data?.eligible === true && !request.isPending),
    refresh: () => eligibility.refetch(),
  };
}

export function PurchaseReviewNotice({
  review,
  returnTo,
}: {
  review: ReturnType<typeof usePurchaseReview>;
  returnTo?: string;
}) {
  const t = useTranslations("settings.billing.purchaseReview");
  const titleId = useId();
  if (!review.enabled || review.allowed) return null;
  const { eligibility, request } = review;
  const code = eligibility.data?.code;
  const loading = eligibility.isPending || request.isPending;
  const failed = eligibility.isError || request.isError;
  const manualReview =
    code === "send_review" ||
    code === "signup_review" ||
    code === "signup_sandbox" ||
    code === "suspended" ||
    code === "domain_review";
  return (
    <section
      className="ms-card"
      aria-labelledby={titleId}
      style={{ padding: 20, marginBlock: 16, borderColor: "var(--ms-warn-border)" }}
    >
      <h3 id={titleId} style={{ margin: "0 0 8px", fontSize: 16, color: "var(--ms-bone)" }}>
        {t("title")}
      </h3>
      <div role={failed ? "alert" : "status"} aria-live="polite">
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "var(--ms-bone)" }}>
          {loading ? t("checking") : failed ? t("failed") : t(`reasons.${code ?? "not_found"}`)}
        </p>
        {code === "domain_review" && eligibility.data?.domains.length ? (
          <p style={{ margin: "8px 0 0", overflowWrap: "anywhere", fontSize: 14 }}>
            {t("domains", { domains: eligibility.data.domains.join(", ") })}
          </p>
        ) : null}
      </div>
      <p style={{ margin: "8px 0 16px", fontSize: 13, lineHeight: 1.6, color: "var(--ms-muted)" }}>
        {t("beforePayment")}
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {code === "domain_required" ? (
          <Link href={purchaseDomainReviewHref(returnTo)} className="ms-btn ms-btn-primary">
            {t("verifyDomain")}
          </Link>
        ) : !manualReview ? (
          <Link href="/support" className="ms-btn ms-btn-secondary">
            {t("support")}
          </Link>
        ) : null}
        <button
          type="button"
          className="ms-btn ms-btn-secondary"
          disabled={loading || eligibility.isFetching}
          onClick={() => void review.refresh()}
        >
          <BtnSpinner on={eligibility.isFetching} />
          {t("retry")}
        </button>
      </div>
      {manualReview ? (
        <SignupReviewRequest
          beforeSubmitAction={async () => {
            const current = await request.mutateAsync();
            // The restriction may have been cleared while the form was open. The hook
            // publishes the new eligibility; no review receipt is invented in that case.
            return (
              current.code === "domain_review" ||
              current.code === "send_review" ||
              current.code === "signup_review" ||
              current.code === "signup_sandbox" ||
              current.code === "suspended"
            );
          }}
        />
      ) : null}
    </section>
  );
}
