import { type Db, schema } from "@millionsend/db";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import {
  type MailboxRegistryActor,
  MailboxRegistryError,
  mailboxDomainLock,
  withMailboxRegistryAdmin,
} from "./mailbox-registry.js";

/** Same local-part contract as a mailbox's own address. */
const LOCAL = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
/** Each alias takes one SES receiving slot, so a mailbox keeps a modest number. */
export const MAX_ALIASES_PER_MAILBOX = 20;

export interface MailboxAlias {
  id: string;
  mailboxId: string;
  address: string;
  createdAt: Date;
}

/** The aliases of one mailbox, oldest first. Owners and admins manage them. */
export async function listMailboxAliases(
  db: Db,
  actor: MailboxRegistryActor,
  mailboxId: string,
): Promise<MailboxAlias[]> {
  return withMailboxRegistryAdmin(db, actor, (tx) =>
    tx
      .select({
        id: schema.mailboxAliases.id,
        mailboxId: schema.mailboxAliases.mailboxId,
        address: schema.mailboxAliases.address,
        createdAt: schema.mailboxAliases.createdAt,
      })
      .from(schema.mailboxAliases)
      .where(
        and(
          eq(schema.mailboxAliases.teamId, actor.teamId),
          eq(schema.mailboxAliases.mailboxId, mailboxId),
        ),
      )
      .orderBy(asc(schema.mailboxAliases.createdAt), asc(schema.mailboxAliases.address)),
  );
}

/**
 * Adds `local@<the mailbox's domain>` as an alias. The address must be free in
 * both mailboxes and aliases; both are checked under the domain lock that
 * mailbox creation also takes, so the two can never claim one address.
 * Receiving starts once activateMailboxReceiving lists it in the SES rules.
 */
export async function addMailboxAlias(
  db: Db,
  actor: MailboxRegistryActor,
  input: { mailboxId: string; localPart: string },
): Promise<MailboxAlias & { domainId: string }> {
  const local = typeof input.localPart === "string" ? input.localPart.trim().toLowerCase() : "";
  if (!LOCAL.test(local) || local.includes("..")) throw new MailboxRegistryError("invalid");
  return withMailboxRegistryAdmin(db, actor, async (tx) => {
    const [box] = await tx
      .select({
        id: schema.mailboxes.id,
        domainId: schema.mailboxes.domainId,
        address: schema.mailboxes.address,
        status: schema.mailboxes.status,
      })
      .from(schema.mailboxes)
      .where(
        and(eq(schema.mailboxes.id, input.mailboxId), eq(schema.mailboxes.teamId, actor.teamId)),
      );
    if (!box) throw new MailboxRegistryError("not_found");
    if (box.status !== "planned") throw new MailboxRegistryError("forbidden");
    await mailboxDomainLock(tx, box.domainId);
    const [domain] = await tx
      .select({ name: schema.domains.name })
      .from(schema.domains)
      .where(and(eq(schema.domains.id, box.domainId), eq(schema.domains.teamId, actor.teamId)));
    if (!domain) throw new MailboxRegistryError("not_found");
    const address = `${local}@${domain.name.toLowerCase()}`;
    if (address.length > 254 || address === box.address) throw new MailboxRegistryError("invalid");
    const [{ value: existing } = { value: 0 }] = await tx
      .select({ value: count() })
      .from(schema.mailboxAliases)
      .where(eq(schema.mailboxAliases.mailboxId, box.id));
    if (existing >= MAX_ALIASES_PER_MAILBOX) throw new MailboxRegistryError("invalid");
    // Never disclose which team holds an address: a taken one is a plain conflict.
    const [taken] = await tx
      .select({ id: schema.mailboxes.id })
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.address, address));
    if (taken) throw new MailboxRegistryError("conflict");
    const [row] = await tx
      .insert(schema.mailboxAliases)
      .values({ teamId: actor.teamId, mailboxId: box.id, domainId: box.domainId, address })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new MailboxRegistryError("conflict");
    return {
      id: row.id,
      mailboxId: row.mailboxId,
      address: row.address,
      createdAt: row.createdAt,
      domainId: row.domainId,
    };
  });
}

/**
 * Removes an alias. Its SES recipient stays listed (receiving never removes
 * recipients), so mail to it is accepted and then refused by delivery, like a
 * suspended mailbox.
 */
export async function removeMailboxAlias(
  db: Db,
  actor: MailboxRegistryActor,
  input: { id: string },
): Promise<{ id: string; mailboxId: string; address: string }> {
  return withMailboxRegistryAdmin(db, actor, async (tx) => {
    const [row] = await tx
      .delete(schema.mailboxAliases)
      .where(
        and(eq(schema.mailboxAliases.id, input.id), eq(schema.mailboxAliases.teamId, actor.teamId)),
      )
      .returning({
        id: schema.mailboxAliases.id,
        mailboxId: schema.mailboxAliases.mailboxId,
        address: schema.mailboxAliases.address,
      });
    if (!row) throw new MailboxRegistryError("not_found");
    return row;
  });
}

/** Whether an address is already taken by an alias (mailbox creation checks this). */
export async function mailboxAliasTaken(db: Db, address: string): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.mailboxAliases.id })
    .from(schema.mailboxAliases)
    .where(eq(schema.mailboxAliases.address, address));
  return Boolean(row);
}

/** The alias addresses of the given mailboxes, for listing in the SES receiving rules. */
export async function mailboxAliasAddresses(
  db: Db,
  teamId: string,
  mailboxIds: string[],
): Promise<{ mailboxId: string; address: string }[]> {
  if (!mailboxIds.length) return [];
  return db
    .select({ mailboxId: schema.mailboxAliases.mailboxId, address: schema.mailboxAliases.address })
    .from(schema.mailboxAliases)
    .where(
      and(
        eq(schema.mailboxAliases.teamId, teamId),
        inArray(schema.mailboxAliases.mailboxId, mailboxIds),
      ),
    )
    .orderBy(asc(schema.mailboxAliases.address));
}
