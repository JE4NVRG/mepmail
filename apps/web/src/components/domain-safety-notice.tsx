"use client";

import type { PurchaseEligibility } from "@millionsend/billing";
import { useTranslations } from "next-intl";

export interface DomainSafetyNoticeInput {
  /** Cloud-only billing preflight. False keeps self-hosted DNS confirmation independent of billing. */
  enabled?: boolean | undefined;
  /** Pass only the current team's read-only preflight; this component never requests or clears review. */
  eligibility?: Pick<PurchaseEligibility, "code" | "eligible"> | null | undefined;
  /** Confirmed plan of the active team; a different team's membership must never be used. */
  accountPlan?: string | undefined;
  pending?: boolean | undefined;
  error?: boolean | undefined;
}

export type DomainSafetyState =
  | "dnsOnly"
  | "system"
  | "checking"
  | "unavailable"
  | "ready"
  | "domainReview"
  | "review"
  | "sandbox"
  | "suspended"
  | "paused";

export interface DomainSafetyNoticeModel {
  state: DomainSafetyState;
  variant: "success" | "warn";
  bodyKey: `security.${DomainSafetyState}`;
}

/** Presentation only: verified DNS never implies permission to send or permission to charge. */
export function domainSafetyNotice(input: DomainSafetyNoticeInput = {}): DomainSafetyNoticeModel {
  const result = (state: DomainSafetyState): DomainSafetyNoticeModel => ({
    state,
    variant: state === "ready" || state === "dnsOnly" || state === "system" ? "success" : "warn",
    bodyKey: `security.${state}`,
  });
  if (input.enabled === false) return result("dnsOnly");
  if (input.error) return result("unavailable");
  if (input.pending || !input.eligibility) return result("checking");
  switch (input.eligibility.code) {
    case "ready":
      return result(input.eligibility.eligible ? "ready" : "unavailable");
    case "domain_review":
      return result("domainReview");
    case "send_review":
    case "signup_review":
      return result("review");
    case "signup_sandbox":
      return result("sandbox");
    case "suspended":
      return result("suspended");
    case "guardrail_paused":
      return result("paused");
    case "domain_required":
      // DNS verification can finish before its preflight cache is invalidated/refetched.
      // Keep an unconfirmed state rather than contradicting DNS or claiming security clearance.
      return result("checking");
    case "not_found":
      // Purchase review excludes System accounts. This confirms DNS only, not sending clearance.
      return result(input.accountPlan === "system" ? "system" : "unavailable");
    default:
      return result("unavailable");
  }
}

/** Children of the existing GradientBanner. The parent retains its icon, layout and role=status. */
export function DomainSafetyNotice(input: DomainSafetyNoticeInput) {
  const t = useTranslations("domains.detail");
  const notice = domainSafetyNotice(input);
  return (
    <>
      <span
        data-domain-safety={notice.state}
        style={{ fontSize: 13.5, color: `var(--ms-${notice.variant})` }}
      >
        {t("bannerVerified")}
      </span>
      <span style={{ fontSize: 13.5, color: "var(--ms-bone)" }}>{t(notice.bodyKey)}</span>
    </>
  );
}
