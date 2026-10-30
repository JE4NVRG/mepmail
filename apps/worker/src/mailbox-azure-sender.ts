import {
  checkMailboxRecipientBlocks,
  checkSignupSend,
  fetchTeamStanding,
  type MailboxOutboxSender,
  MailboxSendDeferredError,
  MailboxSendRejectedError,
  type SendingProviderPolicy,
  stripMailboxPrivateHeaders,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { reserveMailboxAzureBudget } from "../../../packages/core/src/mailbox-azure-budget.js";
import { assertMailboxOutboxSendAccess } from "../../../packages/core/src/mailbox-transport.js";
import type { SesSender } from "./handlers/send-email.js";
import { mailboxAzureCompliance } from "./mailbox-optout.js";
import { createMailboxContentPolicySender, withMailboxProbation } from "./mailbox-sender.js";

/** Native Correio only; caller must be sendMailboxOutbox, never a direct API route.
 * Uses the configured ACS relay adapter, not AWS pause/failover selection. No tracking,
 * rebuilding MIME, new credentials, retries or provider fallback. Raw RFC reply/thread
 * headers and attachments survive unchanged; only Bcc/private headers leave the wire.
 */
export function createMailboxAzureSender(
  db: Db,
  options: {
    policy: SendingProviderPolicy;
    relay: { name: string; sender: SesSender };
    isCloud: boolean;
  },
): MailboxOutboxSender {
  const unavailable: MailboxOutboxSender = {
    async send() {
      throw new MailboxSendDeferredError();
    },
  };
  const attempt: MailboxOutboxSender = {
    async send(input) {
      if (options.relay.name !== "azure") throw new MailboxSendDeferredError();
      const recipients = [
        ...new Set([...input.to, ...input.cc, ...input.bcc].map((r) => r.toLowerCase())),
      ];
      const authorize = async () => {
        await mailboxAzureCompliance(db, input);
        if (
          !(await checkSignupSend(db, input.teamId, recipients)).allowed ||
          !(await checkMailboxRecipientBlocks(db, { teamId: input.teamId, recipients }))
        )
          throw new MailboxSendDeferredError();
        const standing = await fetchTeamStanding(db, input.teamId);
        if (!standing || standing.suspended || standing.sendReview)
          throw new MailboxSendDeferredError();
        // Re-read domain/relay, grants, seat, license and credential expiry after
        // slow checks. No caller-declared actor or stale queue approval grants access.
        await assertMailboxOutboxSendAccess(db, input);
      };
      try {
        await authorize();
      } catch {
        throw new MailboxSendDeferredError();
      }
      const reserved = await reserveMailboxAzureBudget(db, {
        ...input,
        recipients: recipients.length,
      });
      if (reserved === "quota") throw new MailboxSendDeferredError();
      // A replay/stale attempt cannot reset to queued: only evidence can resolve it.
      if (reserved !== "reserved") throw new Error("mailbox_azure_attempt_fenced");
      try {
        await authorize();
      } catch {
        // The lifetime receipt is already durable. Preserve it and the probation
        // charge; never return to a retryable queue or refund after this fence.
        throw new Error("mailbox_azure_authorization_changed_after_claim");
      }
      let result: { messageId: string };
      try {
        result = await options.relay.sender.sendRaw({
          raw: stripMailboxPrivateHeaders(Buffer.from(input.raw)),
          emailId: input.outboxId,
          envelopeFrom: input.from,
          to: [...input.to],
          cc: [...input.cc],
          bcc: [...input.bcc],
        });
      } catch (error) {
        // Only an SMTP 5xx response at a known command proves a permanent refusal.
        // Do not turn disconnects, 4xx, provider 5xx without command, or lost DATA ACK
        // into a retry. The durable outbox + lifetime budget fence retain ambiguity.
        const e = error as { responseCode?: unknown; command?: unknown };
        if (
          typeof e.responseCode === "number" &&
          e.responseCode >= 500 &&
          e.responseCode < 600 &&
          typeof e.command === "string" &&
          /^(?:AUTH(?: .*)?|MAIL FROM|RCPT TO|DATA)$/.test(e.command)
        )
          throw new MailboxSendRejectedError();
        throw new Error("mailbox_azure_provider_unknown");
      }
      if (
        !/^smtp-relay:azure:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          result.messageId,
        )
      )
        throw new Error("mailbox_azure_provider_unknown");
      return result;
    },
  };
  // Repeat the SAME effective tenant/content/marketing/domain/outbox policy right
  // before quota + SMTP, including when this adapter is accidentally invoked alone.
  // Only the final adapter reserves probation. Routers may clone the input, so
  // relying on an outer WeakSet identity across those clones would double charge.
  return createMailboxContentPolicySender(db, unavailable, options.isCloud, options.policy, {
    async send(input) {
      await mailboxAzureCompliance(db, input);
      return withMailboxProbation(db, attempt, options.isCloud).send(input);
    },
  });
}
