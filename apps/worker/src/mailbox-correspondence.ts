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

/** Native correspondence may use bounded To/Cc/Bcc, not caller marketing labels.
 * Retain every shared content/list/broadcast signal; only the public recipient
 * count heuristic differs. Invalid/mass recipient counts never become personal.
 */
export function mailboxCorrespondenceCampaign(input: CampaignMessage): boolean {
  if (!boundedCorrespondence(input)) return true;
  const { to: _to, cc: _cc, bcc: _bcc, ...signals } = input;
  return campaignMessage(signals);
}
