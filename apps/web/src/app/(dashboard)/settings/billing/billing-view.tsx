"use client";

import type { RungChange } from "@millionsend/billing";
import {
  formatVolume,
  PLAN_CONTACT_LIMIT,
  PLAN_DOMAIN_LIMIT,
  PLAN_RUNGS,
  type Plan,
  type PlanRung,
  type PlanRungKey,
  planLabel,
} from "@millionsend/core/plans";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { Modal } from "@/components/modal";
import { Odometer } from "@/components/odometer";
import { Skeleton } from "@/components/skeleton";
import { BtnSpinner } from "@/components/spinner";
import { Switch } from "@/components/switch";
import { WarnCard } from "@/components/warn-card";
import { formatDay, formatDayTime, formatUsd } from "@/lib/format";
import {
  clearLaunchComboIntent,
  type LaunchComboIntent,
  launchComboQuote,
  readLaunchComboIntent,
  saveLaunchComboIntent,
} from "@/lib/launch-combo";
import {
  LAUNCH_OFFER,
  type LaunchBillingPeriod,
  type LaunchMailboxTierId,
  parseLaunchMailboxQuantity,
} from "@/lib/launch-offer";
import { statusGlow } from "@/lib/status-glow";
import { useTRPC } from "@/lib/trpc";
import { QuotaRow } from "../usage/usage-view";
import { LaunchComboMailStep } from "./launch-combo-step";

const PLANS = ["free", "starter", "pro", "scale"] as const satisfies readonly Plan[];
/* The slider's stops are the rungs themselves; a daily cap sits on the monthly axis as thirty days of it. */
const LAST_STEP = PLAN_RUNGS.length - 1;
const stepVolume = (r: PlanRung) => (r.period === "day" ? r.included * 30 : r.included);

/** Subscription status → badge tone: paying reads healthy, grace warns, lapsed is a danger. */
const STATUS_TONE = {
  none: "neutral",
  active: "success",
  trialing: "success",
  past_due: "warn",
  unpaid: "danger",
  canceled: "danger",
  incomplete: "danger",
} as const;

// The webhook flips the plan after Stripe confirms payment, a few seconds
// after the redirect lands; a short burst of refetches picks it up.
const POST_CHECKOUT_POLLS = 6;
const POST_CHECKOUT_POLL_MS = 2500;

function Card({
  title,
  action,
  children,
}: {
  title: string;
  /** Right-aligned control on the title row (the card's primary action). */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ms-card" style={{ padding: 24 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          margin: "0 0 18px",
        }}
      >
        <h2
          className="ms-display"
          style={{ fontSize: "var(--ms-fs-h2)", color: "var(--ms-bone)", margin: 0 }}
        >
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function BillingSkeleton({ title }: { title: string }) {
  return (
    <Card title={title}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <Skeleton width={120} height={28} />
        <Skeleton width={64} height={20} radius={999} />
      </div>
      <div style={{ display: "flex", gap: 48, marginTop: 22 }}>
        <Skeleton width={90} height={40} />
        <Skeleton width={140} height={40} />
      </div>
    </Card>
  );
}

/** The green check in front of every feature line (color comes from .ms-checklist-mark). */
function Check() {
  return (
    <svg
      className="ms-checklist-mark"
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m4 12.5 5 5L20 6.5" />
    </svg>
  );
}

