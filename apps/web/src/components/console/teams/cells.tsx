"use client";

import { useLocale, useTranslations } from "next-intl";
import { regionFlag } from "@/app/(dashboard)/domains/regions";
import { Tooltip } from "@/components/tooltip";
import { planLabel, planTone } from "@/lib/console-format";
import { formatDayTime } from "@/lib/format";
import type { TeamRow } from "./types";

/** Only the displayed owner's signup; missing measurements stay missing. */
export function OwnerSignupCell({
  attribution,
  detailed = false,
}: {
  attribution: TeamRow["ownerSignupAttribution"];
  detailed?: boolean;
}) {
  const t = useTranslations("console.teams.acquisition");
  if (!attribution) return <span style={{ color: "var(--ms-muted)" }}>{t("notMeasured")}</span>;
  const fields = detailed
    ? [
        ["utm_medium", attribution.medium],
        ["utm_campaign", attribution.campaign],
        ["utm_content", attribution.content],
        ["utm_term", attribution.term],
        ["referrer", attribution.referrer],
        ["landing", attribution.landingPath],
      ]
    : [["utm_campaign", attribution.campaign]];
  return (
    <div
      style={{
        whiteSpace: "normal",
        overflowWrap: "anywhere",
        maxWidth: detailed ? undefined : 220,
      }}
    >
      <span>{attribution.source}</span>
      {fields
        .filter(([, value]) => value)
        .map(([key, value]) => (
          <div key={key} style={{ color: "var(--ms-muted)", fontSize: 12 }}>
            {key}: {value}
          </div>
        ))}
    </div>
  );
}

export function SubscriptionStatus({ status }: { status: string | null }) {
  const billing = useTranslations("settings.billing.status");
  const t = useTranslations("console.teams.acquisition");
  const value = status ?? "none";
  const label = value === "inactive" ? t("inactive") : billing.has(value) ? billing(value) : value;
  return <span title={value}>{label}</span>;
}

/** These are webhook/local contract facts, not a live Stripe lookup or an invoice. */
export function MailSubscriptionCell({
  subscription,
  detailed = false,
  enabled = true,
}: {
  subscription: TeamRow["mailboxSubscription"];
  detailed?: boolean;
  enabled?: boolean;
}) {
  const t = useTranslations("console.teams.acquisition");
  const locale = useLocale();
  if (!enabled || !subscription)
    return (
      <span style={{ color: "var(--ms-muted)" }}>{t(enabled ? "noMail" : "notMeasured")}</span>
    );
  return (
    <div
      style={{
        whiteSpace: "normal",
        overflowWrap: "anywhere",
        maxWidth: detailed ? undefined : 220,
      }}
    >
      <span>{subscription.planCode ?? t("legacyMail")}</span>
      {" · "}
      <SubscriptionStatus status={subscription.status} />
      {subscription.cancelAtPeriodEnd ? (
        <div style={{ color: "var(--ms-warn)", fontSize: 12 }}>{t("cancelAtEnd")}</div>
      ) : null}
      {detailed ? (
        <div style={{ color: "var(--ms-muted)", fontSize: 12 }}>
          {t("periodEnd", { date: formatDayTime(new Date(subscription.periodEnd), locale) })}
        </div>
      ) : null}
    </div>
  );
}

/** The translated plan name; a value the catalog does not know prints raw. */
export function usePlanName(): (plan: string) => string {
  const t = useTranslations("console.plan");
  return (plan) => (t.has(plan) ? t(plan) : plan);
}

export function PlanBadge({ plan, planQuota }: { plan: string; planQuota: number | null }) {
  const name = usePlanName();
  return (
    <span className={`ms-badge ms-badge-${planTone(plan)}`}>
      {planLabel(name(plan), planQuota)}
    </span>
  );
}

/** Flag + city with the region code on hover; a team without a verified domain has no region. */
export function RegionLabel({ region }: { region: string | null }) {
  const domains = useTranslations("domains");
  const common = useTranslations("console.common");
  if (!region) return <span style={{ color: "var(--ms-muted)" }}>{common("unknownRegion")}</span>;
  const city = domains.has(`regions.${region}`) ? domains(`regions.${region}`) : region;
  return (
    <Tooltip inline text={region}>
      {regionFlag(region)} {city}
    </Tooltip>
  );
}

const GUARDRAIL_COLOR: Record<string, string> = {
  ok: "var(--ms-success)",
  warning: "var(--ms-warn)",
  paused: "var(--ms-danger)",
};

/**
 * Suspended beats an operator pause beats the guardrail; a team without a
 * standing row reads as ok.
 */
export function GuardrailLabel({
  guardrail,
  suspendedAt,
  broadcastsPausedByOperatorAt,
}: {
  guardrail: string | null;
  suspendedAt: Date | null;
  broadcastsPausedByOperatorAt: Date | null;
}) {
  const t = useTranslations("console.teams.guardrail");
  if (suspendedAt) return <span className="ms-badge ms-badge-danger">{t("suspended")}</span>;
  const status = broadcastsPausedByOperatorAt ? "paused" : (guardrail ?? "ok");
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span className="ms-dot" style={{ background: GUARDRAIL_COLOR[status] }} aria-hidden="true" />
      {broadcastsPausedByOperatorAt ? t("operatorPaused") : t(status)}
    </span>
  );
}
