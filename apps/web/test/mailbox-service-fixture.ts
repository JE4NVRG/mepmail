import { type Db, schema } from "@millionsend/db";

/** Synthetic offline test contract. These are not launch prices or paid entitlements. */
export async function seedMailboxTestService(db: Db, teamIds: string[]) {
  const now = Date.now();
  await db.insert(schema.mailboxSubscriptions).values(
    teamIds.map((teamId) => ({
      teamId,
      status: "active" as const,
      seats: 10,
      storageBytesPerMailbox: 5 * 1024 * 1024,
      includedOutboundPerMailbox: 100,
      periodStart: new Date(now - 86400000),
      periodEnd: new Date(now + 30 * 86400000),
    })),
  );
}
