import { mailboxPreview } from "./mailbox-inbox-presentation";

/**
 * The list summary sealed next to each message (core storeMailboxListSummaries):
 * what one list row shows, projected once from the message. Short keys keep
 * it a few hundred bytes; `v` lets a future shape be told apart, and anything
 * that does not decode is rebuilt from the message.
 */
export type MailboxListSummary = {
  subject: string;
  from: string;
  fromName: string;
  to: string[];
  /** Already a preview: cleaned and short, not the message text. */
  text: string;
  date: Date | null;
  attachmentCount: number;
};

const VERSION = 1;
const LIMITS = { subject: 500, from: 320, fromName: 200, to: 10, address: 320, preview: 400 };
/** Matches core MAILBOX_LIST_SUMMARY_MAX_BYTES. */
export const MAILBOX_LIST_SUMMARY_BYTES = 8 * 1024;

const cut = (value: string, max: number) => Array.from(value).slice(0, max).join("");

export function encodeMailboxListSummary(summary: MailboxListSummary): Buffer | null {
  const encoded = Buffer.from(
    JSON.stringify({
      v: VERSION,
      s: cut(summary.subject, LIMITS.subject),
      f: cut(summary.from, LIMITS.from),
      n: cut(summary.fromName, LIMITS.fromName),
      t: summary.to.slice(0, LIMITS.to).map((address) => cut(address, LIMITS.address)),
      p: mailboxPreview(summary.text, LIMITS.preview),
      d: summary.date && !Number.isNaN(summary.date.getTime()) ? summary.date.toISOString() : null,
      a: Math.max(0, Math.trunc(summary.attachmentCount)),
    }),
    "utf8",
  );
  return encoded.length <= MAILBOX_LIST_SUMMARY_BYTES ? encoded : null;
}

export function decodeMailboxListSummary(raw: Buffer): MailboxListSummary | null {
  try {
    const value = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    if (
      value.v !== VERSION ||
      typeof value.s !== "string" ||
      typeof value.f !== "string" ||
      typeof value.n !== "string" ||
      !Array.isArray(value.t) ||
      !value.t.every((address) => typeof address === "string") ||
      typeof value.p !== "string" ||
      !(value.d === null || typeof value.d === "string") ||
      typeof value.a !== "number"
    )
      return null;
    const date = typeof value.d === "string" ? new Date(value.d) : null;
    return {
      subject: value.s,
      from: value.f,
      fromName: value.n,
      to: value.t as string[],
      text: value.p,
      date: date && !Number.isNaN(date.getTime()) ? date : null,
      attachmentCount: value.a,
    };
  } catch {
    return null;
  }
}
