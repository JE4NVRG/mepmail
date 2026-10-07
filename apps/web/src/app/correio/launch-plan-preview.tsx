"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import {
  calculateLaunchQuote,
  getLaunchMailboxPlan,
  LAUNCH_OFFER,
  type LaunchBillingPeriod,
  type LaunchMailboxTierId,
  parseLaunchMailboxQuantity,
} from "@/lib/launch-offer";

/** Price comparison only. It does not open checkout or grant Mail access. */
export function LaunchPlanPreview({ earlyAccessOpen = false }: { earlyAccessOpen?: boolean }) {
  const t = useTranslations("correio.preview");
  const release = useTranslations("correio.release");
  const locale = useLocale();
  const groupId = useId();
  const titleId = `${groupId}-title`;
  const quantityId = `${groupId}-quantity`;
  const quantityHintId = `${groupId}-quantity-hint`;
  const quantityErrorId = `${groupId}-quantity-error`;
  const [period, setPeriod] = useState<LaunchBillingPeriod>("month");
  const [mailboxId, setMailboxId] = useState<LaunchMailboxTierId>("gib1");
  const [quantityInput, setQuantityInput] = useState("1");
  const quantity = parseLaunchMailboxQuantity(quantityInput);
  const mailbox = getLaunchMailboxPlan(mailboxId);
  const annual = period === "year";
  const sending = calculateLaunchQuote({ period, isNewCustomer: true });
  const combined =
    quantity === null
      ? null
      : calculateLaunchQuote({
          period,
          mailboxTierId: mailboxId,
          mailboxQuantity: quantity,
          isNewCustomer: true,
        });
  const currency = (cents: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: LAUNCH_OFFER.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);

  return (
    <section className="correio-preview" aria-labelledby={titleId}>
      <div className="correio-preview-heading">
        <div>
          <p className="correio-eyebrow">{t("eyebrow")}</p>
          <h3 id={titleId}>{t("title")}</h3>
          <p>{t("body")}</p>
        </div>
        <p className="correio-preview-status">
          {earlyAccessOpen ? release("previewStatus") : t("status")}
        </p>
      </div>
      <div className="correio-preview-controls">
        <fieldset>
          <legend>{t("periodLegend")}</legend>
          <div className="correio-preview-options">
            {(["month", "year"] as const).map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name={`${groupId}-period`}
                  value={value}
                  checked={period === value}
                  onChange={() => setPeriod(value)}
                />
                <span>{t(value)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>{t("mailboxLegend")}</legend>
          <div className="correio-preview-options">
            {LAUNCH_OFFER.mailboxes.map((entry) => (
              <label key={entry.id}>
                <input
                  type="radio"
                  name={`${groupId}-mailbox`}
                  value={entry.id}
                  checked={mailboxId === entry.id}
                  onChange={() => setMailboxId(entry.id)}
                />
                <span>{t("storage", { size: entry.storageGiB })}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="correio-preview-quantity">
          <label htmlFor={quantityId}>{t("quantityLabel")}</label>
          <input
            id={quantityId}
            type="number"
            inputMode="numeric"
            min={1}
            max={50}
            step={1}
            value={quantityInput}
            onChange={(event) => setQuantityInput(event.target.value)}
            aria-invalid={quantity === null}
            aria-describedby={`${quantityHintId}${quantity === null ? ` ${quantityErrorId}` : ""}`}
          />
          <p id={quantityHintId}>{t("quantityHint")}</p>
          {quantity === null ? (
            <p id={quantityErrorId} className="correio-preview-error" role="alert">
              {t("quantityError")}
            </p>
          ) : null}
        </div>
      </div>
      {annual ? <p className="correio-preview-saving">{t("savingBadge")}</p> : null}
      <div className="correio-preview-prices" aria-live="polite" aria-atomic="true">
        <article>
          <h4>{t("sendingLabel")}</h4>
          <p className="correio-note">
            {t("sendingPlan", { count: LAUNCH_OFFER.sending.monthlyRecipientDeliveries })}
          </p>
          <p className="correio-preview-amount">
            {currency(sending.recurringPeriodCents)}{" "}
            <span>{t(annual ? "perYear" : "perMonth")}</span>
          </p>
          {annual ? (
            <>
              <p className="correio-note">{t("paidUpfront")}</p>
              <p className="correio-preview-equivalent">
                {t("equivalent", { amount: currency(sending.annualEquivalentMonthlyCents ?? 0) })}
              </p>
            </>
          ) : (
            <p className="correio-preview-intro">
              {t("firstPayment", { amount: currency(sending.firstPaymentCents) })}
            </p>
          )}
          <p className="correio-preview-renewal">
            {t("renewal", {
              amount: currency(sending.recurringPeriodCents),
              period: t(annual ? "perYear" : "perMonth"),
            })}
          </p>
        </article>
        <article>
          <h4>{t("combinedLabel")}</h4>
          <p className="correio-note">
            {combined
              ? t("combinedPlan", { count: combined.mailboxQuantity })
              : t("mailboxSelection", { size: mailbox.storageGiB })}
          </p>
          {combined ? (
            <>
              <p className="correio-preview-amount">
                {currency(combined.recurringPeriodCents)}{" "}
                <span>{t(annual ? "perYear" : "perMonth")}</span>
              </p>
              {annual ? (
                <>
                  <p className="correio-note">{t("paidUpfront")}</p>
                  <p className="correio-preview-equivalent">
                    {t("equivalent", {
                      amount: currency(combined.annualEquivalentMonthlyCents ?? 0),
                    })}
                  </p>
                </>
              ) : (
                <p className="correio-preview-intro">
                  {t("firstPayment", { amount: currency(combined.firstPaymentCents) })}
                </p>
              )}
              <p className="correio-preview-renewal">
                {t("renewal", {
                  amount: currency(combined.recurringPeriodCents),
                  period: t(annual ? "perYear" : "perMonth"),
                })}
              </p>
              <ul className="correio-preview-breakdown">
                <li>{t("sendingAmount", { amount: currency(combined.sendingPeriodCents) })}</li>
                <li>
                  {t("mailAmount", {
                    count: combined.mailboxQuantity,
                    unit: currency(combined.mailboxUnitPeriodCents),
                    amount: currency(combined.mailboxTotalPeriodCents),
                  })}
                </li>
              </ul>
            </>
          ) : (
            <p className="correio-preview-invalid">{t("invalidQuote")}</p>
          )}
          <p className="correio-note">
            {t("recipients", { count: mailbox.monthlyRecipientDeliveries })}
          </p>
        </article>
      </div>
      <div className="correio-preview-notes">
        <p>{t("monthlyConsumption")}</p>
        {annual ? (
          <>
            <p>{t("annualFormula")}</p>
            <p>{earlyAccessOpen ? release("annualConsumption") : t("annualConsumption")}</p>
          </>
        ) : (
          <p>{t("introTerms")}</p>
        )}
        <p>{t("eligibility")}</p>
        <p>{earlyAccessOpen ? release("monthlyNote") : t("monthlyNote")}</p>
        <p>{t("noChange")}</p>
        {earlyAccessOpen ? (
          <a className="ms-btn ms-btn-secondary correio-action" href="/mail">
            {release("checkAccess")}
          </a>
        ) : null}
      </div>
    </section>
  );
}
