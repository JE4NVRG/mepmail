import { dueMailboxDeletions, purgeMailboxDeletion } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { sql } from "drizzle-orm";
import {
  createMailboxProvisioningClient,
  type MailboxProvisioningClient,
  mailboxRoutedRecipients,
  parseMailboxProvisioningConfiguration,
  removeMailboxReceivingRecipients,
} from "../../../../packages/ses/src/mailbox-provisioning.js";

export interface MailboxDeletionDeps {
  /** MAILBOX_RECEIVING_PROVISIONING_CONFIG; absent means SES routes nothing for us. */
  configuration?: string | undefined;
  credentials?: { accessKeyId?: string; secretAccessKey?: string };
  client?: () => MailboxProvisioningClient;
  /** ms epoch the run stops at; a mailbox left half-erased continues next minute. */
  deadline?: number;
}

export interface MailboxDeletionResult {
  erased: number;
  partial: number;
  waiting: number;
  failed: number;
}

/**
 * Excluir caixa, last step (from the per-minute Correio clock): mailboxes whose 30 days
 * ran out are erased. Their addresses leave the SES receipt rules first (the request
 * already took them out; this makes sure, under the shared provisioning lock), so an
 * address is never routed after its mailbox is gone. An SES or database failure leaves
 * the mailbox for the next run.
 */
export async function runMailboxDeletions(
  db: Db,
  deps: MailboxDeletionDeps = {},
): Promise<MailboxDeletionResult> {
  const result: MailboxDeletionResult = { erased: 0, partial: 0, waiting: 0, failed: 0 };
  const due = await dueMailboxDeletions(db, 10);
  if (!due.length) return result;
  const config = parseMailboxProvisioningConfiguration(deps.configuration);
  const client = () =>
    deps.client
      ? deps.client()
      : createMailboxProvisioningClient({
          region: config!.region,
          ...(deps.credentials ?? {}),
        });
  const deadline = deps.deadline ?? Date.now() + 20_000;
  for (const box of due) {
    if (Date.now() >= deadline) break;
    try {
      if (config && box.addresses.length)
        await db.transaction(async (transaction) => {
          const tx = transaction as unknown as Db;
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext('mailbox-receiving-provisioning'))`,
          );
          const routed = await mailboxRoutedRecipients(client(), config);
          const present = box.addresses.filter((address) => routed.has(address));
          if (present.length) await removeMailboxReceivingRecipients(client(), config, present);
        });
      const outcome = await purgeMailboxDeletion(db, box, { deadline });
      if (outcome !== "gone") result[outcome] += 1;
    } catch (err) {
      result.failed += 1;
      console.warn(
        `mailbox.deletions: ${box.id.slice(0, 8)} not erased`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return result;
}
