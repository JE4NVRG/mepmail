import { MailboxSendRejectedError } from "@millionsend/core";
import {
  type CampaignMessage,
  campaignMessage,
} from "../../../packages/core/src/campaign-consent.js";

// Matches the existing private composer/transport ceiling in mailbox-transport.ts.
// Public Send/API keeps its stricter multi-recipient campaign classification.
export const MAILBOX_CORRESPONDENCE_MAX_RECIPIENTS = 20;

type Recipients = Pick<CampaignMessage, "to" | "cc" | "bcc">;
function boundedCorrespondence(input: Recipients): boolean {
  const count = (input.to?.length ?? 0) + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0);
  return (input.to?.length ?? 0) > 0 && count <= MAILBOX_CORRESPONDENCE_MAX_RECIPIENTS;
}

/** Adapter defense in depth, even when cloud/provider policy is disabled. */
export function assertMailboxCorrespondenceRecipients(input: Recipients): void {
  if (!boundedCorrespondence(input)) throw new MailboxSendRejectedError();
}

// A newsletter can be the subject of a business conversation, not its payload.
// Require a bounded sponsorship/partnership inquiry around EACH body mention;
// a sponsorship preface must not exempt a separate newsletter distribution.
const NEWSLETTER = /\bnewsletter\b/gi;
const BUSINESS_DISCUSSION =
  /\b(sponsor(?:ship|ing|ed|s)?|partnership|patroc[ií]nio|patrocinar|parceria|anunciar)\b/i;
const CONVERSATION =
  /\?|\b(discuss|interested|inquiry|enquiry|could we|would like|can we|conversar|gostaria|podemos|interesse|pergunta)\b/i;
const DISTRIBUTION_OR_CTA =
  /\b(welcome to (?:our|my|the)|in this (?:issue|edition)|this week['’]s (?:newsletter|stories)|latest (?:news|stories)|view (?:this email )?in (?:your )?browser|buy now|shop now|subscribe|sign up|bem[- ]vind[oa]s? [aà]|nesta edi[çc][aã]o|[uú]ltimas not[ií]cias|compre agora|assine|inscreva-se)\b/i;
// A distribution heading/imperative starts a sentence or line. Ordinary noun
// phrases ("sponsorship of the newsletter.") and first-person reading requests
// are not distribution authority merely because they contain the same words.
const DISTRIBUTION_HEADING =
  /(?:^|[.!?]\s+)(?:our|my|nossa?|minha?) (?:weekly |daily |monthly )?newsletter(?=\s*[:.!])/im;
const DISTRIBUTION_READ_CTA = /(?:^|[.!?]\s+)(?:read (?:more|online)|leia mais)\b/im;

function readableContent(value: string): string {
  return value
    .replace(/<(?:br\b[^>]*|\/p\s*|\/div\s*)>/gi, "\n\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ");
}

function newsletterDiscussion(value: string): boolean {
  // Paragraph boundaries and a local window prevent a distant business preface
  // from changing the meaning of an unrelated occurrence. Ambiguity stays strict.
  const paragraphs = readableContent(value).split(/\n\s*\n/);
  let mentions = 0;
  for (const paragraph of paragraphs) {
    for (const match of paragraph.matchAll(NEWSLETTER)) {
      mentions++;
      const context = paragraph.slice(Math.max(0, match.index - 320), match.index + 640);
      if (!BUSINESS_DISCUSSION.test(context) || !CONVERSATION.test(context)) return false;
    }
  }
  return mentions > 0;
}

/** Native keeps public content/list/broadcast gates and bounded recipients.
 * Only contextually proven newsletter business inquiries differ from public
 * Send's lexical heuristic. Negative caller declarations never grant authority.
 */
export function mailboxCorrespondenceCampaign(input: CampaignMessage): boolean {
  if (!boundedCorrespondence(input)) return true;
  const { to: _to, cc: _cc, bcc: _bcc, ...signals } = input;
  if (!campaignMessage(signals)) return false;

  const bodies = [input.text, input.html].filter((value): value is string => Boolean(value));
  const content = [input.subject ?? "", ...bodies].map(readableContent).join("\n\n");
  if (
    DISTRIBUTION_OR_CTA.test(content) ||
    DISTRIBUTION_HEADING.test(content) ||
    DISTRIBUTION_READ_CTA.test(content)
  )
    return true;
  if (!bodies.some(newsletterDiscussion)) return true;
  // Every representation/paragraph carrying the ambiguous word must qualify.
  if (bodies.some((value) => /\bnewsletter\b/i.test(value) && !newsletterDiscussion(value)))
    return true;

  // Mask only the ambiguous word AFTER proving conversational context. Reuse
  // the shared classifier for all other signals, including true declarations,
  // List-* headers, unsubscribe and promotional content in either MIME part.
  return campaignMessage({
    ...signals,
    subject: input.subject?.replace(NEWSLETTER, "publication"),
    text: input.text?.replace(NEWSLETTER, "publication"),
    html: input.html?.replace(NEWSLETTER, "publication"),
  });
}
