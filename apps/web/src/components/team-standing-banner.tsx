"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { NoticeStrip } from "@/components/notice-strip";
import { SignupReviewRequest } from "@/components/signup-review-request";
import { formatDayTime } from "@/lib/format";
import { useTRPC } from "@/lib/trpc";

/**
 * What the instance operator did to this team: a suspension shows on every
 * page (sends are refused), as does a send-review hold (mail is kept until
 * the review ends), an operator pause of broadcasts only on the Broadcasts
 * pages, where it explains why nothing goes out.
 */
export function TeamStandingBanner() {
  const t = useTranslations("console.banner");
  const locale = useLocale();
  const pathname = usePathname();
  const trpc = useTRPC();
  const { data } = useQuery(trpc.team.standing.queryOptions());
  if (!data) return null;
  const request = data.canRequestSignupReview ? <SignupReviewRequest /> : null;
  if (data.suspended) {
    const { reason, note } = data.suspended;
    return (
      <>
        <NoticeStrip
          tone="danger"
          href={data.canRequestSignupReview ? undefined : "/support"}
          action={data.canRequestSignupReview ? undefined : t("requestReview")}
          text={
            note && reason === "manual"
              ? t("suspendedNote", { note })
              : t("suspended", { reason: t(`reasons.${reason}`) })
          }
        />
        {request}
      </>
    );
  }
  if (data.sendReview) {
    return (
      <>
        <NoticeStrip
          tone="warn"
          href={data.canRequestSignupReview ? undefined : "/support"}
          action={data.canRequestSignupReview ? undefined : t("requestReview")}
          text={t("sendReview", { since: formatDayTime(data.sendReview.at, locale) })}
        />
        {request}
      </>
    );
  }
  if (data.signupRisk === "sandbox" || data.signupRisk === "review") {
    return (
      <>
        <NoticeStrip
          tone="warn"
          href={data.canRequestSignupReview ? undefined : "/support"}
          action={data.canRequestSignupReview ? undefined : t("requestReview")}
          text={t(data.signupRisk === "sandbox" ? "signupSandbox" : "signupReview")}
        />
        {request}
      </>
    );
  }
  if (data.broadcastsPausedByOperatorAt && pathname.startsWith("/broadcasts")) {
    return (
      <NoticeStrip
        tone="warn"
        text={t(data.pendingReview ? "broadcastsPendingReview" : "broadcastsPaused", {
          since: formatDayTime(data.broadcastsPausedByOperatorAt, locale),
        })}
      />
    );
  }
  return null;
}
