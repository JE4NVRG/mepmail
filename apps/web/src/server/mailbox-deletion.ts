import { env } from "@millionsend/config";
import type { Db } from "@millionsend/db";
import { sql } from "drizzle-orm";
import {
  createMailboxProvisioningClient,
  type MailboxProvisioningClient,
  mailboxRoutedRecipients,
  parseMailboxProvisioningConfiguration,
  removeMailboxReceivingRecipients,
} from "../../../../packages/ses/src/mailbox-provisioning";

interface WithdrawDependencies {
  configuration?: string | undefined;
  client?: () => MailboxProvisioningClient;
}

/**
 * Excluir caixa: the deleted mailbox's addresses leave the SES receipt rules right away,
 * so SES refuses its mail before accepting (and billing) it. Best effort: the mailbox is
 * already suspended, and the worker's purge makes sure again before the row goes.
 * Returns how many addresses came out; never throws.
 */
export async function withdrawMailboxReceiving(
  db: Db,
  addresses: string[],
  deps: WithdrawDependencies = {},
): Promise<number> {
  const config = parseMailboxProvisioningConfiguration(
    deps.configuration ?? process.env.MAILBOX_RECEIVING_PROVISIONING_CONFIG,
  );
  if (!config || !addresses.length) return 0;
  const client = () =>
    deps.client
      ? deps.client()
      : createMailboxProvisioningClient({
          region: config.region,
          ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
            ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
            : {}),
        });
  try {
    return await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      // The same lock activation and the receiving holds take: one SES writer at a time.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('mailbox-receiving-provisioning'))`,
      );
      const routed = await mailboxRoutedRecipients(client(), config);
      const present = addresses.filter((address) => routed.has(address));
      if (present.length) await removeMailboxReceivingRecipients(client(), config, present);
      return present.length;
    });
  } catch (error) {
    console.warn(
      "mailbox deletion: addresses left in SES for the purge",
      error instanceof Error ? error.message : error,
    );
    return 0;
  }
}
