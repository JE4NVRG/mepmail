import {
  finishMailboxExternalSync,
  heldMailboxExternalTeams,
  ImapError,
  type Keyring,
  MailboxServiceError,
  type MailboxTransportMimeAdapter,
  mailboxExternalSourceId,
  openImap,
  openMailboxExternalAccount,
  receiveExternalMailboxMime,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";

/**
 * Contas externas: one sync round for one account (job mailbox.external_sync, one at a
 * time per account). It reads the provider's INBOX read-only (EXAMINE, BODY.PEEK: nothing
 * is marked or moved there), picks up after the last UID it stored under the folder's
 * UIDVALIDITY, and on a first round (or a new UIDVALIDITY) takes the last 30 days, at
 * most 500 messages. Each message is stored like received mail (rules, blocked senders);
 * the checkpoint moves only past what was stored.
 */
const BATCH = 25;
const ROUND_MAX = 200;
const FIRST_ROUND_DAYS = 30;
const FIRST_ROUND_MAX = 500;
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

export async function syncMailboxExternalAccount(
  db: Db,
  keyring: Keyring,
  mailboxId: string,
  deps: {
    mime: MailboxTransportMimeAdapter;
    senderKey?: Buffer;
    open?: typeof openImap;
    now?: () => Date;
  },
): Promise<"done" | "more" | "held" | "auth_failed" | "error" | "gone"> {
  const now = deps.now ?? (() => new Date());
  const account = await openMailboxExternalAccount(db, keyring, mailboxId);
  if (!account || account.mailboxStatus !== "planned") return "gone";
  if ((await heldMailboxExternalTeams(db, [account.teamId])).has(account.teamId)) {
    await finishMailboxExternalSync(db, mailboxId, {
      ok: true,
      syncState: account.syncState,
      more: false,
    });
    return "held";
  }
  let session: Awaited<ReturnType<typeof openImap>>;
  try {
    session = await (deps.open ?? openImap)(
      { host: account.imapHost, port: 993, username: account.username, password: account.secret },
      { timeoutMs: 60_000, maxLiteralBytes: MAX_MESSAGE_BYTES },
    );
  } catch (error) {
    const reason = error instanceof ImapError ? error.reason : "network";
    await finishMailboxExternalSync(db, mailboxId, {
      ok: false,
      status: reason === "login" ? "auth_failed" : "error",
      error: `imap_${reason}`,
    });
    return reason === "login" ? "auth_failed" : "error";
  }
  try {
    const folder = await session.examine("INBOX");
    if (folder.uidValidity === null) throw new ImapError("protocol");
    const state = account.syncState.inbox;
    const fresh = !state || state.uidValidity !== folder.uidValidity;
    let uids = fresh
      ? (
          await session.uidSearchSince(new Date(now().getTime() - FIRST_ROUND_DAYS * 86_400_000))
        ).slice(-FIRST_ROUND_MAX)
      : await session.uidSearchAfter(state.lastUid);
    let lastUid = fresh ? 0 : state.lastUid;
    const more = uids.length > ROUND_MAX;
    uids = uids.slice(0, ROUND_MAX);
    for (let start = 0; start < uids.length; start += BATCH) {
      const batch = uids.slice(start, start + BATCH);
      const sizes = await session.uidFetchSizes(batch);
      const wanted = batch.filter((uid) => (sizes.get(uid) ?? 0) <= MAX_MESSAGE_BYTES);
      for (const message of await session.uidFetchMessages(wanted)) {
        let from: string | null = null;
        try {
          from = (await deps.mime.parse(message.raw)).from || null;
        } catch {
          // Unusual MIME is still stored; it just gets no rule or sender screen.
        }
        await receiveExternalMailboxMime(db, keyring, {
          mailboxId,
          sourceId: mailboxExternalSourceId(mailboxId, folder.uidValidity, message.uid),
          raw: message.raw,
          receivedAt: message.internalDate ?? now(),
          seen: message.flags.some((flag) => flag.toLowerCase() === "\\seen"),
          from,
          ...(deps.senderKey ? { senderKey: deps.senderKey } : {}),
        });
      }
      // Too-large messages are passed over too: they would block the account forever.
      lastUid = Math.max(lastUid, ...batch);
      await finishMailboxExternalSync(db, mailboxId, {
        ok: true,
        syncState: { inbox: { uidValidity: folder.uidValidity, lastUid } },
        more: true,
      });
    }
    await finishMailboxExternalSync(db, mailboxId, {
      ok: true,
      syncState: { inbox: { uidValidity: folder.uidValidity, lastUid } },
      more,
    });
    return more ? "more" : "done";
  } catch (error) {
    const code =
      error instanceof MailboxServiceError && error.code === "external_storage"
        ? "storage_full"
        : error instanceof ImapError
          ? `imap_${error.reason}`
          : "sync_failed";
    await finishMailboxExternalSync(db, mailboxId, { ok: false, status: "error", error: code });
    return "error";
  } finally {
    await session.logout().catch(() => undefined);
  }
}
