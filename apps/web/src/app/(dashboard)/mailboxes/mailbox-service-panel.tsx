"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { DOCS_URL } from "@/lib/docs-links";
import { mailboxCheckoutFailure, safeMailboxCheckoutUrl } from "@/lib/mailbox-checkout";
import {
  isMailboxBundle,
  mailboxPlanMaximumSeats,
  mailboxPlanMinimumSeats,
  mailboxPlanTotal,
  validMailboxPlanSeats,
} from "@/lib/mailbox-plan-terms";
import {
  defaultMailboxPlanOffer,
  MAILBOX_PLAN_NAMES,
  mailboxPlanDirection,
  mailboxPlanOffers,
} from "@/lib/mailbox-plans";
import {
  formatMailboxPrice,
  formatMailboxStorage,
  mailboxHasUnlimitedSeats,
  mailboxOfferSelection,
} from "@/lib/mailbox-setup";
import { useTRPC } from "@/lib/trpc";
import { MailboxPlanCards } from "./mailbox-plan-cards";
import styles from "./mailbox-service-panel.module.css";

export function safeMailboxPaymentUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "invoice.stripe.com" &&
      !url.username &&
      !url.password &&
      !url.port
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export { formatMailboxPrice } from "@/lib/mailbox-setup";
export { mailboxCheckoutFailure, safeMailboxCheckoutUrl };

/** Notice for subscription availability; internal System licenses have their own presentation. */
export function mailboxServiceNotice(
  availability: string | undefined,
  periodEnd: Date | null | undefined,
  existingFailure = false,
) {
  if (availability === "existing_subscription" || existingFailure)
    return periodEnd ? "existingLicenseBody" : "existingBody";
  if (availability === "sending_plan_required") return "sendingPlanRequiredBody";
  if (availability === "subscriptions_paused") return "subscriptionsPausedBody";
  if (availability === "recovery_required") return "recoveryBody";
  if (availability === "forbidden") return "adminBody";
  return "unavailableBody";
}

