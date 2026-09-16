import { decodeEntities, stripHiddenElements } from "./abuse-judge/block.js";
import { isIpLiteral, visibleText } from "./email-insights.js";
import { registrableDomain } from "./org-domain.js";

/**
 * Break-glass content access: the vocabulary, the time box and the one
 * redaction pass an operator's view of a customer's message goes through.
 * Everything here is pure — nothing decrypts, reads or writes.
 */

/** Why an operator may unwrap content. Security only; chosen before anything decrypts. */
export const CONTENT_REVEAL_REASONS = [
  "phishing_or_malware",
  "complaint_spike",
  "provider_report",
  "legal_request",
  "owner_support_request",
] as const;
export type ContentRevealReason = (typeof CONTENT_REVEAL_REASONS)[number];

/** One message, or every flagged message of the review page's window. */
export const CONTENT_REVEAL_SCOPES = ["email", "flagged_window"] as const;
export type ContentRevealScope = (typeof CONTENT_REVEAL_SCOPES)[number];

/** A grant opens for this long and is never extended; a later look needs a new grant. */
export const CONTENT_REVEAL_WINDOW_MS = 30 * 60_000;
/** Shortest justification that says anything; enforced at the procedure and in the dialog. */
export const CONTENT_REVEAL_JUSTIFICATION_MIN = 20;
export const CONTENT_REVEAL_JUSTIFICATION_MAX = 2_000;
/** Longer bodies are cut: the operator is triaging a lure, not reading a newsletter. */
export const CONTENT_REVEAL_TEXT_MAX_CHARS = 20_000;
/** Days after which the access appears in the team's own audit and its owners are told. */
export const CONTENT_REVEAL_NOTICE_DAYS = 7;

/** What the audit rows say was read, on both sides. */
export const CONTENT_REVEAL_FIELDS = "subject, rendered text";

export function contentRevealExpiry(createdAt: Date): Date {
  return new Date(createdAt.getTime() + CONTENT_REVEAL_WINDOW_MS);
}

/** A run of the revealed body; `redacted` runs were replaced or shortened by the server. */
export interface RevealSpan {
  text: string;
  redacted?: true;
}

export interface RevealedContent {
  spans: RevealSpan[];
  redactions: number;
}

/** What a masked run is replaced with. The original never leaves the server. */
const MASK = "••••••";

/** Enough of a link to judge where it points, never enough to follow a one-time one. */
const URL_PATH_STUB_MAX = 24;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
/** Trailing sentence punctuation is not part of the link. */
const URL_TAIL = /[.,;:!?]+$/;

const SECRETS: RegExp[] = [
  // JWT: three base64url segments.
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  /\b[0-9a-fA-F]{32,}\b/g,
  /\b[A-Za-z0-9+/]{40,}={0,2}/g,
];

/** Words a one-time code follows, in both of the dashboard's languages. */
const CODE_WORD = /\b(?:c[óo]digos?|codes?|otp|pins?|tokens?|senhas?|passwords?|verification)\b/gi;
/** How far past such a word a bare number is read as that code. */
const CODE_WINDOW = 40;
const CODE_DIGITS = /(?<!\d)\d{4,8}(?!\d)/g;

interface Hit {
  start: number;
  end: number;
  text: string;
}

function reduceUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return MASK;
  }
  const stub = `${url.pathname}${url.search}${url.hash}`.replace(/^\/$/, "");
  const cut = stub.length > URL_PATH_STUB_MAX ? `${stub.slice(0, URL_PATH_STUB_MAX)}…` : stub;
  // A bare address keeps its host: reducing 10.0.0.7 to a "domain" would
  // name a host that does not exist, and the literal is itself the signal.
  const host = isIpLiteral(url.hostname) ? url.hostname : registrableDomain(url.hostname);
  return `${url.protocol}//${host}${cut}`;
}

function urlHits(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0].replace(URL_TAIL, "");
    if (raw.length === 0) continue;
    hits.push({ start: m.index, end: m.index + raw.length, text: reduceUrl(raw) });
  }
  return hits;
}

function secretHits(text: string): Hit[] {
  return SECRETS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
      text: MASK,
    })),
  );
}

function codeHits(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const word of text.matchAll(CODE_WORD)) {
    const from = word.index + word[0].length;
    const window = text.slice(from, from + CODE_WINDOW);
    for (const digits of window.matchAll(CODE_DIGITS)) {
      hits.push({
        start: from + digits.index,
        end: from + digits.index + digits[0].length,
        text: MASK,
      });
    }
  }
  return hits;
}

/**
 * Reduce every link to where it points and mask what reads as a credential.
 * Earlier hits win an overlap, and the passes are ordered so a token inside a
 * link is cut by the link's own path stub rather than masked twice.
 */
export function redactRevealedText(text: string): RevealedContent {
  const hits = [...urlHits(text), ...secretHits(text), ...codeHits(text)].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  );
  const spans: RevealSpan[] = [];
  let cursor = 0;
  let redactions = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    if (hit.start > cursor) spans.push({ text: text.slice(cursor, hit.start) });
    spans.push({ text: hit.text, redacted: true });
    redactions += 1;
    cursor = hit.end;
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor) });
  return { spans, redactions };
}

/** Cut the spans to a character budget, keeping whole spans where they fit. */
function truncate(content: RevealedContent, max: number): RevealedContent {
  let left = max;
  const spans: RevealSpan[] = [];
  for (const span of content.spans) {
    if (left <= 0) break;
    if (span.text.length <= left) {
      spans.push(span);
      left -= span.text.length;
      continue;
    }
    // A redacted run is all or nothing: half a mask says less than none.
    if (!span.redacted) spans.push({ text: `${span.text.slice(0, left)}…` });
    left = 0;
  }
  return { spans, redactions: spans.filter((s) => s.redacted).length };
}

/**
 * The only shape of a customer's message an operator ever sees: the rendered
 * visible text of the HTML (hidden elements stripped first, as the content
 * monitor does), or the plain-text part when there is no HTML — redacted and
 * cut. Never the HTML itself, the recipients, the headers or the attachments.
 */
export function renderRevealedBody(body: {
  html: string | null;
  text: string | null;
}): RevealedContent {
  const source =
    body.html === null
      ? (body.text ?? "").trim()
      : decodeEntities(visibleText(stripHiddenElements(body.html).html));
  return truncate(redactRevealedText(source), CONTENT_REVEAL_TEXT_MAX_CHARS);
}
