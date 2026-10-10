import {
  claimDueMailboxSends,
  completeMailboxSend,
  failMailboxSend,
  type Keyring,
  type MailboxTransportMimeAdapter,
  mailboxScheduledSendFailure,
  markDueMailboxFollowUps,
  queueMailboxDraft,
  wakeSnoozedMailboxItems,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";

export interface MailboxSchedulesDeps {
  keyring: Keyring;
  mime: MailboxTransportMimeAdapter;
  /** MAILBOX_TRANSPORT_ENABLED: without transport, scheduled sends simply wait. */
  transportEnabled: boolean;
  /** Hands an admitted outbox row to the send lane (mailbox.send). */
  enqueue: (outboxId: string) => Promise<void>;
  now?: Date | undefined;
}

/**
 * The Correio clock (cron "mailbox.schedules", every minute): snoozed messages
 * come back to the inbox, follow-ups with no reply come due, and drafts whose
 * send time came are admitted through queueMailboxDraft as the person who
 * scheduled them, with ownership, license, plan and seat checked now. Nothing
 * here opens content beyond what that admission already opens.
 */
export async function runMailboxSchedules(
  db: Db,
  deps: MailboxSchedulesDeps,
): Promise<{ woken: number; followUps: number; sent: number; failed: number; deferred: number }> {
  const now = deps.now ?? new Date();
  const woken = await wakeSnoozedMailboxItems(db, now);
  const followUps = await markDueMailboxFollowUps(db, now);
  let sent = 0;
  let failed = 0;
  let deferred = 0;
  if (deps.transportEnabled) {
    for (const due of await claimDueMailboxSends(db, now)) {
      // The person who scheduled it is gone: nobody may send it in their name.
      if (!due.scheduledBy) {
        await failMailboxSend(db, due, "forbidden");
        failed += 1;
        continue;
      }
      let outboxId: string;
      try {
        const outbox = await queueMailboxDraft(
          db,
          deps.keyring,
          { teamId: due.teamId, userId: due.scheduledBy },
          { mailboxId: due.mailboxId, id: due.id, expectedRevision: due.revision },
          deps.mime,
          now,
        );
        outboxId = outbox.id;
      } catch (error) {
        const failure = mailboxScheduledSendFailure(error);
        if (failure) {
          await failMailboxSend(db, due, failure);
          failed += 1;
        } else {
          // A passing problem: the claim lapses and a later run tries again.
          deferred += 1;
          console.warn(
            "mailbox.schedules: send deferred",
            error instanceof Error ? error.message : error,
          );
        }
        continue;
      }
      await completeMailboxSend(db, due);
      sent += 1;
      try {
        await deps.enqueue(outboxId);
      } catch (error) {
        // The outbox row is committed; sends.reconcile enqueues it again.
        console.warn(
          "mailbox.schedules: enqueue failed",
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
  return { woken, followUps, sent, failed, deferred };
}
