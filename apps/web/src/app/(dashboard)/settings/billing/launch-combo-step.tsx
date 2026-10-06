"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { BtnSpinner } from "@/components/spinner";
import { formatUsd } from "@/lib/format";
import {
  clearLaunchComboIntent,
  type LaunchComboIntent,
  launchComboQuote,
  matchLaunchComboOffer,
} from "@/lib/launch-combo";
import { getLaunchMailboxPlan } from "@/lib/launch-offer";
import { mailboxCheckoutFailure, safeMailboxCheckoutUrl } from "@/lib/mailbox-checkout";
import { useTRPC } from "@/lib/trpc";

// The Send webhook sets the contract a few seconds after Checkout returns;
// Mail admission reads that contract, so the step polls for a short while.
const POLL_MS = 2500;
const POLL_WINDOW_MS = 90_000;

/** Step 2 of the Send + Mail combo: a separate Mail Checkout, opened only by a click. */
export function LaunchComboMailStep({
  intent,
  canManage,
  onDone,
}: {
  intent: LaunchComboIntent;
  canManage: boolean;
  onDone: () => void;
}) {
  const t = useTranslations("settings.billing");
  const locale = useLocale();
  const trpc = useTRPC();
  const titleId = useId();
  const alive = useRef(true);
  const [deadline, setDeadline] = useState(() => Date.now() + POLL_WINDOW_MS);
  const [timedOut, setTimedOut] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof mailboxCheckoutFailure> | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setTimedOut(false);
    const timer = window.setTimeout(() => setTimedOut(true), Math.max(0, deadline - Date.now()));
    return () => window.clearTimeout(timer);
  }, [deadline]);

  const capabilities = useQuery({
    ...trpc.mailboxes.capabilities.queryOptions(),
    refetchInterval: (query) => (!timedOut && query.state.data?.enabled !== true ? POLL_MS : false),
  });
  const billing = useQuery({
    ...trpc.mailboxes.billing.queryOptions(undefined, { retry: false }),
    enabled: canManage && capabilities.data?.enabled === true,
    refetchInterval: (query) =>
      !timedOut && query.state.data?.availability === "sending_plan_required" ? POLL_MS : false,
  });
  const checkout = useMutation(trpc.mailboxes.checkout.mutationOptions());

  const availability = billing.data?.availability;
  useEffect(() => {
    if (availability === "existing_subscription") clearLaunchComboIntent();
  }, [availability]);

  const plan = getLaunchMailboxPlan(intent.tier);
  const quote = launchComboQuote(intent);
  const usd = (cents: number) => formatUsd(cents, locale);
  const per = t(intent.interval === "year" ? "launch.perYear" : "perMonth");
  const offerId = billing.data
    ? matchLaunchComboOffer(billing.data.offers, intent.tier, intent.interval)
    : null;
  const confirming =
    !timedOut &&
    (capabilities.isPending ||
      capabilities.data?.enabled !== true ||
      billing.isPending ||
      availability === "sending_plan_required");
  const ready = availability === "available" && !!offerId && billing.data?.canPurchase === true;

  async function pay() {
    if (!ready || !offerId || checkout.isPending) return;
    setFailure(null);
    try {
      const result = await checkout.mutateAsync({ seats: intent.seats, offerId });
      if (!alive.current) return;
      const url = safeMailboxCheckoutUrl(result.url);
      if (!url) {
        setFailure("pending");
        return;
      }
      clearLaunchComboIntent();
      window.location.assign(url);
    } catch (error) {
      if (!alive.current) return;
      setFailure(mailboxCheckoutFailure(error));
      void billing.refetch();
    }
  }

  const openCorreio = (
    <Link href="/mailboxes" className="ms-btn ms-btn-secondary">
      {t("combo.openMailboxes")}
    </Link>
  );
  const body = !canManage ? (
    <p>{t("readOnly")}</p>
  ) : failure ? (
    <p role="alert" style={{ color: "var(--ms-danger)" }}>
      {t(
        failure === "existing"
          ? "combo.existing"
          : failure === "unavailable"
            ? "combo.unavailable"
            : failure === "sending_plan_required"
              ? "combo.timedOut"
              : "combo.pending",
      )}
    </p>
  ) : availability === "existing_subscription" ? (
    <p role="status">{t("combo.existing")}</p>
  ) : confirming ? (
    <p role="status" style={{ display: "flex", gap: 10, alignItems: "center" }}>
      <BtnSpinner on />
      {t("combo.confirming")}
    </p>
  ) : ready ? (
    <p>{t("combo.ready")}</p>
  ) : availability === "sending_plan_required" || capabilities.data?.enabled !== true ? (
    <p role="status">{t("combo.timedOut")}</p>
  ) : (
    <p>{t("combo.manual")}</p>
  );
  const retryable =
    canManage &&
    !confirming &&
    !failure &&
    (availability === "sending_plan_required" || capabilities.data?.enabled !== true);

  return (
    <section className="ms-card" style={{ padding: 24 }} aria-labelledby={titleId}>
      <div className="ms-microlabel" style={{ marginBottom: 8 }}>
        {t("combo.step")}
      </div>
      <h2
        id={titleId}
        className="ms-display"
        style={{ fontSize: "var(--ms-fs-h2)", color: "var(--ms-bone)", margin: "0 0 12px" }}
      >
        {t("combo.title")}
      </h2>
      <p style={{ margin: "0 0 14px", color: "var(--ms-bone)", fontSize: 15, lineHeight: 1.6 }}>
        {t("combo.summary", {
          seats: intent.seats,
          size: `${plan.storageGiB} GiB`,
          unit: usd(quote.mailUnitPeriodCents),
          total: usd(quote.mailPeriodCents),
          per,
        })}
      </p>
      <div style={{ color: "var(--ms-muted)", fontSize: 14, lineHeight: 1.6 }}>{body}</div>
      <div className="ms-wrap-row" style={{ display: "flex", gap: 12, marginTop: 18 }}>
        {canManage && ready && !failure ? (
          <button
            type="button"
            className="ms-btn ms-btn-primary"
            disabled={checkout.isPending}
            onClick={() => void pay()}
          >
            <BtnSpinner on={checkout.isPending} />
            {t("combo.pay", { total: usd(quote.mailPeriodCents), per })}
          </button>
        ) : null}
        {retryable ? (
          <button
            type="button"
            className="ms-btn ms-btn-primary"
            onClick={() => {
              setDeadline(Date.now() + POLL_WINDOW_MS);
              void capabilities.refetch();
              if (capabilities.data?.enabled) void billing.refetch();
            }}
          >
            {t("combo.retry")}
          </button>
        ) : null}
        {!ready || failure ? openCorreio : null}
        <button
          type="button"
          className="ms-btn ms-btn-ghost"
          disabled={checkout.isPending}
          onClick={() => {
            clearLaunchComboIntent();
            onDone();
          }}
        >
          {t(availability === "existing_subscription" ? "combo.close" : "combo.skip")}
        </button>
      </div>
    </section>
  );
}
