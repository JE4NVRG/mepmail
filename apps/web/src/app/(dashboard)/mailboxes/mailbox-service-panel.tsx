"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTRPC } from "@/lib/trpc";
import styles from "./mailbox-service-panel.module.css";

/** Hosted Checkout only; a provider response is never allowed to redirect to an arbitrary origin. */
export function safeMailboxCheckoutUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "checkout.stripe.com" &&
      !url.username &&
      !url.password &&
      !url.port
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function formatMailboxPrice(amount: number, currency: string, locale: string): string {
  const format = new Intl.NumberFormat(locale, { style: "currency", currency });
  // Stripe represents ISK charges in hundredths despite the currency's zero-decimal display.
  const decimals =
    currency.toLowerCase() === "isk" ? 2 : format.resolvedOptions().maximumFractionDigits;
  return format.format(amount / 10 ** (decimals ?? 2));
}

function storageLabel(bytes: number, locale: string): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index =
    bytes > 0 ? Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1) : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(bytes / 1024 ** index)} ${units[index]}`;
}

export function MailboxServicePanel() {
  const t = useTranslations("mailboxes-service");
  const locale = useLocale();
  const trpc = useTRPC();
  const service = useQuery(trpc.mailboxes.service.queryOptions(undefined, { retry: false }));
  const billing = useQuery(trpc.mailboxes.billing.queryOptions(undefined, { retry: false }));
  const checkout = useMutation(trpc.mailboxes.checkout.mutationOptions());
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(false);
  const returnChecked = useRef(false);
  const titleId = useId();
  const seatsId = useId();
  const seatsHintId = useId();
  const [open, setOpen] = useState(false);
  const [seats, setSeats] = useState("1");
  const [attemptedSeats, setAttemptedSeats] = useState<number | null>(null);
  const [failure, setFailure] = useState<"pending" | "existing" | "unavailable" | "error" | null>(
    null,
  );
  const [returned, setReturned] = useState(false);
  const refresh = useCallback(async () => {
    await Promise.allSettled([service.refetch(), billing.refetch()]);
  }, [service.refetch, billing.refetch]);
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

  const loaded = !!service.data && !!billing.data && !service.isError && !billing.isError;
  const plan = loaded ? service.data : undefined;
  const offer = loaded ? billing.data?.offer : null;
  const lockedSeats = attemptedSeats ?? billing.data?.pendingCheckoutSeats ?? null;
  const quantity = lockedSeats ?? Number(seats);
  const validSeats = Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 10000;
  const canPurchase =
    loaded && billing.data?.canPurchase === true && !!offer && failure !== "existing";
  const pending = !!billing.data?.checkoutPending || failure === "pending";
  const refreshing = service.isFetching || billing.isFetching;
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
  const availability = billing.data?.availability;
  const notice =
    availability === "existing_subscription" || failure === "existing"
      ? "existingBody"
      : availability === "recovery_required"
        ? "recoveryBody"
        : availability === "forbidden"
          ? "adminBody"
          : "unavailableBody";

  function closeDialog() {
    dialog.current?.close();
    setOpen(false);
  }
  return (
    <section className={styles.panel} aria-label={t("title")}>
      <div className={styles.summary}>
        <div className={styles.identity}>
          <strong>{t("title")}</strong>
          {plan ? (
            <span className={styles.badge} data-active={plan.active}>
              {t(`status.${status}`)}
            </span>
          ) : null}
        </div>
        {plan ? (
          <p className={styles.usage}>
            {t("seatsSummary", { used: plan.reservedSeats, included: plan.seats })}
            {plan.storageBytesPerMailbox > 0 ? (
              <span>
                {" "}
                ·{" "}
                {t("includedSummary", {
                  storage: storageLabel(plan.storageBytesPerMailbox, locale),
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
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
        >
          {t("viewPlan")}
        </button>
      </div>
      {returned ? (
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
          aria-labelledby={titleId}
          onClose={() => setOpen(false)}
          onCancel={(event) => {
            if (checkout.isPending) event.preventDefault();
          }}
        >
          <header className={styles.dialogHeader}>
            <div>
              <p className={styles.eyebrow}>{t("additionalService")}</p>
              <h2 id={titleId}>{t("title")}</h2>
            </div>
            <button
              type="button"
              className="ms-btn ms-btn-ghost"
              aria-label={t("close")}
              disabled={checkout.isPending}
              onClick={closeDialog}
            >
              ×
            </button>
          </header>
          <p className={styles.hint}>{t("equalPrice")}</p>
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
                      <dt>{t("storagePerMailbox")}</dt>
                      <dd>{storageLabel(plan!.storageBytesPerMailbox, locale)}</dd>
                    </div>
                    <div>
                      <dt>{t("outboundPerMailbox")}</dt>
                      <dd>{t("messageCount", { count: plan!.includedOutboundPerMailbox })}</dd>
                    </div>
                  </>
                ) : null}
                {date ? (
                  <div>
                    <dt>{t("periodEnd")}</dt>
                    <dd>{date}</dd>
                  </div>
                ) : null}
              </dl>
              {!canPurchase ? (
                <div className={styles.notice}>
                  <p>{t(notice)}</p>
                  <p>{t("recoveryReads")}</p>
                </div>
              ) : offer ? (
                <form
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (!canPurchase || !validSeats || checkout.isPending) return;
                    setAttemptedSeats(quantity);
                    setFailure(null);
                    try {
                      const result = await checkout.mutateAsync({ seats: quantity });
                      if (!alive.current) return;
                      const url = safeMailboxCheckoutUrl(result.url);
                      if (!url) {
                        setFailure("pending");
                        return;
                      }
                      window.location.assign(url);
                    } catch (error) {
                      if (!alive.current) return;
                      const message = (error as { message?: string })?.message;
                      const code = (error as { data?: { code?: string } })?.data?.code;
                      if (message === "expired") {
                        setAttemptedSeats(null);
                        setFailure("error");
                      } else
                        setFailure(
                          message === "subscription_exists"
                            ? "existing"
                            : message === "mailbox_billing_unavailable" || code === "FORBIDDEN"
                              ? "unavailable"
                              : "pending",
                        );
                      void refresh();
                    }
                  }}
                >
                  <fieldset className={styles.purchase} disabled={checkout.isPending}>
                    <label htmlFor={seatsId}>{t("quantity")}</label>
                    <input
                      id={seatsId}
                      className="ms-input"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={10000}
                      step={1}
                      required
                      value={lockedSeats ?? seats}
                      disabled={lockedSeats !== null}
                      aria-describedby={seatsHintId}
                      onChange={(event) => setSeats(event.target.value)}
                      autoFocus
                    />
                    <p id={seatsHintId} className={styles.hint}>
                      {t(lockedSeats !== null ? "quantityLocked" : "quantityHint")}
                    </p>
                    <dl className={styles.offer}>
                      <div>
                        <dt>{t("pricePerMailbox")}</dt>
                        <dd>
                          {t("priceInterval", {
                            amount: formatMailboxPrice(offer.unitAmount, offer.currency, locale),
                            interval: t(`interval.${offer.interval}`),
                          })}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("included")}</dt>
                        <dd>
                          {t("includedSummary", {
                            storage: storageLabel(offer.storageBytesPerMailbox, locale),
                            messages: offer.includedOutboundPerMailbox,
                          })}
                        </dd>
                      </div>
                      <div className={styles.total}>
                        <dt>{t("total", { count: validSeats ? quantity : 0 })}</dt>
                        <dd>
                          {validSeats
                            ? t("priceInterval", {
                                amount: formatMailboxPrice(
                                  offer.unitAmount * quantity,
                                  offer.currency,
                                  locale,
                                ),
                                interval: t(`interval.${offer.interval}`),
                              })
                            : "—"}
                        </dd>
                      </div>
                    </dl>
                    <p className={styles.hint}>{t("checkoutTerms")}</p>
                    {pending || failure ? (
                      <p className={styles.notice} role={failure ? "alert" : "status"}>
                        {t(
                          failure === "unavailable"
                            ? "unavailableBody"
                            : failure === "error"
                              ? "checkoutError"
                              : "pendingBody",
                        )}
                      </p>
                    ) : null}
                    <button
                      className="ms-btn ms-btn-primary"
                      disabled={!validSeats || checkout.isPending || refreshing}
                    >
                      {t(
                        checkout.isPending
                          ? "opening"
                          : pending || lockedSeats !== null
                            ? "retryCheckout"
                            : "subscribe",
                      )}
                    </button>
                  </fieldset>
                </form>
              ) : null}
              <p className={styles.hint}>{t("confirmationHint")}</p>
            </>
          )}
          <footer className={styles.dialogFooter}>
            <button
              type="button"
              className="ms-btn ms-btn-ghost"
              disabled={refreshing || checkout.isPending}
              onClick={() => void refresh()}
            >
              {t("refresh")}
            </button>
            <button
              type="button"
              className="ms-btn"
              disabled={checkout.isPending}
              onClick={closeDialog}
            >
              {t("close")}
            </button>
          </footer>
        </dialog>
      ) : null}
    </section>
  );
}
