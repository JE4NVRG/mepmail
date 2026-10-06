export type MailboxFolder =
  | "inbox"
  | "drafts"
  | "sent"
  | "spam"
  | "quarantine"
  | "trash"
  | "favorites"
  | "custom";
export type MailboxKindFilter = "all" | "person" | "agent";

type Safety = {
  kind: "inbox" | "draft" | "sent";
  deliveryFolder: "inbox" | "spam" | "quarantine";
  blocked?: boolean;
  trashedAt?: Date | null;
  inboundAssessment: {
    decision: "inbox" | "spam" | "quarantine";
    verdicts: { virus: string };
  } | null;
};

/** A quarantined row remains a placeholder even if stale metadata contains content. */
export function mailboxContentBlocked(
  item: Pick<Safety, "deliveryFolder" | "blocked" | "inboundAssessment">,
) {
  return (
    item.blocked === true ||
    item.deliveryFolder === "quarantine" ||
    item.inboundAssessment?.decision === "quarantine"
  );
}

export function mailboxMessageActions(item: Safety, canDraft: boolean, isOwner: boolean) {
  const blocked = mailboxContentBlocked(item);
  const trashed = item.trashedAt != null;
  const movable =
    !trashed &&
    !blocked &&
    item.kind === "inbox" &&
    isOwner &&
    (item.inboundAssessment === null || item.inboundAssessment.verdicts.virus === "PASS");
  return {
    canRespond: !trashed && !blocked && item.deliveryFolder !== "spam" && canDraft,
    canMoveToInbox: movable && item.deliveryFolder === "spam",
    canMoveToSpam: movable && item.deliveryFolder === "inbox",
    // These owner-only metadata moves preserve the existing safety classification.
    canMoveToTrash: isOwner && !trashed,
    canRestore: isOwner && trashed,
  };
}

export function mailboxPrimaryParticipant(
  item: Pick<Safety, "kind" | "deliveryFolder" | "blocked" | "inboundAssessment"> & {
    from?: string | undefined;
    fromName?: string | undefined;
    to?: string[] | undefined;
  },
) {
  if (mailboxContentBlocked(item)) return null;
  return item.kind === "sent" || item.kind === "draft"
    ? item.to?.join(", ") || null
    : item.fromName || item.from || null;
}

/** This identifies approval of the send, never authorship of its text. */
export function mailboxSendApproval(
  sentBy: { kind: "human" | "agent"; label: string | null } | null,
) {
  if (!sentBy) return null;
  if (sentBy.kind === "human") return { key: "approval.human" as const };
  const label = sentBy.label?.trim();
  return label
    ? { key: "approval.agent" as const, label }
    : { key: "approval.agentUnnamed" as const };
}

const OUTBOUND_RESULTS = [
  "delivered",
  "delayed",
  "hardBounce",
  "complaint",
  "softBounce",
  "rejected",
  "renderingFailed",
  "unconfirmed",
] as const;

type OutboundResult = (typeof OUTBOUND_RESULTS)[number];
type OutboundSummary = Record<OutboundResult, number> & { totalRecipients: number };

/** Mutually exclusive recipient states, not event totals or proof of reading. */
export function mailboxOutboundPresentation(summary: OutboundSummary | null | undefined) {
  if (
    !summary ||
    !Number.isSafeInteger(summary.totalRecipients) ||
    summary.totalRecipients < 1 ||
    OUTBOUND_RESULTS.some((key) => !Number.isSafeInteger(summary[key]) || summary[key] < 0) ||
    OUTBOUND_RESULTS.reduce((total, key) => total + summary[key], 0) !== summary.totalRecipients
  )
    return null;
  return {
    total: summary.totalRecipients,
    hasConfirmed: summary.unconfirmed < summary.totalRecipients,
    partial: summary.unconfirmed > 0 && summary.unconfirmed < summary.totalRecipients,
    rows: OUTBOUND_RESULTS.filter((key) => summary[key] > 0).map((key) => ({
      key,
      count: summary[key],
    })),
  };
}
