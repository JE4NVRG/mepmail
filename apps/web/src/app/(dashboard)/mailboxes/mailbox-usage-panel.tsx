"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  formatMailboxBytes,
  isMailboxPlanCode,
  MAILBOX_PLAN_NAMES,
  type MailboxMeterLevel,
  mailboxMeterLevel,
  openMailboxLicense,
} from "@/lib/mailbox-plans";
import { useTRPC } from "@/lib/trpc";
import styles from "./mailboxes.module.css";

type Metric = {
  used: number;
  limit: number | null;
  periodEndsAt: string | null;
  upgrade: { planId: string; name: string } | null;
  pauseAt?: number | null;
};
type MetricName =
  | "mailboxes"
  | "storageBytes"
  | "outboundRecipients"
  | "outboundBytes"
  | "inboundDeliveries"
  | "inboundBytes";
export type MailboxPlanUsage = {
  code: string;
  name: string;
  status: string;
  periodEndsAt: string;
  trial: {
    active: boolean;
    endsAt: string;
    dailyLimit: number;
    totalLimit: number;
    sentToday: number;
    sentTotal: number;
  } | null;
  upgrade: { planId: string; name: string } | null;
  metrics: Record<MetricName, Metric>;
  receiving: {
    state: "active" | "pausing" | "paused_quota" | "resuming";
    reason: "inbound_deliveries" | "inbound_bytes" | "storage" | null;
    since: string | null;
    resumesAt: string | null;
  };
};

const BYTE_METRICS = new Set<MetricName>(["storageBytes", "outboundBytes", "inboundBytes"]);
/** The rail shows what fills up first; Configurações → Licença e uso shows all six. */
const SHORT: MetricName[] = ["storageBytes", "outboundRecipients", "inboundDeliveries"];
const ALL: MetricName[] = [
  "mailboxes",
  "storageBytes",
  "outboundRecipients",
  "outboundBytes",
  "inboundDeliveries",
  "inboundBytes",
];

/** The offer id of the plan to upgrade to, from the license's plan offers. */
export function useMailboxUpgradeOffer(planId: string | null | undefined): string | null {
  const trpc = useTRPC();
  const billing = useQuery(
    trpc.mailboxes.billing.queryOptions(undefined, { retry: false, enabled: !!planId }),
  );
  return (
    billing.data?.management.planOffers?.find((offer) => offer.plan?.code === planId)?.offerId ??
    null
  );
}

/**
 * Receiving paused by the plan (the team passed its inbound quota + 10 %, or
 * its storage is full): new mail bounces to the sender until the next
 * period, or an upgrade (the only way out for storage).
 */
export function MailboxReceivingNotice({
  plan,
  compact = false,
}: {
  plan: MailboxPlanUsage;
  compact?: boolean;
}) {
  const t = useTranslations("mailboxes.usage");
  const locale = useLocale();
  const upgradeOffer = useMailboxUpgradeOffer(plan.upgrade?.planId);
  const { state, reason, resumesAt } = plan.receiving;
  if (state === "active") return null;
  const date = resumesAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(resumesAt))
    : null;
  const why = t(`receiving.reason.${reason ?? "inbound_deliveries"}`);
  const text =
    state === "resuming"
      ? t("receiving.resuming")
      : state === "pausing"
        ? t("receiving.pausing", { reason: why })
        : reason === "storage" || !date
          ? t("receiving.pausedStorage")
          : t("receiving.paused", { reason: why, date });
  return (
    <div
      className={compact ? styles.receivingCompact : styles.receivingBanner}
      role={state === "resuming" ? "status" : "alert"}
      data-state={state}
    >
      <p>{text}</p>
      {plan.upgrade && state !== "resuming" ? (
        <button
          type="button"
          className="ms-btn ms-btn-primary"
          onClick={() => openMailboxLicense(upgradeOffer)}
        >
          {t("upgradeTo", { name: plan.upgrade.name })}
        </button>
      ) : null}
    </div>
  );
}

/** Above the inbox: the receiving pause, for everyone on the team. */
export function MailboxReceivingBanner({ enabled }: { enabled: boolean }) {
  const trpc = useTRPC();
  const query = useQuery(
    trpc.mailboxes.usage.queryOptions(
      { mailboxId: null },
      { retry: false, enabled, refetchInterval: 60_000 },
    ),
  );
  const plan = (query.data?.plan ?? null) as MailboxPlanUsage | null;
  return plan ? <MailboxReceivingNotice plan={plan} /> : null;
}

