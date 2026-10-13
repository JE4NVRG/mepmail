import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  getMailboxRecipientBlock,
  unblockMailboxRecipient,
} from "../src/mailbox-recipient-blocks.js";
import { checkMailboxRecipientBlocks, mailboxRecipientHash } from "../src/mailbox-transport.js";

// Real main + Correio DDL. Blocks are seeded as the outcome recorder writes them: by the
// team's keyed hash of the address, never the address.
let client: PGlite;
let db: Db;
beforeAll(async () => {
  client = new PGlite();
  const base = fileURLToPath(new URL("../../db/drizzle/", import.meta.url));
  const mail = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
  for (const path of [base, mail])
    for (const name of readdirSync(path)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await client.transaction(async (tx) => {
        for (const statement of readFileSync(path + name, "utf8")
          .split("--> statement-breakpoint")
          .filter((part) => part.trim()))
          await tx.exec(statement);
      });
  db = drizzle(client, { schema }) as unknown as Db;
});
afterAll(async () => {
  await client.close();
});

const EVENT = "a".repeat(64);
async function team(role: "owner" | "member" = "owner") {
  const userId = randomUUID();
  const [row] = await db.insert(schema.teams).values({ name: "Blocks", slug: userId }).returning();
  await db.insert(schema.user).values({
    id: userId,
    name: "Fixture",
    email: `${userId}@example.invalid`,
    emailVerified: true,
  });
  await db.insert(schema.teamMembers).values({ teamId: row!.id, userId, role });
  return { teamId: row!.id, userId };
}
async function block(teamId: string, address: string, reason: "hard_bounce" | "complaint") {
  await db.insert(schema.mailboxRecipientBlocks).values({
    teamId,
    recipientHash: mailboxRecipientHash(teamId, address),
    reason,
    sourceEventId: EVENT,
  });
}

it("lifts a hard-bounce block by the address, audited without it, so sends reach it again", async () => {
  const owner = await team();
  const other = await team();
  await block(owner.teamId, "pilot@example.invalid", "hard_bounce");
  await block(other.teamId, "pilot@example.invalid", "hard_bounce");
  expect(
    await getMailboxRecipientBlock(db, owner, { address: " Pilot@Example.invalid " }),
  ).toMatchObject({ address: "pilot@example.invalid", blocked: true, reason: "hard_bounce" });
  expect(
    await checkMailboxRecipientBlocks(db, {
      teamId: owner.teamId,
      recipients: ["pilot@example.invalid"],
    }),
  ).toBe(false);

  expect(
    await unblockMailboxRecipient(db, owner, { address: "pilot@example.invalid" }),
  ).toMatchObject({ blocked: false, unblocked: true });
  expect(
    await checkMailboxRecipientBlocks(db, {
      teamId: owner.teamId,
      recipients: ["pilot@example.invalid"],
    }),
  ).toBe(true);
  // Another team's block on the same address is its own.
  expect(
    await checkMailboxRecipientBlocks(db, {
      teamId: other.teamId,
      recipients: ["pilot@example.invalid"],
    }),
  ).toBe(false);
  // Again: nothing left to lift, not an error.
  expect(
    await unblockMailboxRecipient(db, owner, { address: "pilot@example.invalid" }),
  ).toMatchObject({ blocked: false, unblocked: false });

  const audit = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.teamId, owner.teamId));
  expect(audit.map((a) => a.action)).toEqual(["mailbox.recipient_unblocked"]);
  expect(audit[0]?.data).toMatchObject({ reason: "hard_bounce" });
  expect(JSON.stringify(audit)).not.toContain("pilot@example.invalid");
});

it("keeps a complaint block, and refuses members and malformed addresses", async () => {
  const owner = await team();
  await block(owner.teamId, "spam@example.invalid", "complaint");
  await expect(
    unblockMailboxRecipient(db, owner, { address: "spam@example.invalid" }),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(
    await getMailboxRecipientBlock(db, owner, { address: "spam@example.invalid" }),
  ).toMatchObject({ blocked: true, reason: "complaint" });

  const member = await team("member");
  await block(member.teamId, "x@example.invalid", "hard_bounce");
  await expect(
    unblockMailboxRecipient(db, member, { address: "x@example.invalid" }),
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    unblockMailboxRecipient(db, owner, { address: "not an address" }),
  ).rejects.toMatchObject({ code: "invalid" });
});
