import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";

/** Real confirmed acceptance and retained outcomes for the rolling reputation query.
 * Quota counters stay independent; no mocked verdict or unrelated-history deletion. */
export async function providerReputationFixture(
  db: Db,
  teamId: string,
  counts: { sent: number; hardBounced?: number; softBounced?: number; complained?: number },
) {
  const hard = counts.hardBounced ?? 0;
  const soft = counts.softBounced ?? 0;
  const complained = counts.complained ?? 0;
  if (counts.sent < 1 || hard + soft > counts.sent || complained > counts.sent) {
    throw new RangeError("Invalid synthetic provider history");
  }
  const at = new Date(Date.now() - 60_000);
  const rows = await db
    .insert(schema.emails)
    .values(
      Array.from({ length: counts.sent }, () => ({
        teamId,
        from: "sender@example.test",
        to: ["recipient@example.test"],
        subject: "Synthetic API provider-confirmed reputation fixture",
        createdAt: at,
        sentAt: at,
        sesMessageId: `synthetic-${randomUUID()}`,
        latestStatus: "sent" as const,
      })),
    )
    .returning({ id: schema.emails.id });
  const events: (typeof schema.emailEvents.$inferInsert)[] = [];
  for (const [index, row] of rows.entries()) {
    if (index < hard + soft)
      events.push({
        emailId: row.id,
        type: "bounced",
        bounceType: index < hard ? "Permanent" : "Transient",
        occurredAt: at,
        createdAt: at,
        snsMessageId: randomUUID(),
        data: {},
      });
    if (index < complained)
      events.push({
        emailId: row.id,
        type: "complained",
        occurredAt: at,
        createdAt: at,
        snsMessageId: randomUUID(),
        data: {},
      });
  }
  if (events.length) await db.insert(schema.emailEvents).values(events);
}
