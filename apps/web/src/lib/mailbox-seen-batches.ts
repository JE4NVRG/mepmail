/** Keep bulk read/unread requests within both server organization bounds. */
export const MAILBOX_SEEN_BATCH = 200;
export const MAILBOX_SEEN_MAILBOX_BATCH = 50;

export function mailboxSeenBatches<T extends { mailboxId: string }>(rows: readonly T[]): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let mailboxes = new Set<string>();
  for (const row of rows) {
    if (
      batch.length === MAILBOX_SEEN_BATCH ||
      (!mailboxes.has(row.mailboxId) && mailboxes.size === MAILBOX_SEEN_MAILBOX_BATCH)
    ) {
      batches.push(batch);
      batch = [];
      mailboxes = new Set<string>();
    }
    batch.push(row);
    mailboxes.add(row.mailboxId);
  }
  if (batch.length) batches.push(batch);
  return batches;
}
