import { mailboxOutboundPresentation } from "./mailbox-inbox-presentation";

type Summary = Parameters<typeof mailboxOutboundPresentation>[0];
/** Recipient evidence takes precedence over outbox state; acceptance is not delivery. */
export function mailboxDeliveryBadge(
  status: string | null | undefined,
  summary: Summary,
): string | null {
  const result = mailboxOutboundPresentation(summary);
  if (result?.hasConfirmed) {
    const [row] = result.rows;
    return result.rows.length === 1 && row ? `results.${row.key}` : "deliveryStatus.partial";
  }
  return status ? `deliveryStatus.${status}` : null;
}

export function mailboxDeliveryLabel(
  t: { (key: string): string; has(key: string): boolean },
  status: string | null | undefined,
  summary: Summary,
): string | null {
  const key = mailboxDeliveryBadge(status, summary);
  if (!key) return null;
  return key === "deliveryStatus.partial" && !t.has(key) ? "Mixed recipient outcomes" : t(key);
}
