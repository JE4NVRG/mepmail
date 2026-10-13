"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { BtnSpinner } from "@/components/spinner";
import { WarnCard } from "@/components/warn-card";
import { formatDay } from "@/lib/format";
import { safeMailboxCheckoutUrl } from "@/lib/mailbox-checkout";
import { formatMailboxPrice } from "@/lib/mailbox-setup";
import { useTRPC } from "@/lib/trpc";

// After a Pix the webhook records the payment within seconds; a few refetches show it.
const AFTER_PIX_POLLS = 6;
const AFTER_PIX_POLL_MS = 2500;

/**
 * Open invoices of a plan paid by Pix, month by month: each one is paid by its own Pix
 * (billing.payPixInvoice). Renders nothing when there is none.
 */
export function PixInvoices({ canManage, returned }: { canManage: boolean; returned: boolean }) {
  const t = useTranslations("settings.billing.pix");
  const locale = useLocale();
  const trpc = useTRPC();
  const invoices = useQuery({
    ...trpc.billing.pixInvoices.queryOptions(),
    refetchInterval: (query) =>
      returned && query.state.dataUpdateCount < AFTER_PIX_POLLS ? AFTER_PIX_POLL_MS : false,
  });
  const pay = useMutation(
    trpc.billing.payPixInvoice.mutationOptions({
      onSuccess: ({ url }) => {
        const safe = safeMailboxCheckoutUrl(url);
        if (safe) window.location.assign(safe);
      },
    }),
  );
  const open = invoices.data ?? [];
  if (!open.length) return returned && invoices.isSuccess ? <p role="status">{t("paid")}</p> : null;
  return (
    <>
      {open.map((invoice) => (
        <WarnCard
          key={invoice.id}
          action={
            canManage ? (
              <button
                type="button"
                className="ms-btn ms-btn-primary"
                disabled={pay.isPending}
                onClick={() => pay.mutate({ invoiceId: invoice.id })}
              >
                <BtnSpinner on={pay.isPending && pay.variables?.invoiceId === invoice.id} />
                {t("pay")}
              </button>
            ) : null
          }
        >
          {t(invoice.service === "mailbox" ? "openMailbox" : "open", {
            amount: formatMailboxPrice(invoice.amount, invoice.currency, locale),
            date: invoice.dueDate ? formatDay(invoice.dueDate, locale) : "—",
          })}
          {canManage ? null : ` ${t("askAdmin")}`}
          {pay.isError ? ` ${t("error")}` : null}
        </WarnCard>
      ))}
    </>
  );
}