function PlanUsage({ plan, detailed }: { plan: MailboxPlanUsage; detailed: boolean }) {
  const t = useTranslations("mailboxes.usage");
  const locale = useLocale();
  const upgradeOffer = useMailboxUpgradeOffer(plan.upgrade?.planId);
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const show = (name: MetricName, value: number) =>
    BYTE_METRICS.has(name) ? formatMailboxBytes(value, locale) : number(value);
  const shortDate = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(new Date(value));
  const names = detailed ? ALL : SHORT;
  const levels = names.map((name) => {
    const metric = plan.metrics[name];
    return mailboxMeterLevel(metric.used, metric.limit, metric.pauseAt ?? null);
  });
  const worst: MailboxMeterLevel = levels.includes("paused")
    ? "paused"
    : levels.includes("full")
      ? "full"
      : levels.includes("near")
        ? "near"
        : "ok";
  const planName = isMailboxPlanCode(plan.code) ? MAILBOX_PLAN_NAMES[plan.code] : plan.name;
  return (
    <>
      <small>
        {t(plan.trial?.active ? "planTrialLine" : "planLine", {
          name: planName,
          date: shortDate(plan.trial?.active ? plan.trial.endsAt : plan.periodEndsAt),
        })}
      </small>
      <MailboxReceivingNotice plan={plan} compact />
      {names.map((name, index) => {
        const metric = plan.metrics[name];
        const level = levels[index]!;
        return (
          <div key={name} className={styles.planMetric} data-level={level}>
            <div className={styles.usageMetric}>
              <span>{t(`metric.${name}`)}</span>
              <strong>
                {metric.limit === null
                  ? show(name, metric.used)
                  : t("ratio", { used: show(name, metric.used), total: show(name, metric.limit) })}
              </strong>
            </div>
            {metric.limit ? (
              <progress
                aria-label={t(`metric.${name}`)}
                max={metric.limit}
                value={Math.min(metric.used, metric.limit)}
              />
            ) : null}
            {level !== "ok" ? (
              <small className={styles.metricNote}>
                {t(`level.${level}`, {
                  date: metric.periodEndsAt ? shortDate(metric.periodEndsAt) : "",
                })}
              </small>
            ) : null}
          </div>
        );
      })}
      {plan.trial?.active ? (
        <small>
          {t("trialSends", {
            today: number(plan.trial.sentToday),
            daily: number(plan.trial.dailyLimit),
            total: number(plan.trial.sentTotal),
            totalLimit: number(plan.trial.totalLimit),
          })}
        </small>
      ) : null}
      {plan.upgrade && worst !== "ok" && plan.receiving.state === "active" ? (
        <button
          type="button"
          className="ms-btn ms-btn-ghost"
          onClick={() => openMailboxLicense(upgradeOffer)}
        >
          {t("upgradeTo", { name: plan.upgrade.name })}
        </button>
      ) : null}
    </>
  );
}

const bytes = (value: number, locale: string) => {
  const unit =
    value >= 1024 ** 3 ? "GiB" : value >= 1024 ** 2 ? "MiB" : value >= 1024 ? "KiB" : "B";
  const divisor =
    unit === "GiB" ? 1024 ** 3 : unit === "MiB" ? 1024 ** 2 : unit === "KiB" ? 1024 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / divisor)} ${unit}`;
};
export function MailboxUsagePanel({
  mailboxId,
  detailed = false,
}: {
  mailboxId: string | null;
  /** All six plan meters (Configurações) instead of the three that fill up first. */
  detailed?: boolean;
}) {
  const t = useTranslations("mailboxes.usage");
  const locale = useLocale();
  const trpc = useTRPC();
  const query = useQuery(
    trpc.mailboxes.usage.queryOptions({ mailboxId }, { retry: false, refetchInterval: 30000 }),
  );
  const rows = query.data?.mailboxes ?? [];
  // A Correio plan (Solo, Duo, Equipe): team-wide meters from the server.
  const planUsage = (query.data?.plan ?? null) as MailboxPlanUsage | null;
  // A team plan shares one allowance by all its mailboxes: show the pool, not a sum.
  const team = query.data?.quotaScope === "team" ? (query.data.team ?? null) : null;
  const used = team
    ? team.storageUsedBytes
    : rows.reduce((sum, row) => sum + row.storageUsedBytes, 0);
  const limit = team
    ? team.storageLimitBytes
    : rows.reduce((sum, row) => sum + row.storageLimitBytes, 0);
  const sent = team
    ? team.outboundUsedRecipients
    : rows.reduce((sum, row) => sum + row.outboundUsedRecipients, 0);
  const unlimited = team
    ? team.outboundLimitRecipients === null
    : rows.some((row) => row.outboundLimitRecipients === null);
  const sendLimit = team
    ? (team.outboundLimitRecipients ?? 0)
    : rows.reduce((sum, row) => sum + (row.outboundLimitRecipients ?? 0), 0);
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  return (
    <section className={styles.usagePanel} aria-label={t("title")}>
      <h3>{t("title")}</h3>
      {planUsage ? null : team ? (
        <small>{t("teamShared")}</small>
      ) : !mailboxId ? (
        <small>{t("allBoxes")}</small>
      ) : null}
      {planUsage && !query.isError ? (
        <PlanUsage plan={planUsage} detailed={detailed} />
      ) : query.isError ? (
        <button className="ms-btn ms-btn-ghost" type="button" onClick={() => void query.refetch()}>
          {t("retry")}
        </button>
      ) : query.isPending ? (
        <p aria-live="polite">{t("loading")}</p>
      ) : rows.length ? (
        <>
          <div className={styles.usageMetric}>
            <span>{t("storage")}</span>
            <strong>
              {t("ratio", { used: bytes(used, locale), total: bytes(limit, locale) })}
            </strong>
          </div>
          {limit > 0 ? (
            <progress aria-label={t("storage")} max={limit} value={Math.min(used, limit)} />
          ) : (
            <p>{t("noPolicy")}</p>
          )}
          <div className={styles.usageMetric}>
            <span>{t("outbound")}</span>
            <strong>
              {unlimited
                ? number(sent)
                : t("ratio", { used: number(sent), total: number(sendLimit) })}
            </strong>
          </div>
          {unlimited ? (
            <span className={styles.unlimitedUsage}>∞ {t("unlimited")}</span>
          ) : sendLimit > 0 ? (
            <progress
              aria-label={t("outbound")}
              max={sendLimit}
              value={Math.min(sent, sendLimit)}
            />
          ) : (
            <p>{t("noPolicy")}</p>
          )}
          <p>{t(unlimited ? "internalHelp" : "outboundHelp")}</p>
          {rows[0]?.periodEnd ? (
            <small>
              {t("renews", {
                date: new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(
                  rows[0].periodEnd,
                ),
              })}
            </small>
          ) : null}
        </>
      ) : (
        <p>{t("empty")}</p>
      )}
    </section>
  );
}
