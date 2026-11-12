import { createElement } from "react";

/** Public, sanitized reasons only. Never display provider errors or internal policy. */
export type MailboxSendHoldReason =
  | "review_required"
  | "campaign_consent_required"
  | "campaign_sending_disabled"
  | "sending_paused"
  | "provider_unavailable"
  | "quota_exceeded"
  | "rate_limited"
  | "domain_not_ready"
  | "recipient_check_unavailable"
  | "configuration_unavailable"
  | "content_review"
  | "preflight_unavailable";

export type MailboxSendHold = {
  reason: MailboxSendHoldReason;
  automaticRetry: boolean;
  actionRequired: "none" | "review" | "verify_domain" | "contact_support";
  queuedSince: Date;
  lastCheckedAt: Date;
  nextRetryAt: Date | null;
};

type HoldSource = {
  sendStatus?: string | null | undefined;
  // Optional for older responses and fixtures; absent never implies a reason.
  sendHold?: MailboxSendHold | null | undefined;
};

type Translate = (key: string) => string;
const REASONS: Record<MailboxSendHoldReason, string> = {
  review_required: "sendHold.reasons.review_required",
  campaign_consent_required: "sendHold.reasons.campaign_consent_required",
  campaign_sending_disabled: "sendHold.reasons.campaign_sending_disabled",
  sending_paused: "sendHold.reasons.sending_paused",
  provider_unavailable: "sendHold.reasons.provider_unavailable",
  quota_exceeded: "sendHold.reasons.quota_exceeded",
  rate_limited: "sendHold.reasons.rate_limited",
  domain_not_ready: "sendHold.reasons.domain_not_ready",
  recipient_check_unavailable: "sendHold.reasons.recipient_check_unavailable",
  configuration_unavailable: "sendHold.reasons.configuration_unavailable",
  content_review: "sendHold.reasons.content_review",
  preflight_unavailable: "sendHold.reasons.preflight_unavailable",
};
const ACTIONS: Record<MailboxSendHold["actionRequired"], string> = {
  none: "sendHold.actions.none",
  review: "sendHold.actions.review",
  verify_domain: "sendHold.actions.verify_domain",
  contact_support: "sendHold.actions.contact_support",
};

/** A stale hold cannot replace accepted, failed, unknown or undo-send states. */
export function mailboxSendHoldPresentation(t: Translate, source: HoldSource) {
  const hold = source.sendHold;
  if (
    source.sendStatus !== "queued" ||
    !hold ||
    !Object.hasOwn(REASONS, hold.reason) ||
    !Object.hasOwn(ACTIONS, hold.actionRequired) ||
    typeof hold.automaticRetry !== "boolean"
  )
    return null;
  const badge = `${t("sendHold.label")}: ${t(REASONS[hold.reason])}`;
  // A recheck is not a scheduled delivery. Do not derive an ETA from timestamps.
  const detail = [
    badge,
    t(hold.automaticRetry ? "sendHold.automaticRetry" : "sendHold.noAutomaticRetry"),
    t(ACTIONS[hold.actionRequired]),
    t("sendHold.noResend"),
  ].join(" ");
  return { badge, detail };
}

/** Shared list/header badge and reading-pane notice, without send actions. */
export function MailboxSendHoldNotice({
  t,
  source,
  variant = "detail",
  className,
}: {
  t: Translate;
  source: HoldSource;
  variant?: "badge" | "detail";
  className?: string | undefined;
}) {
  const held = mailboxSendHoldPresentation(t, source);
  return held
    ? createElement(
        "span",
        {
          role: "status",
          className,
          ...(variant === "badge" ? { title: held.detail, "aria-label": held.detail } : {}),
        },
        variant === "badge" ? held.badge : held.detail,
      )
    : null;
}
