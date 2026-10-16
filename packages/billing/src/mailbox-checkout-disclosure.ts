import type { MailboxPriceTerms } from "./mailbox.js";

type Payment = { kind: "card"; trialDays: number } | { kind: "pix" };

// Presentation only; a contract test compares these with core/mailbox-service.
// Importing that server module here would eagerly load DB/config validation.
const TRIAL_RECIPIENT_DISCLOSURE = { daily: 50, total: 200 } as const;

/** Binary units, without rounding an allowance up or multiplying shared quotas. */
function bytes(value: number): string {
  for (const [unit, size] of [
    ["GiB", 1024 ** 3],
    ["MiB", 1024 ** 2],
    ["KiB", 1024],
  ] as const) {
    if (value >= size && value % (size / 2) === 0) return `${value / size} ${unit}`;
  }
  return `${value} B`;
}

/**
 * Server-resolved terms, next to Stripe's payment confirmation button. Both
 * languages are included because Checkout can choose its own display locale.
 * trialDays is the applied purchase decision, never the catalog's advertised trial.
 */
export function mailboxCheckoutDisclosure(
  terms: MailboxPriceTerms,
  seats: number,
  payment: Payment,
): string {
  const shared = terms.quotaScope === "team";
  const storage = bytes(terms.storageBytesPerMailbox);
  const pt = [
    `Correio: ${seats} caixa(s). Armazenamento: ${storage} ${shared ? "compartilhados pela equipe, não por caixa" : "por caixa"}.`,
  ];
  const en = [
    `Mail: ${seats} mailbox(es). Storage: ${storage} ${shared ? "shared by the team, not per mailbox" : "per mailbox"}.`,
  ];
  let ptAllowances = `saída ${terms.includedOutboundPerMailbox} destinatários`;
  let enAllowances = `outbound ${terms.includedOutboundPerMailbox} recipients`;
  if (terms.planCode) {
    const { outboundBytesPerPeriod, inboundBytesPerPeriod, inboundDeliveriesPerPeriod } = terms;
    if (
      outboundBytesPerPeriod === undefined ||
      inboundBytesPerPeriod === undefined ||
      inboundDeliveriesPerPeriod === undefined
    )
      throw new RangeError("mailbox_checkout_disclosure_missing_allowances");
    ptAllowances += ` / ${bytes(outboundBytesPerPeriod)}; entrada ${inboundDeliveriesPerPeriod} mensagens / ${bytes(inboundBytesPerPeriod)}`;
    enAllowances += ` / ${bytes(outboundBytesPerPeriod)}; inbound ${inboundDeliveriesPerPeriod} messages / ${bytes(inboundBytesPerPeriod)}`;
  }
  pt.push(
    `Franquias ${terms.planCode ? "mensais" : "por período de uso"} ${shared ? "da equipe" : "por caixa"}: ${ptAllowances}.`,
  );
  en.push(
    `${terms.planCode ? "Monthly allowances" : "Allowances per usage period"} ${shared ? "for the team" : "per mailbox"}: ${enAllowances}.`,
  );
  if (terms.planCode) {
    pt.push("Mensagens que excedam o armazenamento ou a franquia de entrada podem ser recusadas.");
    en.push("Incoming messages exceeding storage or inbound allowances may be rejected.");
  }
  if (payment.kind === "pix") {
    pt.push("Pix: sem teste grátis; primeiro mês pago agora, sem cobrança automática mensal.");
    en.push("Pix: no free trial; first month paid now, no automatic monthly charge.");
  } else if (payment.trialDays > 0) {
    pt.push(
      `Cartão: teste elegível de ${payment.trialDays} dias; cobrança ao final, salvo cancelamento antes. No teste: ${TRIAL_RECIPIENT_DISCLOSURE.daily} destinatários/dia UTC, ${TRIAL_RECIPIENT_DISCLOSURE.total} no total.`,
    );
    en.push(
      `Card: eligible ${payment.trialDays}-day trial; charged after unless canceled first. During trial: ${TRIAL_RECIPIENT_DISCLOSURE.daily} recipients/UTC day, ${TRIAL_RECIPIENT_DISCLOSURE.total} total.`,
    );
  } else {
    pt.push("Cartão: sem teste grátis nesta compra.");
    en.push("Card: no free trial on this purchase.");
  }
  const message = `${pt.join(" ")}\n\n${en.join(" ")}`;
  // Stripe's submit message limit. Never silently truncate a material condition.
  if (message.length > 1200) throw new RangeError("mailbox_checkout_disclosure_too_long");
  return message;
}