export function MailboxServicePanel({
  openRequest = 0,
  initialOfferId = null,
}: {
  openRequest?: number;
  initialOfferId?: string | null;
} = {}) {
  const t = useTranslations("mailboxes-service");
  const systemT = useTranslations("mailboxes-service.system");
  const locale = useLocale();
  const trpc = useTRPC();
  const service = useQuery(trpc.mailboxes.service.queryOptions(undefined, { retry: false }));
  const systemIdentified = service.data?.licenseKind === "system";
  const systemLicense = systemIdentified && !service.isPending && !service.isError;
  const billing = useQuery(
    trpc.mailboxes.billing.queryOptions(undefined, { retry: false, enabled: !systemIdentified }),
  );
  const checkout = useMutation(trpc.mailboxes.checkout.mutationOptions());
  const management = useMutation(trpc.mailboxes.manage.mutationOptions());
  const changePlan = useMutation(trpc.mailboxes.changePlan.mutationOptions());
  const abandon = useMutation(trpc.mailboxes.abandonCheckout.mutationOptions());
  const queries = useQueryClient();
  const planChangeTitleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(false);
  const returnChecked = useRef(false);
  const managementSequence = useRef(0);
  const titleId = useId();
  const seatsId = useId();
  const seatsHintId = useId();
  const offerId = useId();
  const offerHintId = useId();
  const [open, setOpen] = useState(false);
  const [seats, setSeats] = useState("1");
  const [attemptedSeats, setAttemptedSeats] = useState<number | null>(null);
  const [failure, setFailure] = useState<ReturnType<typeof mailboxCheckoutFailure> | null>(null);
  const [returned, setReturned] = useState(false);
  const [managedSeats, setManagedSeats] = useState("");
  const [managementNotice, setManagementNotice] = useState<
    "confirmed" | "scheduled" | "pending" | "expired" | "error" | null
  >(null);
  const [paymentUrl, setPaymentUrl] = useState<string | null>(null);
  const [managementReadback, setManagementReadback] = useState<{
    serviceUpdatedAt: number;
    billingUpdatedAt: number;
    requestedSeats: number | null;
  } | null>(null);
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(initialOfferId);
  const [attemptedOfferId, setAttemptedOfferId] = useState<string | null>(null);
  // Trocar de plano: the card chosen (not the current one) and the outcome.
  const [changeTarget, setChangeTarget] = useState<string | null>(null);
  const [planNotice, setPlanNotice] = useState<{
    tone: "status" | "alert";
    text: string;
  } | null>(null);
  // "Escolher outro plano": the outcome of leaving an unpaid purchase.
  const [abandonNotice, setAbandonNotice] = useState<{
    tone: "status" | "alert";
    text: string;
  } | null>(null);
  useEffect(() => {
    if (openRequest > 0) {
      setSelectedOfferId(initialOfferId);
      // "Fazer upgrade" from the usage screens opens on that plan's change.
      setChangeTarget(initialOfferId);
      setPlanNotice(null);
      setOpen(true);
    }
  }, [openRequest, initialOfferId]);
  const publishManagementResult = useCallback(
    async (
      outcome: {
        status: "confirmed" | "scheduled" | "pending" | "expired";
        paymentUrl: string | null;
      },
      requestedSeats: number | null,
      sequence: number,
    ) => {
      if (!alive.current || managementSequence.current !== sequence) return;
      const [serviceRead, billingRead] = await Promise.allSettled([
        service.refetch(),
        billing.refetch(),
      ]);
      if (!alive.current || managementSequence.current !== sequence) return;
      setManagementNotice(outcome.status);
      setPaymentUrl(outcome.paymentUrl ? safeMailboxPaymentUrl(outcome.paymentUrl) : null);
      setManagementReadback(
        serviceRead.status === "fulfilled" &&
          serviceRead.value.isSuccess &&
          billingRead.status === "fulfilled" &&
          billingRead.value.isSuccess
          ? {
              serviceUpdatedAt: serviceRead.value.dataUpdatedAt,
              billingUpdatedAt: billingRead.value.dataUpdatedAt,
              requestedSeats,
            }
          : null,
      );
    },
    [service.refetch, billing.refetch],
  );
  const refresh = useCallback(async () => {
    const sequence = ++managementSequence.current;
    setManagementNotice(null);
    setPaymentUrl(null);
    setManagementReadback(null);
    if (systemIdentified) {
      await service.refetch();
      return;
    }
    if (billing.data?.management.canReconcile) {
      try {
        const outcome = await management.mutateAsync({ action: "reconcile" });
        await publishManagementResult(outcome, billing.data.management.requestedSeats, sequence);
        return;
      } catch {
        if (!alive.current || managementSequence.current !== sequence) return;
        setManagementNotice("error");
      }
    }
    const [, billingRead] = await Promise.allSettled([service.refetch(), billing.refetch()]);
    if (
      alive.current &&
      billingRead.status === "fulfilled" &&
      billingRead.value?.isSuccess &&
      !billingRead.value.data?.sendingPlanRequired &&
      billingRead.value.data?.availability !== "sending_plan_required"
    ) {
      setFailure((current) => (current === "sending_plan_required" ? null : current));
    }
  }, [
    systemIdentified,
    service.refetch,
    billing.refetch,
    billing.data?.management.canReconcile,
    billing.data?.management.requestedSeats,
    management.mutateAsync,
    publishManagementResult,
  ]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (returnChecked.current) return;
    returnChecked.current = true;
    const url = new URL(window.location.href);
    if (url.searchParams.get("checkout") !== "success") return;
    setReturned(true);
    void refresh();
    url.searchParams.delete("checkout");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [refresh]);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  const loaded =
    !!service.data &&
    !service.isPending &&
    !service.isError &&
    (systemLicense || (!!billing.data && !billing.isPending && !billing.isError));
  const plan = loaded ? service.data : undefined;
  const systemUnlimited = systemLicense && mailboxHasUnlimitedSeats(plan);
  // The Correio plans (Solo, Duo, Equipe): when the catalog sells them, a new
  // purchase picks one of them (cards) instead of a price and a quantity.
  const planChoices =
    loaded && !systemIdentified ? mailboxPlanOffers(billing.data?.offers ?? []) : [];
  const planSelectedId =
    planChoices.length && !planChoices.some((entry) => entry.offerId === selectedOfferId)
      ? (defaultMailboxPlanOffer(planChoices, billing.data?.defaultOfferId)?.offerId ?? null)
      : selectedOfferId;
  const selection = mailboxOfferSelection(
    loaded && !systemIdentified ? billing.data : undefined,
    planSelectedId,
    attemptedOfferId,
  );
  const offer = selection.offer;
  // A bundle (3 mailboxes for one price, a shared allowance) starts at its size.
  const minSeats = offer ? mailboxPlanMinimumSeats(offer) : 1;
  const maxSeats = offer ? mailboxPlanMaximumSeats(offer) : 10000;
  const bundle = !!offer && isMailboxBundle(offer);
  // A plan always buys exactly its mailboxes (the server fixes the quantity).
  const planPurchase = !!offer?.plan;
  useEffect(() => {
    setSeats((current) => {
      const value = Math.trunc(Number(current));
      return String(
        Math.min(maxSeats, Math.max(minSeats, Number.isFinite(value) ? value : minSeats)),
      );
    });
  }, [minSeats, maxSeats]);
  const lockedSeats = billing.data?.pendingOfferId
    ? (billing.data.pendingCheckoutSeats ?? null)
    : (billing.data?.pendingCheckoutSeats ?? attemptedSeats ?? null);
  const quantity = lockedSeats ?? Number(seats);
  const validSeats = offer
    ? validMailboxPlanSeats(offer, quantity)
    : Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 10000;
  const total = offer ? mailboxPlanTotal(offer, quantity) : null;
  const localTotal = offer ? mailboxPlanTotal(offer, quantity, true) : null;
  const teamQuota = plan?.quotaScope === "team";
  const trial = plan?.trial ?? null;
  const trialEnd = trial
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(trial.endsAt))
    : null;
  const minChangeSeats = plan?.includedMailboxes ?? 1;
  const availability = billing.data?.availability;
  const sendingPlanRequired =
    loaded &&
    !systemIdentified &&
    (billing.data?.sendingPlanRequired === true ||
      availability === "sending_plan_required" ||
      failure === "sending_plan_required");
  const canPurchase =
    loaded &&
    !systemIdentified &&
    !sendingPlanRequired &&
    billing.data?.canPurchase === true &&
    !!offer &&
    (!selection.locked || lockedSeats !== null) &&
    failure !== "existing";
  const pending = !!billing.data?.checkoutPending || failure === "pending" || selection.locked;
  const refreshing = service.isFetching || (!systemIdentified && billing.isFetching);
  const status =
    plan?.status === "active" || plan?.status === "trialing"
      ? plan.active
        ? plan.status
        : plan.periodEnd && plan.periodEnd.getTime() <= Date.now()
          ? "expired"
          : "restricted"
      : (plan?.status ?? "inactive");
  const date = plan?.periodEnd
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(plan.periodEnd)
    : null;
  const cycleStart = plan?.periodStart
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(plan.periodStart)
    : null;
  const notice = mailboxServiceNotice(availability, plan?.periodEnd, failure === "existing");
  const manage = billing.data?.management;
  // DTOs omit contract IDs. A later query publication invalidates local success/
  // payment feedback even when quantity and period happen to look identical.
  const currentManagementReadback =
    loaded &&
    !systemIdentified &&
    managementReadback !== null &&
    managementReadback.serviceUpdatedAt === service.dataUpdatedAt &&
    managementReadback.billingUpdatedAt === billing.dataUpdatedAt;
  const visibleManagementNotice =
    managementNotice === "error"
      ? "error"
      : currentManagementReadback && (managementNotice !== "pending" || manage?.pending)
        ? managementNotice
        : null;
  const visiblePaymentUrl =
    currentManagementReadback &&
    managementNotice === "pending" &&
    manage?.pending &&
    manage.requestedSeats !== null &&
    manage.requestedSeats === managementReadback?.requestedSeats
      ? paymentUrl
      : null;
  const busy =
    !systemIdentified && (checkout.isPending || management.isPending || changePlan.isPending);
  const currentPlanCode = manage?.currentPlan ?? null;
  const planChange = manage?.canChangePlan ? mailboxPlanOffers(manage.planOffers) : [];
  const currentPlanOffer = planChange.find((entry) => entry.current) ?? null;
  const planTarget =
    planChange.find((entry) => entry.offerId === changeTarget && !entry.current) ?? null;
  const planDirection = planTarget
    ? mailboxPlanDirection(currentPlanOffer, plan?.seats ?? 0, planTarget)
    : null;
  // Leaves the purchase begun in Stripe Checkout (never one already paid) so
  // another plan can be chosen; a payment that landed meanwhile is kept.
  const canAbandon = !!billing.data?.canAbandonCheckout;
  async function abandonPurchase() {
    if (!canAbandon || abandon.isPending || checkout.isPending || systemIdentified) return;
    setAbandonNotice(null);
    try {
      const result = await abandon.mutateAsync();
      if (!alive.current) return;
      if (result.state === "completed") {
        setAbandonNotice({ tone: "status", text: t("plans.abandonCompleted") });
        await refresh();
        return;
      }
      setAttemptedSeats(null);
      setAttemptedOfferId(null);
      setSelectedOfferId(null);
      setFailure(null);
      if (result.state === "abandoned")
        setAbandonNotice({ tone: "status", text: t("plans.abandoned") });
    } catch (error) {
      if (!alive.current) return;
      const reason = error instanceof TRPCClientError ? error.message : "";
      const code = error instanceof TRPCClientError ? error.data?.code : null;
      setAbandonNotice({
        tone: "alert",
        text:
          reason === "pending"
            ? t("plans.abandonPending")
            : code === "FORBIDDEN"
              ? t("plans.abandonForbidden")
              : t("plans.abandonError"),
      });
    }
    await Promise.allSettled([service.refetch(), billing.refetch()]);
  }
  async function runChangePlan() {
    if (!planTarget || busy || systemIdentified) return;
    const name = MAILBOX_PLAN_NAMES[planTarget.plan.code];
    setPlanNotice(null);
    try {
      const result = await changePlan.mutateAsync({ offerId: planTarget.offerId });
      if (!alive.current) return;
      setChangeTarget(null);
      setPlanNotice({
        tone: "status",
        text: t(result.direction === "upgrade" ? "plans.upgraded" : "plans.downgraded", { name }),
      });
    } catch (error) {
      if (!alive.current) return;
      const reason = error instanceof TRPCClientError ? error.message : "";
      setPlanNotice({
        tone: "alert",
        text:
          reason === "plan_too_small"
            ? t("plans.tooSmall", { name })
            : reason === "pending"
              ? t("plans.pending")
              : t("plans.changeError"),
      });
    }
    await Promise.allSettled([service.refetch(), billing.refetch()]);
    void queries.invalidateQueries({ queryKey: trpc.mailboxes.usage.pathKey() });
  }
  const changeSeats = Number(managedSeats);
  const maxChangeSeats = manage?.canIncrease ? 10000 : (plan?.seats ?? 0);
  const validChange =
    Number.isSafeInteger(changeSeats) &&
    changeSeats >= minChangeSeats &&
    changeSeats <= maxChangeSeats;
  async function runManagement(action: "cancel" | "resume" | "quantity", seats?: number) {
    if (busy || systemIdentified) return;
    const sequence = ++managementSequence.current;
    setManagementNotice(null);
    setPaymentUrl(null);
    setManagementReadback(null);
    try {
      const outcome = await management.mutateAsync({
        action,
        ...(seats !== undefined ? { seats } : {}),
      });
      await publishManagementResult(
        outcome,
        action === "quantity" ? (seats ?? null) : (manage?.requestedSeats ?? null),
        sequence,
      );
    } catch {
      if (!alive.current || managementSequence.current !== sequence) return;
      setManagementNotice("error");
      await Promise.allSettled([service.refetch(), billing.refetch()]);
    }
  }

  function closeDialog() {
    dialog.current?.close();
    setSelectedOfferId(null);
    setOpen(false);
  }
  return (
    <section className={styles.panel} aria-label={t("title")}>
      <div className={styles.summary}>
        <div className={styles.identity}>
          <strong>{t("title")}</strong>
          {currentPlanCode && !systemLicense ? (
            <span className={styles.planName}>{MAILBOX_PLAN_NAMES[currentPlanCode]}</span>
          ) : null}
          {plan ? (
            <span className={styles.badge} data-active={plan.active}>
              {systemLicense ? systemT("licenseLabel") : t(`status.${status}`)}
            </span>
          ) : null}
        </div>
        {plan ? (
          <p className={styles.usage}>
            {systemLicense
              ? systemT(systemUnlimited ? "mailboxesSummary" : "registeredSummary", {
                  count: plan.reservedSeats,
                })
              : t("seatsSummary", { used: plan.reservedSeats, included: plan.seats })}
            {plan.storageBytesPerMailbox > 0 ? (
              <span>
                {" "}
                ·{" "}
                {systemLicense
                  ? systemT(
                      plan.unlimitedOutbound ? "includedUnlimitedSummary" : "includedSummary",
                      {
                        storage: formatMailboxStorage(plan.storageBytesPerMailbox, locale),
                        messages: plan.includedOutboundPerMailbox,
                      },
                    )
                  : t(teamQuota ? "includedTeamSummary" : "includedSummary", {
                      storage: formatMailboxStorage(plan.storageBytesPerMailbox, locale),
                      messages: plan.includedOutboundPerMailbox,
                    })}
              </span>
            ) : null}
          </p>
        ) : (
          <p className={styles.usage}>
            {t(service.isError || billing.isError ? "loadError" : "loading")}
          </p>
        )}
        <button
          type="button"
          className="ms-btn ms-btn-ghost"
          onClick={() => {
            setSelectedOfferId(null);
            setOpen(true);
          }}
          aria-haspopup="dialog"
        >
          {t("viewPlan")}
        </button>
      </div>
      {trial && trialEnd && !systemIdentified ? (
        <p className={styles.trial} role="status">
          {t("trialSummary", {
            date: trialEnd,
            sentToday: trial.sentToday,
            dailyLimit: trial.dailyLimit,
            sentTotal: trial.sentTotal,
            totalLimit: trial.totalLimit,
          })}
        </p>
      ) : null}
      {returned && !systemIdentified ? (
        <div className={styles.returnNotice} role="status">
          <span>{t(plan?.active ? "confirmed" : "awaitingConfirmation")}</span>
          <button
            type="button"
            className="ms-btn ms-btn-ghost"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {t("refresh")}
          </button>
        </div>
      ) : null}
      {open ? (
        <dialog
          ref={dialog}
          className={styles.dialog}
          data-wide={planChoices.length > 0 || planChange.length > 0 || undefined}
          aria-labelledby={titleId}
          onClose={() => {
            setSelectedOfferId(null);
            setOpen(false);
          }}
          onCancel={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <header className={styles.dialogHeader}>
            <div>
              <p className={styles.eyebrow}>
                {systemLicense ? systemT("licenseLabel") : t("additionalService")}
              </p>
              <h2 id={titleId}>{t("title")}</h2>
            </div>
            <button
              type="button"
              className="ms-btn ms-btn-ghost"
              aria-label={t("close")}
              disabled={busy}
              onClick={closeDialog}
            >
              ×
            </button>
          </header>
          {loaded ? (
            <p className={styles.hint}>
              {systemLicense
                ? systemT("licenseBody")
                : planChoices.length || currentPlanCode
                  ? t("plans.intro")
                  : t(bundle ? "equalPriceBundle" : "equalPrice")}
            </p>
          ) : null}
          {!loaded ? (
            <div role={service.isError || billing.isError ? "alert" : "status"}>
              <p>{t(service.isError || billing.isError ? "loadError" : "loading")}</p>
              <button
                type="button"
                className="ms-btn"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                {t("retry")}
              </button>
            </div>
          ) : systemLicense && plan ? (
            <>
              <dl className={styles.facts}>
                <div>
                  <dt>{t("currentStatus")}</dt>
                  <dd>{systemT(plan.active ? "active" : "restricted")}</dd>
                </div>
                <div>
                  <dt>{systemT("registeredMailboxes")}</dt>
                  <dd>{systemT("registeredSummary", { count: plan.reservedSeats })}</dd>
                </div>
                <div>
                  <dt>{systemT("mailboxLimit")}</dt>
                  <dd>
                    {systemT(systemUnlimited ? "unlimitedMailboxes" : "admissionUnavailable")}
                  </dd>
                </div>
                <div>
                  <dt>{systemT("subscription")}</dt>
                  <dd>{systemT("noSubscription")}</dd>
                </div>
              </dl>
              <h3 className={styles.sectionTitle}>{t("resourcesTitle")}</h3>
              <p className={styles.hint}>{systemT("resourceLimitsBody")}</p>
              <dl className={styles.facts}>
                <div>
                  <dt>{t("storagePerMailbox")}</dt>
                  <dd>{formatMailboxStorage(plan.storageBytesPerMailbox, locale)}</dd>
                </div>
                <div>
                  <dt>{systemT("outboundPerMailbox")}</dt>
                  <dd>
                    {plan.unlimitedOutbound
                      ? systemT("unlimitedOutbound")
                      : t("messageCount", { count: plan.includedOutboundPerMailbox })}
                  </dd>
                </div>
                {!plan.unlimitedOutbound && cycleStart && date ? (
                  <div>
                    <dt>{systemT("operationalCycle")}</dt>
                    <dd>{systemT("cycleDates", { start: cycleStart, end: date })}</dd>
                  </div>
                ) : null}
              </dl>
              <p className={styles.notice} role="status">
                {systemT(
                  plan.unlimitedOutbound && plan.resourcePolicyActive
                    ? "internalUsageActiveBody"
                    : plan.resourcePolicyActive
                      ? "cycleActiveBody"
                      : "cycleInactiveBody",
                )}
              </p>
            </>
          ) : (
            <>
              <dl className={styles.facts}>
                <div>
                  <dt>{t("currentStatus")}</dt>
                  <dd>{t(`status.${status}`)}</dd>
                </div>
                <div>
                  <dt>{t("reservedSeats")}</dt>
                  <dd>{t("seatsSummary", { used: plan!.reservedSeats, included: plan!.seats })}</dd>
                </div>
                {plan!.storageBytesPerMailbox > 0 ? (
                  <>
                    <div>
                      <dt>{t(teamQuota ? "storageTeam" : "storagePerMailbox")}</dt>
                      <dd>{formatMailboxStorage(plan!.storageBytesPerMailbox, locale)}</dd>
                    </div>
                    <div>
                      <dt>{t(teamQuota ? "outboundTeam" : "outboundPerMailbox")}</dt>
                      <dd>{t("messageCount", { count: plan!.includedOutboundPerMailbox })}</dd>
                    </div>
                  </>
                ) : null}
                {trial && trialEnd ? (
                  <div>
                    <dt>{t("trialFact")}</dt>
                    <dd>
                      {t("trialFactValue", {
                        date: trialEnd,
                        dailyLimit: trial.dailyLimit,
                        totalLimit: trial.totalLimit,
                      })}
                    </dd>
                  </div>
                ) : null}
                {date ? (
                  <div>
                    <dt>{t("periodEnd")}</dt>
                    <dd>{date}</dd>
                  </div>
                ) : null}
              </dl>
              {trial ? <p className={styles.notice}>{t("trialLimitsLift")}</p> : null}
              {plan!.cancelAtPeriodEnd ? (
                <p className={styles.notice}>{t("cancelScheduled", { date: date ?? "" })}</p>
              ) : null}
              {manage?.scheduledSeats !== null && manage?.scheduledSeats !== undefined ? (
                <p className={styles.notice}>
                  {t("reductionScheduled", {
                    count: manage.scheduledSeats,
                    date: manage.effectiveAt
                      ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
                          manage.effectiveAt,
                        )
                      : "",
                  })}
                </p>
              ) : null}
              {manage?.requestedSeats !== null && manage?.requestedSeats !== undefined ? (
                <p role="status">{t("increasePending", { count: manage.requestedSeats })}</p>
              ) : null}
              {sendingPlanRequired ? (
                <div
                  className={styles.notice}
                  role={failure === "sending_plan_required" ? "alert" : "status"}
                >
                  <p>{t("sendingPlanRequiredBody")}</p>
                  <a className="ms-btn ms-btn-primary" href="/settings/billing">
                    {t("viewSendingPlans")}
                  </a>
                </div>
              ) : null}
              {planChange.length ? (
                <section className={styles.planChange} aria-labelledby={planChangeTitleId}>
                  <h3 className={styles.sectionTitle} id={planChangeTitleId}>
                    {t(currentPlanCode ? "plans.changeTitle" : "plans.migrateTitle")}
                  </h3>
                  <p className={styles.hint}>
                    {t(currentPlanCode ? "plans.changeHint" : "plans.migrateHint")}
                  </p>
                  <MailboxPlanCards
                    offers={planChange}
                    selectedId={planTarget?.offerId ?? currentPlanOffer?.offerId ?? null}
                    onSelect={(id) => {
                      setPlanNotice(null);
                      setChangeTarget(
                        planChange.find((entry) => entry.offerId === id)?.current ? null : id,
                      );
                    }}
                    label={t(currentPlanCode ? "plans.changeTitle" : "plans.migrateTitle")}
                    disabled={busy}
                  />
                  {planTarget && planDirection ? (
                    <div className={styles.notice} role="status">
                      <p>
                        {t(
                          planDirection === "downgrade"
                            ? "plans.downgradeTerms"
                            : status === "trialing"
                              ? "plans.upgradeTrialTerms"
                              : "plans.upgradeTerms",
                          { name: MAILBOX_PLAN_NAMES[planTarget.plan.code] },
                        )}
                      </p>
                      <div className={styles.planActions}>
                        <button
                          type="button"
                          className="ms-btn ms-btn-primary"
                          disabled={busy}
                          onClick={() => void runChangePlan()}
                        >
                          {changePlan.isPending
                            ? t("plans.changing")
                            : t(
                                planDirection === "upgrade"
                                  ? "plans.upgradeTo"
                                  : "plans.downgradeTo",
                                {
                                  name: MAILBOX_PLAN_NAMES[planTarget.plan.code],
                                },
                              )}
                        </button>
                        <button
                          type="button"
                          className="ms-btn ms-btn-ghost"
                          disabled={busy}
                          onClick={() => setChangeTarget(null)}
                        >
                          {t("plans.keep")}
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {planNotice ? <p role={planNotice.tone}>{planNotice.text}</p> : null}
                </section>
              ) : null}
              {manage &&
              (manage.canReconcile || manage.canAdjust || manage.canCancel || manage.canResume) ? (
                <div className={styles.management}>
                  {/* Quantity terms belong to the older contracts; a plan changes plan instead. */}
                  {!currentPlanCode ? <p className={styles.hint}>{t("managementTerms")}</p> : null}
                  {manage.canAdjust ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (validChange) void runManagement("quantity", changeSeats);
                      }}
                    >
                      <label htmlFor={`${seatsId}-manage`}>{t("manageQuantity")}</label>
                      <input
                        id={`${seatsId}-manage`}
                        className="ms-input"
                        type="number"
                        inputMode="numeric"
                        min={minChangeSeats}
                        max={maxChangeSeats}
                        step={1}
                        required
                        value={managedSeats}
                        placeholder={String(manage.scheduledSeats ?? plan!.seats)}
                        disabled={busy}
                        onChange={(event) => setManagedSeats(event.target.value)}
                      />
                      <button className="ms-btn" type="submit" disabled={busy || !validChange}>
                        {t(changeSeats > plan!.seats ? "requestIncrease" : "requestReduction")}
                      </button>
                    </form>
                  ) : null}
                  {manage.canCancel ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void runManagement("cancel");
                      }}
                    >
                      <p>{t("cancelTerms", { date: date ?? "" })}</p>
                      <button className="ms-btn ms-btn-ghost" type="submit" disabled={busy}>
                        {t("cancelAtEnd")}
                      </button>
                    </form>
                  ) : null}
                  {manage.canResume ? (
                    <button
                      className="ms-btn"
                      type="button"
                      disabled={busy}
                      onClick={() => void runManagement("resume")}
                    >
                      {t("resumeRenewal")}
                    </button>
                  ) : null}
                  {manage.pending ? <p role="status">{t("managementPending")}</p> : null}
                  {visibleManagementNotice ? (
                    <p role={visibleManagementNotice === "error" ? "alert" : "status"}>
                      {t(`managementResult.${visibleManagementNotice}`)}
                    </p>
                  ) : null}
                  {visiblePaymentUrl ? (
                    <a className="ms-btn" href={visiblePaymentUrl} target="_blank" rel="noreferrer">
                      {t("completeIncreasePayment")}
                    </a>
                  ) : null}
                </div>
              ) : null}
              {!canPurchase ? (
                <div className={styles.notice}>
                  {!sendingPlanRequired ||
                  notice === "existingLicenseBody" ||
                  notice === "existingBody" ||
                  notice === "recoveryBody" ||
                  notice === "adminBody" ? (
                    <p>
                      {t(
                        selection.locked && (!offer || lockedSeats === null)
                          ? "pendingOfferUnavailable"
                          : notice,
                      )}
                    </p>
                  ) : null}
                  <p>{t("recoveryReads")}</p>
                </div>
              ) : offer ? (
                <form
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (!canPurchase || !validSeats || checkout.isPending) return;
                    setAttemptedSeats(quantity);
                    setAttemptedOfferId(selection.offerId);
                    setFailure(null);
                    try {
                      const result = await checkout.mutateAsync({
                        seats: quantity,
                        ...(selection.offerId ? { offerId: selection.offerId } : {}),
                      });
                      if (!alive.current) return;
                      const url = safeMailboxCheckoutUrl(result.url);
                      if (!url) {
                        setFailure("pending");
                        return;
                      }
                      window.location.assign(url);
                    } catch (error) {
                      if (!alive.current) return;
                      const reason = mailboxCheckoutFailure(error);
                      if (reason === "error" || reason === "sending_plan_required") {
                        setAttemptedSeats(null);
                        setAttemptedOfferId(null);
                      }
                      setFailure(reason);
                      void refresh();
                    }
                  }}
                >
                  <fieldset className={styles.purchase} disabled={checkout.isPending}>
                    {planPurchase ? (
                      <>
                        <MailboxPlanCards
                          offers={
                            selection.locked
                              ? mailboxPlanOffers([{ ...offer, offerId: selection.offerId ?? "" }])
                              : planChoices
                          }
                          selectedId={selection.offerId}
                          onSelect={setSelectedOfferId}
                          label={t("plans.choose")}
                          disabled={selection.locked || lockedSeats !== null}
                        />
                        <p className={styles.hint}>
                          {selection.locked || lockedSeats !== null
                            ? t(canAbandon ? "plans.pendingPlan" : "plans.pendingPlanResume", {
                                name: offer.plan
                                  ? (MAILBOX_PLAN_NAMES[
                                      offer.plan.code as keyof typeof MAILBOX_PLAN_NAMES
                                    ] ?? "")
                                  : "",
                              })
                            : t("plans.choiceHint")}
                        </p>
                      </>
                    ) : selection.offers.length || selection.locked ? (
                      <>
                        <label htmlFor={offerId}>
                          {t(bundle ? "planChoiceBundle" : "planChoice")}
                        </label>
                        <select
                          id={offerId}
                          className="ms-input"
                          value={selection.offerId ?? ""}
                          disabled={selection.locked || lockedSeats !== null}
                          aria-describedby={offerHintId}
                          onChange={(event) => setSelectedOfferId(event.target.value)}
                        >
                          {(selection.locked && selection.offerId
                            ? [{ ...offer, offerId: selection.offerId }]
                            : selection.offers
                          ).map((entry) => (
                            <option key={entry.offerId} value={entry.offerId}>
                              {t(isMailboxBundle(entry) ? "planOptionBundle" : "planOption", {
                                mailboxes: mailboxPlanMinimumSeats(entry),
                                storage: formatMailboxStorage(entry.storageBytesPerMailbox, locale),
                                price: t("priceInterval", {
                                  amount: formatMailboxPrice(
                                    entry.unitAmount,
                                    entry.currency,
                                    locale,
                                  ),
                                  interval: t(`interval.${entry.interval}`),
                                }),
                              })}
                            </option>
                          ))}
                        </select>
                        <p id={offerHintId} className={styles.hint}>
                          {t(
                            selection.locked || lockedSeats !== null
                              ? "planLocked"
                              : bundle
                                ? "planChoiceHintBundle"
                                : "planChoiceHint",
                          )}
                        </p>
                      </>
                    ) : null}
                    {!planPurchase ? (
                      <>
                        <label htmlFor={seatsId}>{t("quantity")}</label>
                        <input
                          id={seatsId}
                          className="ms-input"
                          type="number"
                          inputMode="numeric"
                          min={minSeats}
                          max={maxSeats}
                          step={1}
                          required
                          value={lockedSeats ?? seats}
                          disabled={lockedSeats !== null}
                          aria-describedby={seatsHintId}
                          onChange={(event) => setSeats(event.target.value)}
                          autoFocus
                        />
                        <p id={seatsHintId} className={styles.hint}>
                          {lockedSeats !== null
                            ? t("quantityLocked")
                            : bundle && offer.extraUnitAmount
                              ? t("quantityHintBundle", {
                                  included: minSeats,
                                  extra: t("priceInterval", {
                                    amount: formatMailboxPrice(
                                      offer.extraUnitAmount,
                                      offer.currency,
                                      locale,
                                    ),
                                    interval: t(`interval.${offer.interval}`),
                                  }),
                                })
                              : t("quantityHint")}
                        </p>
                        <dl className={styles.offer}>
                          <div>
                            <dt>
                              {t(bundle ? "bundlePrice" : "pricePerMailbox", { count: minSeats })}
                            </dt>
                            <dd>
                              {t("priceInterval", {
                                amount: formatMailboxPrice(
                                  offer.unitAmount,
                                  offer.currency,
                                  locale,
                                ),
                                interval: t(`interval.${offer.interval}`),
                              })}
                            </dd>
                          </div>
                          {bundle && offer.extraUnitAmount ? (
                            <div>
                              <dt>{t("extraMailbox")}</dt>
                              <dd>
                                {t("priceInterval", {
                                  amount: formatMailboxPrice(
                                    offer.extraUnitAmount,
                                    offer.currency,
                                    locale,
                                  ),
                                  interval: t(`interval.${offer.interval}`),
                                })}
                              </dd>
                            </div>
                          ) : null}
                          <div>
                            <dt>{t(offer.quotaScope === "team" ? "includedTeam" : "included")}</dt>
                            <dd>
                              {t(
                                offer.quotaScope === "team"
                                  ? "includedTeamSummary"
                                  : "includedSummary",
                                {
                                  storage: formatMailboxStorage(
                                    offer.storageBytesPerMailbox,
                                    locale,
                                  ),
                                  messages: offer.includedOutboundPerMailbox,
                                },
                              )}
                            </dd>
                          </div>
                          <div className={styles.total}>
                            <dt>{t("total", { count: validSeats ? quantity : 0 })}</dt>
                            <dd>
                              {total
                                ? t("priceInterval", {
                                    amount: formatMailboxPrice(
                                      total.amount,
                                      total.currency,
                                      locale,
                                    ),
                                    interval: t(`interval.${offer.interval}`),
                                  })
                                : "—"}
                            </dd>
                          </div>
                        </dl>
                      </>
                    ) : null}
                    {localTotal && !planPurchase ? (
                      <p className={styles.hint}>
                        {t("localTotal", {
                          amount: t("priceInterval", {
                            amount: formatMailboxPrice(
                              localTotal.amount,
                              localTotal.currency,
                              locale,
                            ),
                            interval: t(`interval.${offer.interval}`),
                          }),
                        })}
                      </p>
                    ) : null}
                    {offer.trialDays ? (
                      <p className={styles.trialOffer}>
                        {t("trialOffer", { days: offer.trialDays })}
                      </p>
                    ) : null}
                    <p className={styles.hint}>{t("checkoutTerms")}</p>
                    {pending || failure ? (
                      <p className={styles.notice} role={failure ? "alert" : "status"}>
                        {t(
                          failure === "unavailable"
                            ? "unavailableBody"
                            : failure === "error"
                              ? "checkoutError"
                              : planPurchase
                                ? "plans.pendingBody"
                                : "pendingBody",
                        )}
                      </p>
                    ) : null}
                    <div className={styles.purchaseActions}>
                      <button
                        type="submit"
                        className="ms-btn ms-btn-primary"
                        disabled={
                          !validSeats || checkout.isPending || refreshing || abandon.isPending
                        }
                      >
                        {checkout.isPending
                          ? t("opening")
                          : pending || lockedSeats !== null
                            ? t(planPurchase ? "plans.resume" : "retryCheckout")
                            : offer.trialDays
                              ? t("startTrial", { days: offer.trialDays })
                              : t("subscribe")}
                      </button>
                      {canAbandon && (pending || lockedSeats !== null) ? (
                        <button
                          type="button"
                          className="ms-btn ms-btn-ghost"
                          disabled={checkout.isPending || abandon.isPending}
                          onClick={() => void abandonPurchase()}
                        >
                          {abandon.isPending ? t("plans.abandoning") : t("plans.chooseAnother")}
                        </button>
                      ) : null}
                    </div>
                    {abandonNotice ? <p role={abandonNotice.tone}>{abandonNotice.text}</p> : null}
                  </fieldset>
                </form>
              ) : null}
              {canPurchase || notice === "existingBody" ? (
                <p className={styles.hint}>{t("confirmationHint")}</p>
              ) : null}
            </>
          )}
          <footer className={styles.dialogFooter}>
            <a
              className={`ms-btn ms-btn-ghost ${styles.docsLink}`}
              href={DOCS_URL}
              target="_blank"
              rel="noreferrer"
            >
              {t("documentation")}
            </a>
            <button
              type="button"
              className="ms-btn ms-btn-ghost"
              disabled={refreshing || busy}
              onClick={() => void refresh()}
            >
              {t("refresh")}
            </button>
            <button type="button" className="ms-btn" disabled={busy} onClick={closeDialog}>
              {t("close")}
            </button>
          </footer>
        </dialog>
      ) : null}
    </section>
  );
}
