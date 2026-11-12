/** Safe, server-owned preflight reasons. Never derive these from exception messages. */
export const MAILBOX_SEND_HOLD_REASONS = [
  "review_required",
  "campaign_consent_required",
  "campaign_sending_disabled",
  "sending_paused",
  "provider_unavailable",
  "quota_exceeded",
  "rate_limited",
  "domain_not_ready",
  "recipient_check_unavailable",
  "configuration_unavailable",
  "content_review",
  "preflight_unavailable",
] as const;
export type MailboxSendHoldReason = (typeof MAILBOX_SEND_HOLD_REASONS)[number];
export interface MailboxSendHold {
  reason: MailboxSendHoldReason;
  /** The existing runtime rechecks this row; an action can still be required. */
  automaticRetry: boolean;
  actionRequired: "none" | "review" | "verify_domain" | "contact_support";
  queuedSince: Date;
  lastCheckedAt: Date;
  nextRetryAt: Date | null;
}
export function mailboxSendHoldCode(reason: MailboxSendHoldReason): string {
  return `mailbox_deferred:${reason}`;
}
export function mailboxSendHold(row: {
  status: string;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}): MailboxSendHold | null {
  if (row.status !== "queued") return null;
  const reason = MAILBOX_SEND_HOLD_REASONS.find(
    (value) => mailboxSendHoldCode(value) === row.errorCode,
  );
  if (!reason) return null; // Legacy queued rows have no evidence of a specific cause.
  return {
    reason,
    automaticRetry: true,
    actionRequired:
      reason === "domain_not_ready"
        ? "verify_domain"
        : ["review_required", "content_review", "campaign_consent_required"].includes(reason)
          ? "review"
          : ["configuration_unavailable", "campaign_sending_disabled"].includes(reason)
            ? "contact_support"
            : "none",
    queuedSince: row.createdAt,
    lastCheckedAt: row.updatedAt,
    nextRetryAt: null, // Reconcile cadence is not a scheduled per-message retry.
  };
}
