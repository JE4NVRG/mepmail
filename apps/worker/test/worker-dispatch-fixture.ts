import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertMailboxOutboxSendAccess,
  EnvKeyring,
  type MailboxOutboxSender,
  queueMailboxDraft,
  saveMailboxDraft,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";

type Input = Parameters<MailboxOutboxSender["send"]>[0];
const keys = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));

export async function installWorkerMailboxSchema(db: Db) {
  const root = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
  const client = (
    db as unknown as {
      $client: {
        transaction: (
          fn: (tx: { exec: (sql: string) => Promise<unknown> }) => Promise<void>,
        ) => Promise<void>;
      };
    }
  ).$client;
  for (const name of readdirSync(root)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    await client.transaction(async (tx) => {
      for (const statement of readFileSync(root + name, "utf8").split("--> statement-breakpoint"))
        if (statement.trim()) await tx.exec(statement);
    });
}

/** Real synthetic SQL authority, not a replacement for the production access gate.
 * Build the durable draft/outbox through the imported core callers, then capture
 * its sending attempt. Content and recipients remain the test's original bytes.
 */
export async function authorizeWorkerDispatch(db: Db, input: Input): Promise<Input> {
  const [risk] = await db
    .select()
    .from(schema.teamSignupRisk)
    .where(eq(schema.teamSignupRisk.teamId, input.teamId));
  const [owner] = await db
    .select()
    .from(schema.teamMembers)
    .where(and(eq(schema.teamMembers.teamId, input.teamId), eq(schema.teamMembers.role, "owner")));
  const userId = risk?.principalUserId ?? owner?.userId ?? randomUUID();
  await db
    .insert(schema.user)
    .values({
      id: userId,
      name: "Synthetic dispatch owner",
      email: `${userId}@example.invalid`,
      emailVerified: true,
    })
    .onConflictDoNothing();
  let [member] = await db
    .select()
    .from(schema.teamMembers)
    .where(and(eq(schema.teamMembers.teamId, input.teamId), eq(schema.teamMembers.userId, userId)));
  if (!member)
    [member] = await db
      .insert(schema.teamMembers)
      .values({ teamId: input.teamId, userId, role: "owner" })
      .returning();
  if (!member) throw new Error("synthetic dispatch membership missing");
  let [box] = await db
    .select()
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.id, input.mailboxId));
  if (!box) {
    [box] = await db
      .select()
      .from(schema.mailboxes)
      .where(
        and(eq(schema.mailboxes.teamId, input.teamId), eq(schema.mailboxes.address, input.from)),
      );
    if (box) input.mailboxId = box.id;
  }
  if (!box) {
    const name = input.from.slice(input.from.lastIndexOf("@") + 1);
    let [domain] = await db
      .select()
      .from(schema.domains)
      .where(and(eq(schema.domains.teamId, input.teamId), eq(schema.domains.name, name)));
    if (!domain)
      [domain] = await db
        .insert(schema.domains)
        .values({
          teamId: input.teamId,
          name,
          status: "verified",
          region: "us-east-1",
          relayEnabledAt: new Date(),
        })
        .returning();
    if (!domain) throw new Error("synthetic dispatch domain missing");
    [box] = await db
      .insert(schema.mailboxes)
      .values({
        id: input.mailboxId,
        teamId: input.teamId,
        domainId: domain.id,
        address: input.from,
        label: "Synthetic",
        kind: "person",
        ownerUserId: userId,
        ownerMembershipId: member.id,
      })
      .returning();
  }
  if (!box || box.teamId !== input.teamId || box.address !== input.from || !box.domainId)
    throw new Error("synthetic dispatch scope mismatch");
  await db
    .update(schema.mailboxes)
    .set({ ownerUserId: userId, ownerMembershipId: member.id })
    .where(eq(schema.mailboxes.id, box.id));
  await db
    .update(schema.domains)
    .set({ relayEnabledAt: new Date() })
    .where(and(eq(schema.domains.id, box.domainId), eq(schema.domains.teamId, input.teamId)));
  const start = new Date(Date.now() - 86400000),
    end = new Date(Date.now() + 86400000);
  await db
    .insert(schema.mailboxSubscriptions)
    .values({
      teamId: input.teamId,
      status: "active",
      seats: 2,
      storageBytesPerMailbox: 10485760,
      includedOutboundPerMailbox: 1000,
      periodStart: start,
      periodEnd: end,
    })
    .onConflictDoNothing();
  const actor = { teamId: input.teamId, userId };
  const draft = await saveMailboxDraft(db, keys, actor, {
    mailboxId: input.mailboxId,
    expectedRevision: 0,
    raw: input.raw,
  });
  const queued = await queueMailboxDraft(
    db,
    keys,
    actor,
    { mailboxId: input.mailboxId, id: draft.id, expectedRevision: draft.revision },
    {
      async parse() {
        return {
          from: input.from,
          to: [...input.to],
          cc: [...input.cc],
          bcc: [...input.bcc],
          attachmentBytes: [],
        };
      },
    },
  );
  const attemptId = randomUUID();
  await db
    .update(schema.mailboxOutbox)
    .set({ status: "sending", attemptId, attemptedAt: new Date() })
    .where(eq(schema.mailboxOutbox.id, queued.id));
  input.idempotencyKey = queued.id;
  input.outboxId = queued.id;
  input.attemptId = attemptId;
  // Fail setup at the actual authority boundary, not at a later content assertion.
  await assertMailboxOutboxSendAccess(db, input);
  return input;
}

/** Confirmed current-window messages, not fabricated health summaries. */
export async function seedWorkerConfirmedHistory(db: Db, teamId: string, from: string) {
  const at = new Date(Date.now() - 60000);
  await db.insert(schema.emails).values(
    Array.from({ length: 1000 }, () => ({
      teamId,
      from,
      to: ["history@example.invalid"],
      subject: "Synthetic confirmed history",
      createdAt: at,
      sentAt: at,
      sesMessageId: `synthetic-history-${randomUUID()}`,
    })),
  );
}