export function BillingView({
  checkout,
  requestedRung = null,
  requestedMail = false,
}: {
  checkout: "success" | "cancel" | null;
  requestedRung?: PlanRungKey | null;
  /** From the Correio offer: preselect the Mail step of the launch combo. */
  requestedMail?: boolean;
}) {
  const t = useTranslations("settings.billing");
  const planName = useTranslations("settings.plans");
  const usageT = useTranslations("settings.usage");
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const status = useQuery({
    ...trpc.billing.status.queryOptions(),
    refetchInterval: (query) =>
      checkout === "success" && query.state.dataUpdateCount < POST_CHECKOUT_POLLS
        ? POST_CHECKOUT_POLL_MS
        : false,
  });
  const teams = useQuery(trpc.team.list.queryOptions());
  const role = teams.data?.teams.find((m) => m.teamId === teams.data.activeTeamId)?.role;
  const canManage = role === "owner" || role === "admin";
  const teamId = teams.data?.activeTeamId ?? null;

  const redirect = { onSuccess: ({ url }: { url: string }) => window.location.assign(url) };
  // The cap banner reads usage.recent; team.list carries the plan.
  const refresh = {
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries(trpc.billing.status.queryFilter()),
        queryClient.invalidateQueries(trpc.settings.usage.recent.queryFilter()),
        queryClient.invalidateQueries(trpc.team.list.queryFilter()),
      ]),
  };
  // A intenção só abre a comparação; todas as mutações exigem clique e role.
  const intent =
    PLAN_RUNGS.find((rung) => rung.key === requestedRung && rung.priceCents > 0)?.key ?? null;
  const [step, setStep] = useState<number | null>(null);
  const [launchInterval, setLaunchInterval] = useState<LaunchBillingPeriod>("month");
  // Send + Mail combo: Mail is a second, separate Checkout opened after Send.
  const [comboOn, setComboOn] = useState(requestedMail);
  const [comboTier, setComboTier] = useState<LaunchMailboxTierId>("gib1");
  const [comboSeats, setComboSeats] = useState("1");
  const [comboIntent, setComboIntent] = useState<LaunchComboIntent | null>(null);
  useEffect(() => {
    if (!teamId) return;
    const saved = readLaunchComboIntent(teamId);
    setComboIntent(saved);
    if (saved) {
      setComboOn(true);
      setComboTier(saved.tier);
      setComboSeats(String(saved.seats));
      setLaunchInterval(saved.interval);
    }
  }, [teamId]);
  const [plansOpen, setPlansOpen] = useState(intent !== null);
  const [changed, setChanged] = useState<{ rung: PlanRungKey; result: RungChange } | null>(null);
  const startCheckout = useMutation(trpc.billing.checkout.mutationOptions(redirect));
  const openPortal = useMutation(trpc.billing.portal.mutationOptions(redirect));
  const changePlan = useMutation(
    trpc.billing.changePlan.mutationOptions({
      onSuccess: async (result, variables) => {
        await refresh.onSuccess();
        // The outcome shows on the plan card at the top of the page, so the
        // dialog gives way to it and the page scrolls there with a notice.
        setChanged({ rung: variables.rung, result });
        setPlansOpen(false);
        window.scrollTo({ top: 0, behavior: "smooth" });
      },
    }),
  );
  const setOverage = useMutation(trpc.billing.setOverage.mutationOptions(refresh));
  const mutations = [startCheckout, openPortal, changePlan, setOverage];
  const busy = mutations.some((m) => m.isPending);
  const failed = mutations.some((m) => m.isError);
  const billingPaused = mutations.some(
    (m) => m.isError && m.error?.data?.code === "SERVICE_UNAVAILABLE",
  );

  const fmt = new Intl.NumberFormat(locale);
  const usd = (cents: number) => formatUsd(cents, locale);

  const rungLabel = (key: PlanRungKey) => {
    const r = PLAN_RUNGS.find((x) => x.key === key);
    return r ? planLabel(r.plan, r.period === "month" ? r.included : null) : key;
  };
  const changedText = changed
    ? changed.result.applied === "now"
      ? t("switchedNow", { plan: rungLabel(changed.rung) })
      : changed.result.applied === "period_end"
        ? t("pendingChange", {
            plan: rungLabel(changed.rung),
            date: formatDay(changed.result.at, locale),
          })
        : t("stayOn", { plan: rungLabel(changed.rung) })
    : null;
  const success = (text: string) => (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 16px",
        borderRadius: 12,
        border: "1px solid var(--ms-success-border)",
        backgroundColor: "var(--ms-ground)",
        backgroundImage: statusGlow("success", 15),
        fontSize: "var(--ms-fs-ui)",
      }}
    >
      <span
        className="ms-mono"
        aria-hidden="true"
        style={{ fontSize: 11, color: "var(--ms-success)" }}
      >
        ✓
      </span>
      {text}
    </div>
  );
  const notice =
    checkout === "success" ? (
      success(t("checkoutSuccess"))
    ) : checkout === "cancel" ? (
      <div role="status" className="ms-toast ms-toast-neutral">
        <span className="ms-toast-icon" aria-hidden="true">
          i
        </span>
        {t("checkoutCancel")}
      </div>
    ) : changedText ? (
      success(changedText)
    ) : null;

  if (!status.data) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 20 }}>
        {notice}
        <BillingSkeleton title={t("plan")} />
      </div>
    );
  }

  const {
    plan,
    planQuota,
    rung: currentKey,
    pendingRung,
    planStatus,
    currentPeriodEnd,
    quota,
    usage,
    hasCustomer,
    hasLiveSubscription,
    billingInterval,
    launchOffer,
    subscriptionState,
  } = status.data;
  if (plan === "system") {
    return (
      <Card title={t("plan")}>
        <span
          className="ms-display"
          style={{ fontSize: "var(--ms-fs-h1)", color: "var(--ms-bone)", lineHeight: 1 }}
        >
          {planLabel(plan, planQuota)}
        </span>
        <p style={{ margin: "14px 0 0", fontSize: 13, color: "var(--ms-muted)" }}>
          {t("systemNotice")}
        </p>
      </Card>
    );
  }
  const current = PLAN_RUNGS.find((r) => r.key === currentKey) ?? PLAN_RUNGS[0];
  const pending = PLAN_RUNGS.find((r) => r.key === pendingRung) ?? null;
  const at =
    step ??
    Math.max(
      0,
      PLAN_RUNGS.findIndex((r) => r.key === (intent ?? current.key)),
    );
  const selected = PLAN_RUNGS[at] ?? current;
  const over = quota.kind === "month" ? Math.max(0, usage.accepted - quota.included) : 0;
  // After a successful return the webhook may still be on its way; offering a
  // second purchase in that window would only invite a duplicate Checkout.
  const newOffer = !hasLiveSubscription && checkout !== "success" ? launchOffer : null;
  const comboSeatCount = parseLaunchMailboxQuantity(comboSeats);
  const comboQuote =
    comboOn && comboSeatCount !== null
      ? launchComboQuote({ interval: launchInterval, tier: comboTier, seats: comboSeatCount })
      : null;
  const comboPer = t(launchInterval === "year" ? "launch.perYear" : "perMonth");
  const showComboStep = !!comboIntent && (hasLiveSubscription || checkout === "success");
  const subscriptionChangesUnavailable =
    hasLiveSubscription && (billingInterval === "year" || subscriptionState !== "confirmed");
  const salePrice = (r: PlanRung) =>
    newOffer && r.key === newOffer.rung
      ? launchInterval === "year"
        ? newOffer.annualCents
        : newOffer.monthlyCents
      : r.priceCents;

  const portalButton = (label: string, className: string) => (
    <button
      type="button"
      className={`ms-btn ${className}`}
      disabled={busy}
      onClick={() => openPortal.mutate()}
    >
      <BtnSpinner on={openPortal.isPending} />
      {label}
    </button>
  );

  const features = (p: Plan): string[] => {
    const domains = PLAN_DOMAIN_LIMIT[p];
    const contacts = PLAN_CONTACT_LIMIT[p];
    return [
      domains === null ? t("features.domainsUnlimited") : t("features.domains", { n: domains }),
      contacts === null ? t("features.contacts") : t("features.contactsLimit", { n: contacts }),
      t("features.broadcasts"),
      t("features.integrations"),
      t("features.agents"),
    ];
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 20 }}>
      {notice}

      {showComboStep && comboIntent ? (
        <LaunchComboMailStep
          intent={comboIntent}
          canManage={canManage}
          onDone={() => setComboIntent(null)}
        />
      ) : null}

      <Card
        title={t("plan")}
        action={canManage && hasCustomer ? portalButton(t("manage"), "ms-btn-secondary") : null}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            className="ms-display"
            style={{ fontSize: "var(--ms-fs-h1)", color: "var(--ms-bone)", lineHeight: 1 }}
          >
            {planLabel(plan, planQuota)}
          </span>
          {/* Optical: the display face sits a hair low in its line box, so the
              pill follows its cap height rather than the box center. */}
          <span
            className={`ms-badge ms-badge-${STATUS_TONE[planStatus]}`}
            style={{ position: "relative", top: 1 }}
          >
            {t(`status.${planStatus}`)}
          </span>
        </div>

        {status.data.effectiveRung ? (
          <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--ms-muted)" }}>
            {t(billingInterval === "year" ? "effectiveAnnualBasePrice" : "effectiveBasePrice", {
              price: usd(status.data.effectiveRung.priceCents),
            })}
          </p>
        ) : null}
        {hasLiveSubscription && subscriptionState !== "confirmed" ? (
          <p role="status" style={{ margin: "12px 0 0", fontSize: 13, color: "var(--ms-muted)" }}>
            {t("subscriptionConfirmationPending")}
          </p>
        ) : billingInterval === "year" ? (
          <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--ms-muted)" }}>
            {t("annualChangesUnavailable")}
          </p>
        ) : null}

        <div className="ms-kpi-row" style={{ display: "flex", gap: 48, marginTop: 22 }}>
          <div>
            <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
              {t("cap")}
            </div>
            <div style={{ marginTop: 6, color: "var(--ms-bone)", fontSize: "var(--ms-fs-ui)" }}>
              {quota.kind === "day"
                ? t("capPerDay", { n: fmt.format(quota.limit) })
                : quota.kind === "month"
                  ? t("capPerMonth", { n: fmt.format(quota.included) })
                  : null}
            </div>
          </div>
          {currentPeriodEnd && plan !== "free" ? (
            <div>
              <div className="ms-microlabel" style={{ fontSize: 10.5 }}>
                {t("renewsOn")}
              </div>
              <div style={{ marginTop: 6, color: "var(--ms-bone)", fontSize: "var(--ms-fs-ui)" }}>
                {formatDayTime(currentPeriodEnd, locale)}
              </div>
            </div>
          ) : null}
        </div>

        {pending && currentPeriodEnd ? (
          <div
            className="ms-wrap-row"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginTop: 16,
              fontSize: 13,
              color: "var(--ms-muted)",
            }}
          >
            <span>
              {t("pendingChange", {
                plan: planLabel(pending.plan, pending.period === "month" ? pending.included : null),
                date: formatDay(currentPeriodEnd, locale),
              })}
            </span>
            {canManage ? (
              <button
                type="button"
                className="ms-btn ms-btn-secondary"
                disabled={busy || subscriptionChangesUnavailable}
                onClick={
                  subscriptionChangesUnavailable
                    ? undefined
                    : () => changePlan.mutate({ rung: current.key })
                }
              >
                <BtnSpinner
                  on={changePlan.isPending && changePlan.variables?.rung === current.key}
                />
                {t("keepPlan", { plan: planLabel(plan, planQuota) })}
              </button>
            ) : null}
          </div>
        ) : null}

        {planStatus === "past_due" ? (
          <WarnCard action={canManage ? portalButton(t("updateCard"), "ms-btn-secondary") : null}>
            {t("pastDue")}
          </WarnCard>
        ) : null}

        <p
          role={failed ? "alert" : undefined}
          style={{
            margin: "14px 0 0",
            fontSize: 13,
            color: failed ? "var(--ms-danger)" : "var(--ms-muted)",
          }}
        >
          {failed
            ? t(billingPaused ? "billingPaused" : "error")
            : canManage
              ? t("manageHint")
              : t("readOnly")}
        </p>
      </Card>

      <Card title={t("usageTitle")}>
        {quota.kind === "month" ? (
          <>
            <QuotaRow
              label={usageT("sentThisPeriod")}
              hint={usageT("renewsOn", { date: formatDay(quota.periodEnd, locale) })}
              used={usage.accepted}
              limit={quota.included}
            />
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 14,
                marginTop: 18,
                paddingTop: 18,
                borderTop: "1px solid var(--ms-line)",
              }}
            >
              <Switch
                checked={quota.overage}
                disabled={
                  !canManage || !hasLiveSubscription || busy || subscriptionChangesUnavailable
                }
                onChange={(enabled) => {
                  if (!subscriptionChangesUnavailable) setOverage.mutate({ enabled });
                }}
                ariaLabel={t("overage")}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, color: "var(--ms-bone)" }}>{t("overage")}</div>
                <div style={{ fontSize: 12.5, color: "var(--ms-muted)", marginTop: 2 }}>
                  {billingInterval === "year"
                    ? t("launch.annualHardCap")
                    : quota.overageCentsPer1k === null
                      ? t("effectiveRateUnavailable")
                      : t("overageCopy", { price: usd(quota.overageCentsPer1k) })}
                </div>
                {over > 0 && quota.overageCentsPer1k !== null ? (
                  <div style={{ fontSize: 12.5, color: "var(--ms-bone)", marginTop: 6 }}>
                    {t("overSoFar", {
                      n: over,
                      amount: usd(Math.ceil(over / 1000) * quota.overageCentsPer1k),
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        ) : (
          <QuotaRow
            label={usageT("sentToday")}
            hint={usageT("resetsMidnightUtc")}
            used={usage.accepted}
            limit={quota.kind === "day" ? quota.limit : null}
          />
        )}
      </Card>

      {newOffer ? (
        <Card title={t("launch.title")}>
          <p
            style={{ margin: "0 0 20px", color: "var(--ms-muted)", fontSize: 14, lineHeight: 1.6 }}
          >
            {t("launch.included", { n: fmt.format(newOffer.monthlyRecipientDeliveries) })}
          </p>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="ms-microlabel" style={{ marginBottom: 10 }}>
              {t("launch.interval")}
            </legend>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              {(["month", "year"] as const).map((interval) => (
                <label
                  key={interval}
                  className="ms-btn ms-btn-secondary"
                  style={{
                    minHeight: 44,
                    fontSize: 16,
                    display: "inline-flex",
                    gap: 10,
                    alignItems: "center",
                    cursor: busy ? "wait" : "pointer",
                  }}
                >
                  <input
                    type="radio"
                    name="send-launch-interval"
                    value={interval}
                    checked={launchInterval === interval}
                    disabled={busy}
                    onChange={() => setLaunchInterval(interval)}
                  />
                  {t(`launch.${interval}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <div role="status" aria-live="polite" aria-atomic="true" style={{ marginTop: 20 }}>
            <p
              className="ms-display"
              style={{
                margin: 0,
                fontSize: "var(--ms-fs-h1)",
                color: "var(--ms-bone)",
                overflowWrap: "anywhere",
              }}
            >
              {usd(launchInterval === "year" ? newOffer.annualCents : newOffer.monthlyCents)}
              <span style={{ fontSize: 16, color: "var(--ms-muted)", marginLeft: 8 }}>
                {t(launchInterval === "year" ? "launch.perYear" : "perMonth")}
              </span>
            </p>
            <p
              style={{ fontSize: 14, lineHeight: 1.6, margin: "10px 0", color: "var(--ms-muted)" }}
            >
              {launchInterval === "year"
                ? t("launch.annualTerms", {
                    total: usd(newOffer.annualCents),
                    equivalent: usd(Math.round(newOffer.annualCents / 12)),
                  })
                : t("launch.monthlyTerms", {
                    first: usd(newOffer.firstMonthlyCents),
                    renewal: usd(newOffer.monthlyCents),
                  })}
            </p>
            {launchInterval === "year" ? (
              <p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--ms-muted)" }}>
                {t("launch.annualHardCap")}
              </p>
            ) : null}
          </div>
          {canManage ? (
            <fieldset
              disabled={busy}
              style={{
                border: 0,
                padding: "18px 0 0",
                margin: "18px 0 0",
                borderTop: "1px solid var(--ms-line)",
              }}
            >
              <label
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "flex-start",
                  cursor: busy ? "wait" : "pointer",
                }}
              >
                <input
                  type="checkbox"
                  className="ms-checkbox"
                  style={{ marginTop: 3 }}
                  checked={comboOn}
                  onChange={(event) => setComboOn(event.target.checked)}
                />
                <span>
                  <span style={{ display: "block", color: "var(--ms-bone)", fontSize: 15 }}>
                    {t("launch.comboToggle")}
                  </span>
                  <span
                    style={{
                      display: "block",
                      color: "var(--ms-muted)",
                      fontSize: 13,
                      lineHeight: 1.6,
                      marginTop: 2,
                    }}
                  >
                    {t("launch.comboHint")}
                  </span>
                </span>
              </label>
              {comboOn ? (
                <div style={{ display: "grid", gap: 16, marginTop: 16 }}>
                  <div role="radiogroup" aria-labelledby="send-launch-mailbox-size">
                    <div
                      id="send-launch-mailbox-size"
                      className="ms-microlabel"
                      style={{ marginBottom: 10 }}
                    >
                      {t("launch.comboSize")}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                      {LAUNCH_OFFER.mailboxes.map((tier) => (
                        <label
                          key={tier.id}
                          className="ms-btn ms-btn-secondary"
                          style={{
                            minHeight: 44,
                            fontSize: 15,
                            display: "inline-flex",
                            gap: 10,
                            alignItems: "center",
                            cursor: busy ? "wait" : "pointer",
                          }}
                        >
                          <input
                            type="radio"
                            name="send-launch-mailbox-tier"
                            value={tier.id}
                            checked={comboTier === tier.id}
                            onChange={() => setComboTier(tier.id)}
                          />
                          {t("launch.comboTier", {
                            size: `${tier.storageGiB} GiB`,
                            price: usd(
                              tier.monthlyCents *
                                (launchInterval === "year" ? LAUNCH_OFFER.annualChargedMonths : 1),
                            ),
                            per: comboPer,
                          })}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="ms-field" style={{ maxWidth: 220 }}>
                    <label htmlFor="send-launch-mailbox-seats">{t("launch.comboQuantity")}</label>
                    <input
                      id="send-launch-mailbox-seats"
                      className="ms-input"
                      type="number"
                      inputMode="numeric"
                      min={LAUNCH_OFFER.previewMailboxQuantity.min}
                      max={LAUNCH_OFFER.previewMailboxQuantity.max}
                      step={1}
                      value={comboSeats}
                      aria-invalid={comboSeatCount === null || undefined}
                      aria-describedby="send-launch-mailbox-seats-hint"
                      onChange={(event) => setComboSeats(event.target.value)}
                    />
                    <span
                      id="send-launch-mailbox-seats-hint"
                      style={{
                        fontSize: 12.5,
                        color: comboSeatCount === null ? "var(--ms-danger)" : "var(--ms-muted)",
                      }}
                    >
                      {t("launch.comboQuantityHint")}
                    </span>
                  </div>
                  {comboQuote ? (
                    <div
                      role="status"
                      aria-live="polite"
                      style={{ display: "grid", gap: 6, fontSize: 14, lineHeight: 1.6 }}
                    >
                      <div style={{ color: "var(--ms-bone)" }}>
                        {t("launch.comboSendStep", {
                          amount: usd(
                            launchInterval === "year"
                              ? newOffer.annualCents
                              : newOffer.firstMonthlyCents,
                          ),
                        })}
                      </div>
                      <div style={{ color: "var(--ms-bone)" }}>
                        {t("launch.comboMailStep", {
                          amount: usd(comboQuote.mailPeriodCents),
                          per: comboPer,
                        })}
                      </div>
                      <div style={{ color: "var(--ms-muted)" }}>
                        {t("launch.comboRenewal", {
                          amount: usd(comboQuote.recurringPeriodCents),
                          per: comboPer,
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </fieldset>
          ) : null}
          <p
            style={{
              fontSize: 13,
              lineHeight: 1.6,
              color: "var(--ms-muted)",
              margin: "14px 0 20px",
            }}
          >
            {t("launch.existingPreserved")}
          </p>
          {canManage ? (
            <button
              type="button"
              className="ms-btn ms-btn-primary"
              disabled={busy || (comboOn && comboSeatCount === null)}
              onClick={() => {
                if (comboOn && comboSeatCount !== null && teamId) {
                  saveLaunchComboIntent({
                    teamId,
                    tier: comboTier,
                    seats: comboSeatCount,
                    interval: launchInterval,
                  });
                } else {
                  clearLaunchComboIntent();
                }
                startCheckout.mutate({ rung: newOffer.rung, interval: launchInterval });
              }}
            >
              <BtnSpinner on={startCheckout.isPending} />
              {t(comboOn ? "launch.comboContinue" : "launch.continue")}
            </button>
          ) : (
            <p style={{ color: "var(--ms-muted)", fontSize: 14 }}>{t("readOnly")}</p>
          )}
        </Card>
      ) : null}

      <Card
        title={t("plansTitle")}
        action={
          <button
            type="button"
            className="ms-btn ms-btn-secondary"
            onClick={() => setPlansOpen(true)}
          >
            {t("comparePlans")}
          </button>
        }
      >
        <div className="ms-plan-strip">
          {PLANS.map((p) => {
            const rungs = PLAN_RUNGS.filter((x) => x.plan === p);
            const firstRung = rungs[0];
            const price = usd(
              firstRung && newOffer && firstRung.key === newOffer.rung
                ? newOffer.monthlyCents
                : (firstRung?.priceCents ?? 0),
            );
            return (
              <div
                key={p}
                className="ms-plan-strip-item"
                data-current={p === current.plan || undefined}
              >
                <span className="ms-plan-strip-name">{planName(p)}</span>
                <span className="ms-plan-strip-price">
                  {rungs.length > 1 ? t("fromPrice", { price }) : price} {t("perMonth")}
                </span>
              </div>
            );
          })}
        </div>
      </Card>
      {/* The ladder needs more width than the content column beside the
          sidebar gives it, so it opens in a dialog that fills the viewport. */}
      <Modal
        open={plansOpen}
        onClose={() => setPlansOpen(false)}
        title={t("plansTitle")}
        size="full"
      >
        <div className="ms-plan-dialog">
          <div className="ms-volume">
            <label htmlFor="ms-volume" className="ms-microlabel">
              {t("volume")}
            </label>
            <input
              id="ms-volume"
              className="ms-slider"
              type="range"
              min={0}
              max={LAST_STEP}
              step={1}
              value={at}
              onChange={(e) => setStep(Number(e.target.value))}
              aria-valuetext={`${fmt.format(stepVolume(selected))} ${t("emailsAMonth")}`}
              style={{ "--ms-slider-p": `${(at / LAST_STEP) * 100}%` } as CSSProperties}
            />
            <div className="ms-slider-marks">
              {PLAN_RUNGS.map((r, i) => (
                <button
                  key={r.key}
                  type="button"
                  tabIndex={-1}
                  className="ms-digits"
                  data-on={i === at || undefined}
                  onClick={() => setStep(i)}
                >
                  {formatVolume(stepVolume(r))}
                </button>
              ))}
            </div>
            <p className="ms-slider-hint">{t("sliderHint")}</p>
          </div>
          <div className="ms-plans">
            {PLANS.map((p) => {
              const active = selected.plan === p;
              // A plan shows the rung the slider landed on when it is one of
              // its own, else its entry rung.
              const r = active ? selected : (PLAN_RUNGS.find((x) => x.plan === p) ?? selected);
              const isCurrent = r.key === current.key;
              const forSale = canManage && r.priceCents > 0 && !isCurrent;
              return (
                <div key={p} className="ms-plan" data-open={active || undefined}>
                  <div className="ms-plan-name">{planName(p)}</div>
                  <div className="ms-plan-price">
                    <span className="ms-digits">
                      <Odometer formatted={usd(salePrice(r))} lit={false} />
                    </span>
                    <span className="ms-plan-per">
                      {t(
                        newOffer && r.key === newOffer.rung && launchInterval === "year"
                          ? "launch.perYear"
                          : "perMonth",
                      )}
                    </span>
                  </div>
                  <div className="ms-plan-cap">
                    <span className="ms-digits">{fmt.format(r.included)}</span>
                    <span className="ms-plan-per">
                      {t(r.period === "day" ? "emailsADay" : "emailsAMonth")}
                    </span>
                  </div>
                  {/* Daily plans have no overage line; a blank one keeps the four cards' rows aligned. */}
                  <span
                    className="ms-plan-over"
                    data-empty={r.overageCentsPer1k === null || undefined}
                  >
                    {newOffer && r.key === newOffer.rung && launchInterval === "year"
                      ? t("launch.annualHardCap")
                      : r.overageCentsPer1k === null
                        ? "\u00a0"
                        : t("overagePer1k", { price: usd(r.overageCentsPer1k) })}
                  </span>
                  <div className="ms-plan-more">
                    <div>
                      <ul className="ms-checklist">
                        {features(p).map((f) => (
                          <li key={f}>
                            <Check />
                            {f}
                          </li>
                        ))}
                      </ul>
                      {isCurrent ? (
                        <button type="button" className="ms-btn ms-btn-secondary" disabled>
                          {t("current")}
                        </button>
                      ) : forSale ? (
                        <button
                          type="button"
                          className={`ms-btn ${active ? "ms-btn-primary" : "ms-btn-secondary"}`}
                          disabled={busy || subscriptionChangesUnavailable}
                          onClick={() =>
                            subscriptionChangesUnavailable
                              ? undefined
                              : hasLiveSubscription
                                ? changePlan.mutate({ rung: r.key })
                                : startCheckout.mutate({
                                    rung: r.key,
                                    interval:
                                      newOffer && r.key === newOffer.rung
                                        ? launchInterval
                                        : "month",
                                  })
                          }
                        >
                          <BtnSpinner
                            on={
                              (startCheckout.isPending &&
                                startCheckout.variables?.rung === r.key) ||
                              (changePlan.isPending && changePlan.variables?.rung === r.key)
                            }
                          />
                          {hasLiveSubscription
                            ? status.data.effectiveRung &&
                              r.priceCents < status.data.effectiveRung.priceCents
                              ? t("switchAtPeriodEnd")
                              : t("switch")
                            : t("choose")}
                        </button>
                      ) : p === "free" && canManage && hasLiveSubscription ? (
                        <p style={{ margin: 0, fontSize: 12, color: "var(--ms-muted)" }}>
                          {t("freeHint")}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {canManage && hasLiveSubscription ? (
            <p
              style={{
                margin: "14px 0 0",
                fontSize: 12.5,
                color: "var(--ms-muted)",
                textAlign: "center",
              }}
            >
              {t("changeHint")}
            </p>
          ) : null}
        </div>
      </Modal>
    </div>
  );
}
