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
  /**
   * Server-resolved proof that these exact bytes answer a message RECEIVED in
   * the same mailbox (resolveMailboxReplySource). It is not a client flag: the
   * caller may only pass an id it read back from the sealed draft's own
   * In-Reply-To against an inbox item of that mailbox. Absent or null keeps the
   * full cold-outreach rule in force.
   */
  replySourceItemId?: string | null;
}

export type ColdOutreachVerdict = { blocked: false } | { blocked: true; signal: string };

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

/** A canonical item id is the only shape a binding can have. */
const ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function guardColdOutreach(input: ColdOutreachInput): ColdOutreachVerdict {
  const from = (input.from ?? "").trim().toLowerCase();
  const senderHit = SENDER_SIGNALS.find((re) => re.test(from));
  if (senderHit) return { blocked: true, signal: `sender:${senderHit.source}` };
  const subject = (input.subject ?? "").normalize("NFKD");
  const subjectHit = SUBJECT_SIGNALS.find((s) => s.pattern.test(subject));
  if (subjectHit) return { blocked: true, signal: `subject:${subjectHit.label}` };
  return { blocked: false };
}

/**
 * The same rule with the single exemption the harm model permits, and only when
 * the SERVER proved the conversation.
 *
 * What paused the account was sending a commercial offer to people who never
 * wrote to us. Both lexical signals are proxies for exactly that, and both look
 * only at the envelope: the local part of the sender and the words in the
 * subject. A partnerships mailbox exists to answer people who wrote to it, so
 * every such answer carried `parcerias@` and inherited the received subject
 * ("Re: Partnership question") — held forever, because a cold_outreach hold is a
 * policy stop that approving the content does not release.
 *
 * A message that answers something that really arrived in this mailbox is
 * correspondence, not a blast. The proof is produced at admission by
 * resolveMailboxReplySource, under the draft and mailbox locks: the sealed
 * draft's own In-Reply-To must name an item received in THIS mailbox, and every
 * recipient of the reply must be a participant of that received message. Only
 * then does the outbox row carry the binding, and only that row's value can
 * reach this function.
 *
 * The exemption changes nothing else:
 * - It needs a canonical item id. A caller cannot manufacture one by setting a
 *   field; anything null, empty, non-uuid or from another row reads as no proof.
 * - A new message, a forged or dangling In-Reply-To, a recipient added outside
 *   the conversation, another mailbox and a repeat are refused before here.
 * - Phishing/brand-account, campaign consent, recipient blocks, reputation,
 *   quotas, the semantic judge and every other hold keep working on the message.
 */
export function guardColdOutreachWithReply(input: ColdOutreachInput): ColdOutreachVerdict {
  const verdict = guardColdOutreach(input);
  if (!verdict.blocked) return verdict;
  const binding = typeof input.replySourceItemId === "string" ? input.replySourceItemId : "";
  // A proved conversation keeps the sender and the inherited subject from being
  // read as an unsolicited approach. Everything outside that proof is unchanged.
  if (ITEM_ID.test(binding)) return { blocked: false };
  return verdict;
}
