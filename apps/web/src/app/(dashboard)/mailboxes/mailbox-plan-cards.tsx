"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId } from "react";
import {
  formatMailboxBytes,
  MAILBOX_PLAN_NAMES,
  type MailboxPlanAllowance,
  type MailboxPlanCode,
} from "@/lib/mailbox-plans";
import { formatMailboxPrice } from "@/lib/mailbox-setup";
import styles from "./mailbox-plan-cards.module.css";

export type MailboxPlanCardOffer = {
  offerId: string;
  currency: string;
  unitAmount: number;
  interval: "month" | "year";
  storageBytesPerMailbox: number;
  includedOutboundPerMailbox: number;
  includedMailboxes?: number | undefined;
  localCurrency?: { currency: string; unitAmount: number } | null | undefined;
  plan: MailboxPlanAllowance & { code: MailboxPlanCode };
  current?: boolean | undefined;
};

/**
 * Solo, Duo and Equipe side by side, as one radio group: mailboxes, storage,
 * outbound recipients and received messages per month, then the price in
 * the offer's currency and in the local one. Used to buy a plan and to
 * change plan; the action for the chosen card lives with the caller.
 */
export function MailboxPlanCards({
  offers,
  selectedId,
  onSelect,
  label,
  disabled = false,
}: {
  offers: readonly MailboxPlanCardOffer[];
  selectedId: string | null;
  onSelect: (offerId: string) => void;
  label: string;
  disabled?: boolean;
}) {
  const t = useTranslations("mailboxes-service.plans");
  const common = useTranslations("mailboxes-service");
  const locale = useLocale();
  const name = useId();
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const price = (amount: number, currency: string, interval: "month" | "year") =>
    common("priceInterval", {
      amount: formatMailboxPrice(amount, currency, locale),
      interval: common(`interval.${interval}`),
    });
  return (
    <div className={styles.cards} role="radiogroup" aria-label={label}>
      {offers.map((offer) => {
        const checked = offer.offerId === selectedId;
        return (
          <label
            key={offer.offerId}
            className={styles.card}
            data-checked={checked || undefined}
            data-current={offer.current || undefined}
          >
            <input
              type="radio"
              name={name}
              className={styles.radio}
              checked={checked}
              disabled={disabled}
              onChange={() => onSelect(offer.offerId)}
            />
            <span className={styles.head}>
              <strong>{MAILBOX_PLAN_NAMES[offer.plan.code]}</strong>
              {offer.current ? <span className={styles.current}>{t("current")}</span> : null}
            </span>
            <span className={styles.price}>
              {price(offer.unitAmount, offer.currency, offer.interval)}
            </span>
            {offer.localCurrency ? (
              <span className={styles.local}>
                {t("localPrice", {
                  amount: price(
                    offer.localCurrency.unitAmount,
                    offer.localCurrency.currency,
                    offer.interval,
                  ),
                })}
              </span>
            ) : null}
            <ul className={styles.facts}>
              <li>{t("mailboxes", { count: offer.includedMailboxes ?? 1 })}</li>
              <li>
                {t("storage", { size: formatMailboxBytes(offer.storageBytesPerMailbox, locale) })}
              </li>
              <li>{t("outbound", { count: number(offer.includedOutboundPerMailbox) })}</li>
              <li>{t("inbound", { count: number(offer.plan.inboundDeliveriesPerPeriod) })}</li>
              <li className={styles.traffic}>
                {t("traffic", {
                  sent: formatMailboxBytes(offer.plan.outboundBytesPerPeriod, locale),
                  received: formatMailboxBytes(offer.plan.inboundBytesPerPeriod, locale),
                })}
              </li>
            </ul>
          </label>
        );
      })}
    </div>
  );
}
