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

// Preheader padding and other characters that take no space on screen. The
// combining grapheme joiner (U+034F) stays outside the class: in one, it would
// read as combining with its neighbour.
const INVISIBLE =
  /\u034f|[\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\u3164\ufeff\uffa0]/g;

/**
 * The list preview of a message body. HTML-only mail reaches us converted to
 * text, with every link and image target written out as "[https://…]"; those
 * targets, bare URLs and invisible preheader padding are dropped and runs of
 * whitespace collapse, so the preview shows the words a reader would see.
 */
export function mailboxPreview(text: string, max = 160): string {
  const clean = text
    .replace(INVISIBLE, "")
    .replace(/\[\s*(?:https?:\/\/|mailto:|cid:)[^\]]*\]/gi, " ")
    .replace(/<\s*(?:https?:\/\/|mailto:)[^>]*>/gi, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(clean);
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : clean;
}

const DAY_MS = 86_400_000;

/**
 * The date a message list shows, the way mail apps do: the time for today,
 * "yesterday", the weekday within the last week, day and month this year,
 * and a short full date before that. Both dates are read in local time.
 */
export function mailboxListDate(value: Date, now: Date, locale: string): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(value)) / DAY_MS);
  if (days === 0)
    return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(value);
  if (days === 1) {
    const word = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day");
    return word.charAt(0).toLocaleUpperCase(locale) + word.slice(1);
  }
  if (days > 1 && days < 7)
    return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(value);
  if (value.getFullYear() === now.getFullYear())
    return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(value);
  return new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(value);
}
