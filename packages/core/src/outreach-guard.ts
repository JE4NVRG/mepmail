/**
 * Cold outreach never leaves through SES.
 *
 * The account was reinstated once, explicitly as a one-time decision. A
 * sponsorship or prospecting blast to a list without consent is the exact
 * trigger that paused us, so it is blocked deterministically here instead of
 * relying on a volume threshold or an operator remembering the rule.
 *
 * Fail-closed: a hit holds the message for review; it is never silently sent.
 */
export interface ColdOutreachInput {
  from: string;
  subject: string;
  text?: string | null;
}

export type ColdOutreachVerdict =
  | { blocked: false }
  | { blocked: true; signal: string };

/** Local parts reserved for prospecting. A reply from one still holds. */
const SENDER_SIGNALS: readonly RegExp[] = [
  /^parcerias@/i,
  /^partnerships?@/i,
  /^sponsorships?@/i,
  /^sponsor@/i,
  /^patrocinio@/i,
  /^parceria@/i,
  /^ads@/i,
  /^influencer@/i,
  /^prospeccao@/i,
  /^outreach@/i,
];

/** A subject that offers a commercial relationship, not a transactional one. */
const SUBJECT_SIGNALS: readonly { label: string; pattern: RegExp }[] = [
  { label: "sponsorship", pattern: /\bsponsor(ship|ed|ing)?\b/i },
  { label: "patrocinio", pattern: /\bpatroc[ií]nio\b/i },
  { label: "partnership", pattern: /\bpartnership\b/i },
  { label: "parceria", pattern: /\bparceria\b/i },
  { label: "collab", pattern: /\bcollab(orat\w*|oration)?\b/i },
  { label: "guest_post", pattern: /\bguest post\b/i },
  { label: "link_insertion", pattern: /\blink insertion\b/i },
  { label: "backlink", pattern: /\bbacklink\b/i },
  { label: "paid_placement", pattern: /\bpaid (post|placement)\b/i },
  { label: "media_kit", pattern: /\bmedia kit\b/i },
  { label: "proposta_comercial", pattern: /\bproposta (comercial|de parceria)\b/i },
];

export function guardColdOutreach(input: ColdOutreachInput): ColdOutreachVerdict {
  const from = (input.from ?? "").trim().toLowerCase();
  const senderHit = SENDER_SIGNALS.find((re) => re.test(from));
  if (senderHit) return { blocked: true, signal: `sender:${senderHit.source}` };
  const subject = (input.subject ?? "").normalize("NFKD");
  const subjectHit = SUBJECT_SIGNALS.find((s) => s.pattern.test(subject));
  if (subjectHit) return { blocked: true, signal: `subject:${subjectHit.label}` };
  return { blocked: false };
}
