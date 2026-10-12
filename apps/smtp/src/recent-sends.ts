import { mailboxThreadKeys } from "@millionsend/core";

/**
 * Messages this process just sent for a mailbox over SMTP, by Message-ID key, for an
 * hour: a mail app that saves its own copy in Enviados right after (IMAP APPEND) gets
 * that copy recognised instead of a duplicate. The send record and the copy in Enviados
 * are checked too (mailbox-imap.ts); this covers the moment before either exists.
 */
const TTL_MS = 60 * 60_000;
const sent = new Map<string, number>();

function sweep(now: number) {
  for (const [key, at] of sent) if (now - at > TTL_MS) sent.delete(key);
}

export function rememberSent(mailboxId: string, raw: Buffer, now = Date.now()) {
  const { messageKey } = mailboxThreadKeys(raw);
  if (!messageKey) return;
  if (sent.size > 10_000) sweep(now);
  sent.set(`${mailboxId}:${messageKey}`, now);
}

export function recentlySent(mailboxId: string, messageKey: string, now = Date.now()) {
  const at = sent.get(`${mailboxId}:${messageKey}`);
  return at !== undefined && now - at <= TTL_MS;
}
