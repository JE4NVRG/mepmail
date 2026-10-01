/** Optional registry; production hosting/transport is a separate capability. */
import { mailboxDomainLock } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";

export function mailboxRegistryEnabled(): boolean {
  return (
    process.env.MAILBOX_REGISTRY_ENABLED === "true" || process.env.MAILBOX_REGISTRY_ENABLED === "1"
  );
}

/** Protect reserved boxes before domain removal touches SES, even with registry UI off. */
export async function withMailboxDomainDeletion<T>(
  db: Db,
  teamId: string,
  domainId: string,
  remove: (db: Db) => Promise<T>,
): Promise<T> {
  const [extension] = await db
    .select({ installed: sql<boolean>`to_regclass('public.mailboxes') is not null` })
    .from(sql`(select 1) as mailbox_extension`);
  if (!extension?.installed) return remove(db);
  return db.transaction(async (tx) => {
    const transaction = tx as unknown as Db;
    await mailboxDomainLock(transaction, domainId);
    const [domain] = await transaction
      .select({ id: schema.domains.id })
      .from(schema.domains)
      .where(and(eq(schema.domains.id, domainId), eq(schema.domains.teamId, teamId)));
    if (!domain) throw new TRPCError({ code: "NOT_FOUND" });
    const [registered] = await transaction
      .select({ id: schema.mailboxes.id })
      .from(schema.mailboxes)
      .where(and(eq(schema.mailboxes.domainId, domainId), eq(schema.mailboxes.teamId, teamId)))
      .limit(1);
    if (registered)
      throw new TRPCError({ code: "CONFLICT", message: "Domain has registered mailboxes" });
    return remove(transaction);
  });
}
