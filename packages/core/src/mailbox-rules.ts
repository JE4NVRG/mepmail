import { createHmac, randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { mailboxRules } from "../../db/src/schema/mailbox-rules.js";
import { decryptPayload, encryptPayload } from "./crypto/envelope.js";
import type { Keyring } from "./crypto/keyring.js";
import {
  type MailboxContentActor,
  MailboxContentError,
  withMailboxOrganizationAccess,
} from "./mailbox-private-store.js";
import { normalizeMailboxSender } from "./mailbox-senders.js";

/**
 * Regras automáticas: the owner's filters for one mailbox. New mail from a sender
 * (exact address) or a domain (and its subdomains) is filed at receipt in a named
 * folder, the Archive or another mailbox the same person owns, and may be marked read
 * or starred. Receipt applies them only to mail bound for the inbox: provider spam,
 * quarantine and blocked senders keep their own folder. Lookups use an HMAC of the
 * kind and value scoped to the mailbox (`matchKey`, derived from the sender key), so
 * the table holds no address; the value is sealed, bound to its row, for review.
 */
export type MailboxRuleMatchKind = "sender" | "domain";

/** Rules kept per mailbox. */
export const MAILBOX_RULES_MAX = 500;

export interface MailboxRuleInput {
  mailboxId: string;
  /** Edits this rule; another rule with the same match is replaced by it. */
  id?: string | undefined;
  match: { kind: MailboxRuleMatchKind; value: string };
  folderId?: string | null | undefined;
  archive?: boolean | undefined;
  targetMailboxId?: string | null | undefined;
  markRead?: boolean | undefined;
  star?: boolean | undefined;
}

export interface MailboxRuleView {
  id: string;
  match: { kind: MailboxRuleMatchKind; value: string };
  folderId: string | null;
  /** The folder was archived: the rule leaves new mail in the inbox until it is edited. */
  folderMissing: boolean;
  archive: boolean;
  targetMailboxId: string | null;
  /** The other mailbox no longer belongs to this mailbox's owner: no mail goes there. */
  targetUnavailable: boolean;
  markRead: boolean;
  star: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** What receipt does with one message: the best rule for its sender, if any. */
export interface MailboxRuleAction {
  id: string;
  teamId: string;
  folderId: string | null;
  archive: boolean;
  targetMailboxId: string | null;
  markRead: boolean;
  star: boolean;
}

const MAX_DOMAIN = 253;

/** The rule-key HMAC key, kept apart from the sender key it is derived from. */
export function deriveMailboxRuleKey(senderKey: Buffer): Buffer {
  return createHmac("sha256", senderKey).update("mepmail/mailbox-rule/v1").digest();
}

/** Lower-cased ASCII (punycode) without a leading "@" or a trailing dot, or null. */
export function normalizeMailboxRuleDomain(value: string): string | null {
  let domain = value.trim().toLowerCase();
  if (domain.startsWith("@")) domain = domain.slice(1);
  if (domain.endsWith(".")) domain = domain.slice(0, -1);
  if (!domain || domain.length > MAX_DOMAIN || /[\s@/\\]/.test(domain)) return null;
  const ascii = domainToASCII(domain);
  if (!ascii || ascii.length > MAX_DOMAIN) return null;
  const labels = ascii.split(".");
  if (labels.length < 2) return null;
  const label = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
  return labels.every((part) => label.test(part)) ? ascii : null;
}

/** The normalized value of a match, or null when it is not a plausible one. */
export function normalizeMailboxRuleMatch(kind: MailboxRuleMatchKind, value: string) {
  if (kind === "domain") return normalizeMailboxRuleDomain(value);
  if (kind !== "sender") return null;
  const address = normalizeMailboxSender(value);
  if (!address) return null;
  const at = address.lastIndexOf("@");
  const domain = normalizeMailboxRuleDomain(address.slice(at + 1));
  return domain ? `${address.slice(0, at)}@${domain}` : null;
}

/** The lookup key of one match in one mailbox (32 bytes). */
export function mailboxRuleMatchKey(
  key: Buffer,
  mailboxId: string,
  kind: MailboxRuleMatchKind,
  value: string,
): Buffer {
  return createHmac("sha256", key).update(`${mailboxId}\n${kind}\n${value}`).digest();
}

/**
 * The matches that can catch mail from this sender, most specific first: the
 * address, then its domain and every parent domain with at least two labels.
 */
export function mailboxRuleCandidates(
  from: string,
): { kind: MailboxRuleMatchKind; value: string }[] {
  const address = normalizeMailboxRuleMatch("sender", from);
  if (!address) return [];
  const labels = address.slice(address.lastIndexOf("@") + 1).split(".");
  const out: { kind: MailboxRuleMatchKind; value: string }[] = [{ kind: "sender", value: address }];
  for (let i = 0; i + 2 <= labels.length; i++)
    out.push({ kind: "domain", value: labels.slice(i).join(".") });
  return out;
}

const binding = (teamId: string, mailboxId: string, id: string) => ({
  teamId,
  kind: "email_body" as const,
  rowId: `mailbox-rule-v1:${mailboxId}:${id}`,
});

type Rule = typeof mailboxRules.$inferSelect;

/**
 * For receipt: the best rule of this mailbox for mail from `from`, or null. A folder
 * archived since is dropped from the action. Internal: the caller is the trusted
 * receipt transaction and checks the target mailbox itself.
 */
export async function mailboxRuleFor(
  db: Db,
  ruleKey: Buffer,
  input: { mailboxId: string; from: string },
): Promise<MailboxRuleAction | null> {
  const candidates = mailboxRuleCandidates(input.from);
  if (!candidates.length) return null;
  const keys = candidates.map(({ kind, value }) =>
    mailboxRuleMatchKey(ruleKey, input.mailboxId, kind, value).toString("hex"),
  );
  const rows = await db
    .select({
      id: mailboxRules.id,
      teamId: mailboxRules.teamId,
      matchKey: mailboxRules.matchKey,
      folderId: mailboxRules.folderId,
      folderArchivedAt: schema.mailboxFolders.archivedAt,
      archive: mailboxRules.archive,
      targetMailboxId: mailboxRules.targetMailboxId,
      markRead: mailboxRules.markRead,
      star: mailboxRules.star,
    })
    .from(mailboxRules)
    .leftJoin(
      schema.mailboxFolders,
      and(
        eq(schema.mailboxFolders.id, mailboxRules.folderId),
        eq(schema.mailboxFolders.mailboxId, mailboxRules.mailboxId),
        eq(schema.mailboxFolders.teamId, mailboxRules.teamId),
      ),
    )
    .where(
      and(
        eq(mailboxRules.mailboxId, input.mailboxId),
        inArray(
          mailboxRules.matchKey,
          keys.map((hex) => Buffer.from(hex, "hex")),
        ),
      ),
    );
  const best = rows
    .map((row) => ({ row, rank: keys.indexOf(Buffer.from(row.matchKey).toString("hex")) }))
    .filter(({ rank }) => rank >= 0)
    .sort((a, b) => a.rank - b.rank)[0]?.row;
  if (!best) return null;
  const folderActive = !!best.folderId && best.folderArchivedAt === null;
  return {
    id: best.id,
    teamId: best.teamId,
    folderId: folderActive ? best.folderId : null,
    archive: best.archive,
    targetMailboxId: best.targetMailboxId,
    markRead: best.markRead,
    star: best.star,
  };
}

/** The mailbox a rule may send mail to: same team, active, and owned by `ownerUserId`. */
async function ownedTarget(
  db: Db,
  input: { teamId: string; targetMailboxId: string; ownerUserId: string | null },
  lock: boolean,
) {
  if (!input.ownerUserId) return null;
  const query = db
    .select({ id: schema.mailboxes.id, ownerUserId: schema.mailboxes.ownerUserId })
    .from(schema.mailboxes)
    .where(
      and(
        eq(schema.mailboxes.id, input.targetMailboxId),
        eq(schema.mailboxes.teamId, input.teamId),
        eq(schema.mailboxes.status, "planned"),
        eq(schema.mailboxes.ownerUserId, input.ownerUserId),
      ),
    );
  const [row] = await (lock ? query.for("share") : query);
  return row ?? null;
}

/**
 * For receipt: whether mail for `mailboxId` may be redirected to the rule's mailbox
 * now. Both must still belong to the same person, so a rule outlives no change of
 * owner, and the target must be active on a verified domain.
 */
export async function mailboxRuleTargetUsable(
  db: Db,
  input: { teamId: string; mailboxId: string; targetMailboxId: string },
): Promise<boolean> {
  const [source] = await db
    .select({ ownerUserId: schema.mailboxes.ownerUserId })
    .from(schema.mailboxes)
    .where(
      and(eq(schema.mailboxes.id, input.mailboxId), eq(schema.mailboxes.teamId, input.teamId)),
    );
  const target = await ownedTarget(
    db,
    { ...input, ownerUserId: source?.ownerUserId ?? null },
    false,
  );
  if (!target) return false;
  const [domain] = await db
    .select({ status: schema.domains.status })
    .from(schema.mailboxes)
    .innerJoin(
      schema.domains,
      and(
        eq(schema.domains.id, schema.mailboxes.domainId),
        eq(schema.domains.teamId, schema.mailboxes.teamId),
      ),
    )
    .where(eq(schema.mailboxes.id, input.targetMailboxId));
  return domain?.status === "verified";
}

/** The rule's actions, validated against the mailbox's folders and owner. */
async function actions(
  tx: Db,
  actor: MailboxContentActor,
  input: MailboxRuleInput,
): Promise<{
  folderId: string | null;
  archive: boolean;
  targetMailboxId: string | null;
  markRead: boolean;
  star: boolean;
}> {
  const folderId = input.folderId ?? null;
  const targetMailboxId = input.targetMailboxId ?? null;
  const archive = input.archive === true;
  const markRead = input.markRead === true;
  const star = input.star === true;
  const destinations = Number(!!folderId) + Number(archive) + Number(!!targetMailboxId);
  if (destinations > 1 || (destinations === 0 && !markRead && !star))
    throw new MailboxContentError("invalid");
  if (folderId) {
    const [folder] = await tx
      .select({ id: schema.mailboxFolders.id })
      .from(schema.mailboxFolders)
      .where(
        and(
          eq(schema.mailboxFolders.id, folderId),
          eq(schema.mailboxFolders.teamId, actor.teamId),
          eq(schema.mailboxFolders.mailboxId, input.mailboxId),
          isNull(schema.mailboxFolders.archivedAt),
        ),
      )
      .for("share");
    if (!folder) throw new MailboxContentError("not_found");
  }
  if (targetMailboxId) {
    if (targetMailboxId === input.mailboxId) throw new MailboxContentError("invalid");
    // The organization scope already proved the actor owns the rule's mailbox.
    const target = await ownedTarget(
      tx,
      { teamId: actor.teamId, targetMailboxId, ownerUserId: actor.userId },
      true,
    );
    if (!target) throw new MailboxContentError("forbidden");
  }
  return { folderId, archive, targetMailboxId, markRead, star };
}

interface ViewState {
  /** Folder id -> archived (true) or active (false); a missing id is gone. */
  folders: Map<string, boolean>;
  /** Target mailbox ids rules may send mail to now. */
  usableTargets: Set<string>;
}

/** What the rule views need, in three queries however many rules there are. */
async function viewState(db: Db, rows: readonly Rule[]): Promise<ViewState> {
  const folders = new Map<string, boolean>();
  const usableTargets = new Set<string>();
  const folderIds = [...new Set(rows.flatMap((row) => (row.folderId ? [row.folderId] : [])))];
  if (folderIds.length)
    for (const folder of await db
      .select({ id: schema.mailboxFolders.id, archivedAt: schema.mailboxFolders.archivedAt })
      .from(schema.mailboxFolders)
      .where(inArray(schema.mailboxFolders.id, folderIds)))
      folders.set(folder.id, folder.archivedAt !== null);
  const targetIds = [
    ...new Set(rows.flatMap((row) => (row.targetMailboxId ? [row.targetMailboxId] : []))),
  ];
  if (targetIds.length) {
    const sources = [...new Set(rows.map((row) => row.mailboxId))];
    const owners = new Map(
      (
        await db
          .select({ id: schema.mailboxes.id, ownerUserId: schema.mailboxes.ownerUserId })
          .from(schema.mailboxes)
          .where(inArray(schema.mailboxes.id, sources))
      ).map((box) => [box.id, box.ownerUserId]),
    );
    const targets = await db
      .select({
        id: schema.mailboxes.id,
        teamId: schema.mailboxes.teamId,
        status: schema.mailboxes.status,
        ownerUserId: schema.mailboxes.ownerUserId,
        domainStatus: schema.domains.status,
      })
      .from(schema.mailboxes)
      .innerJoin(
        schema.domains,
        and(
          eq(schema.domains.id, schema.mailboxes.domainId),
          eq(schema.domains.teamId, schema.mailboxes.teamId),
        ),
      )
      .where(inArray(schema.mailboxes.id, targetIds));
    for (const row of rows) {
      if (!row.targetMailboxId) continue;
      const target = targets.find((box) => box.id === row.targetMailboxId);
      const owner = owners.get(row.mailboxId);
      if (
        target &&
        owner &&
        target.teamId === row.teamId &&
        target.status === "planned" &&
        target.domainStatus === "verified" &&
        target.ownerUserId === owner
      )
        usableTargets.add(`${row.mailboxId}:${row.targetMailboxId}`);
    }
  }
  return { folders, usableTargets };
}

async function view(
  row: Rule,
  keyring: Keyring,
  state: ViewState,
): Promise<MailboxRuleView | null> {
  let value: string;
  try {
    value = (
      await decryptPayload(
        {
          ciphertext: Buffer.from(row.matchCiphertext),
          iv: Buffer.from(row.matchIv),
          wrappedDek: Buffer.from(row.matchWrappedDek),
          keyVersion: row.matchKeyVersion,
        },
        keyring,
        binding(row.teamId, row.mailboxId, row.id),
      )
    ).toString("utf8");
  } catch {
    // A row that no longer opens is left out rather than shown wrong.
    return null;
  }
  return {
    id: row.id,
    match: { kind: row.matchKind, value },
    folderId: row.folderId,
    folderMissing: !!row.folderId && state.folders.get(row.folderId) !== false,
    archive: row.archive,
    targetMailboxId: row.targetMailboxId,
    targetUnavailable:
      !!row.targetMailboxId && !state.usableTargets.has(`${row.mailboxId}:${row.targetMailboxId}`),
    markRead: row.markRead,
    star: row.star,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The owner creates or edits a rule. The same match in the mailbox is one rule:
 * saving it again replaces its actions, and an edit that takes another rule's
 * match replaces that rule.
 */
export async function saveMailboxRule(
  db: Db,
  keyring: Keyring,
  senderKey: Buffer,
  actor: MailboxContentActor,
  input: MailboxRuleInput,
): Promise<MailboxRuleView> {
  actor = { ...actor };
  input = { ...input, match: { ...input.match } };
  const kind = input.match?.kind;
  if (kind !== "sender" && kind !== "domain") throw new MailboxContentError("invalid");
  const value =
    typeof input.match.value === "string"
      ? normalizeMailboxRuleMatch(kind, input.match.value)
      : null;
  if (!value) throw new MailboxContentError("invalid");
  const matchKey = mailboxRuleMatchKey(
    deriveMailboxRuleKey(senderKey),
    input.mailboxId,
    kind,
    value,
  );
  const row = await withMailboxOrganizationAccess(db, actor, input.mailboxId, async (tx) => {
    const act = await actions(tx, actor, input);
    const scope = and(
      eq(mailboxRules.teamId, actor.teamId),
      eq(mailboxRules.mailboxId, input.mailboxId),
    );
    const [edited] = input.id
      ? await tx
          .select()
          .from(mailboxRules)
          .where(and(scope, eq(mailboxRules.id, input.id)))
          .for("update")
      : [];
    if (input.id && !edited) throw new MailboxContentError("not_found");
    const [same] = await tx
      .select()
      .from(mailboxRules)
      .where(and(scope, eq(mailboxRules.matchKey, matchKey)))
      .for("update");
    const now = new Date();
    const keep = same ?? edited;
    if (keep) {
      if (edited && same && edited.id !== same.id)
        await tx.delete(mailboxRules).where(eq(mailboxRules.id, edited.id));
      const sealed = await encryptPayload(
        Buffer.from(value, "utf8"),
        keyring,
        binding(actor.teamId, input.mailboxId, keep.id),
      );
      const [updated] = await tx
        .update(mailboxRules)
        .set({
          matchKind: kind,
          matchKey,
          matchCiphertext: sealed.ciphertext,
          matchIv: sealed.iv,
          matchWrappedDek: sealed.wrappedDek,
          matchKeyVersion: sealed.keyVersion,
          ...act,
          updatedAt: now,
        })
        .where(eq(mailboxRules.id, keep.id))
        .returning();
      return updated!;
    }
    const [total] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(mailboxRules)
      .where(scope);
    if ((total?.count ?? 0) >= MAILBOX_RULES_MAX) throw new MailboxContentError("conflict");
    const id = randomUUID();
    const sealed = await encryptPayload(
      Buffer.from(value, "utf8"),
      keyring,
      binding(actor.teamId, input.mailboxId, id),
    );
    const [inserted] = await tx
      .insert(mailboxRules)
      .values({
        id,
        teamId: actor.teamId,
        mailboxId: input.mailboxId,
        matchKind: kind,
        matchKey,
        matchCiphertext: sealed.ciphertext,
        matchIv: sealed.iv,
        matchWrappedDek: sealed.wrappedDek,
        matchKeyVersion: sealed.keyVersion,
        ...act,
        createdBy: actor.userId,
      })
      .returning();
    return inserted!;
  });
  const opened = await view(row, keyring, await viewState(db, [row]));
  if (!opened) throw new MailboxContentError("conflict");
  return opened;
}

/** The owner deletes a rule. Deleting one that is already gone is not an error. */
export async function deleteMailboxRule(
  db: Db,
  actor: MailboxContentActor,
  input: { mailboxId: string; id: string },
): Promise<{ id: string; deleted: boolean }> {
  actor = { ...actor };
  return withMailboxOrganizationAccess(db, actor, input.mailboxId, async (tx) => {
    const removed = await tx
      .delete(mailboxRules)
      .where(
        and(
          eq(mailboxRules.id, input.id),
          eq(mailboxRules.teamId, actor.teamId),
          eq(mailboxRules.mailboxId, input.mailboxId),
        ),
      )
      .returning({ id: mailboxRules.id });
    return { id: input.id, deleted: removed.length > 0 };
  });
}

/** The owner's rules for one mailbox, newest first, with their matches opened. */
export async function listMailboxRules(
  db: Db,
  keyring: Keyring,
  actor: MailboxContentActor,
  input: { mailboxId: string },
): Promise<MailboxRuleView[]> {
  actor = { ...actor };
  const rows = await withMailboxOrganizationAccess(db, actor, input.mailboxId, (tx) =>
    tx
      .select()
      .from(mailboxRules)
      .where(
        and(eq(mailboxRules.teamId, actor.teamId), eq(mailboxRules.mailboxId, input.mailboxId)),
      )
      .orderBy(desc(mailboxRules.updatedAt), desc(mailboxRules.id)),
  );
  const state = await viewState(db, rows);
  const opened = await Promise.all(rows.map((row) => view(row, keyring, state)));
  return opened.filter((row): row is MailboxRuleView => row !== null);
}
