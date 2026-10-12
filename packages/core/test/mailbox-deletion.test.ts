import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { addMailboxAlias } from "../src/mailbox-aliases.js";
import {
  dueMailboxDeletions,
  MAILBOX_DELETION_GRACE_MS,
  purgeMailboxDeletion,
  requestMailboxDeletion,
  restoreMailboxDeletion,
} from "../src/mailbox-deletion.js";
import { createMailboxFolder, setMailboxItemFolder } from "../src/mailbox-organization.js";
import { importMailboxMime, listMailboxItems } from "../src/mailbox-private-store.js";
import {
  createMailboxRegistry,
  grantMailboxRegistry,
  listMailboxRegistry,
  updateMailboxRegistry,
} from "../src/mailbox-registry.js";
import { MailboxServiceError } from "../src/mailbox-service.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let domainId: string;
let ownerMembership: string;
const keys = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const owner = () => ({ teamId, userId: "owner" });
const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));

const box = async (localPart: string) =>
  (
    await createMailboxRegistry(db, owner(), {
      domainId,
      localPart,
      label: localPart,
      kind: "person",
      ownerUserId: "owner",
    })
  ).id;
const receive = (mailboxId: string, name: string) =>
  importMailboxMime(db, keys, owner(), {
    mailboxId,
    sourceId: `fixture:${name}`,
    raw: Buffer.from(
      [
        `From: ${name}@sender.invalid`,
        "To: box@box.invalid",
        `Subject: ${name}`,
        `Message-ID: <${name}@sender.invalid>`,
        "",
        `Body of ${name}`,
      ].join("\r\n"),
    ),
    history: { kind: "inbox", receivedAt: new Date(), seen: false, archived: false },
  });
const seats = (count: number) =>
  db
    .update(schema.mailboxSubscriptions)
    .set({ seats: count })
    .where(eq(schema.mailboxSubscriptions.teamId, teamId));
/** Moves a pending deletion's deadline into the past (the database clock decides). */
const expire = (id: string) =>
  db.execute(
    sql`update mailboxes set deletion_requested_at = now() - interval '31 days', delete_after = now() - interval '1 minute' where id = ${id}`,
  );
const rows = async (
  table:
    | "mailbox_items"
    | "mailbox_folders"
    | "mailbox_aliases"
    | "mailbox_grants"
    | "mailbox_outbox",
  id: string,
) =>
  Number(
    (
      (await db.execute(
        sql.raw(`select count(*)::int as n from ${table} where mailbox_id = '${id}'`),
      )) as unknown as {
        rows: { n: number }[];
      }
    ).rows[0]?.n ?? 0,
  );

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  for (const file of readdirSync(extension)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + file, "utf8").split(
      "--> statement-breakpoint",
    ))
      if (statement.trim()) await db.execute(sql.raw(statement));
  teamId = await createTeam(db, "deletion-fixture");
  await db.insert(schema.user).values([
    { id: "owner", name: "Owner", email: "owner@example.invalid" },
    { id: "member", name: "Member", email: "member@example.invalid" },
  ]);
  const members = await db
    .insert(schema.teamMembers)
    .values([
      { teamId, userId: "owner", role: "owner" },
      { teamId, userId: "member", role: "member" },
    ])
    .returning();
  ownerMembership = members[0]!.id;
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "box.invalid", region: "us-east-1", status: "verified" })
    .returning();
  domainId = domain!.id;
  const now = Date.now();
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "active",
    seats: 5,
    storageBytesPerMailbox: 50 * 1024 * 1024,
    includedOutboundPerMailbox: 100,
    periodStart: new Date(now - 86400000),
    periodEnd: new Date(now + 29 * 86400000),
  });
});
afterEach(async () => {
  await close();
});

describe("requestMailboxDeletion", () => {
  it("asks for the address, suspends the mailbox and gives 30 days", async () => {
    const id = await box("alpha");
    await addMailboxAlias(db, owner(), { mailboxId: id, localPart: "vendas" });
    await expect(
      requestMailboxDeletion(
        db,
        { teamId, userId: "member" },
        { id, address: "alpha@box.invalid" },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      requestMailboxDeletion(db, owner(), { id, address: "beta@box.invalid" }),
    ).rejects.toMatchObject({ code: "invalid" });
    const now = new Date();
    const result = await requestMailboxDeletion(
      db,
      owner(),
      { id, address: " Alpha@Box.invalid " },
      now,
    );
    expect(result.deleteAfter.getTime() - now.getTime()).toBe(MAILBOX_DELETION_GRACE_MS);
    expect(result.addresses.sort()).toEqual(["alpha@box.invalid", "vendas@box.invalid"]);
    const [row] = await db.select().from(schema.mailboxes).where(eq(schema.mailboxes.id, id));
    expect(row).toMatchObject({
      status: "suspended",
      statusBeforeDeletion: "planned",
      deletionRequestedBy: "owner",
    });
    // Once is enough; and nobody edits it back to active while it is being deleted.
    await expect(
      requestMailboxDeletion(db, owner(), { id, address: "alpha@box.invalid" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      updateMailboxRegistry(db, owner(), {
        id,
        label: "alpha",
        ownerUserId: "owner",
        status: "planned",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const listed = await listMailboxRegistry(db, owner());
    expect(listed.mailboxes.find((m) => m.id === id)).toMatchObject({
      canRead: false,
      canSend: false,
      deleteAfter: result.deleteAfter,
    });
  });
});

describe("seats", () => {
  it("frees the seat at once and will not restore into a full plan", async () => {
    await seats(1);
    const first = await box("alpha");
    await expect(box("beta")).rejects.toBeInstanceOf(MailboxServiceError);
    await requestMailboxDeletion(db, owner(), { id: first, address: "alpha@box.invalid" });
    const second = await box("beta");
    const listed = await listMailboxRegistry(db, owner());
    expect(listed.mailboxes.find((m) => m.id === second)?.canSend).toBe(true);
    await expect(restoreMailboxDeletion(db, owner(), first)).rejects.toMatchObject({
      code: "quota",
    });
    await seats(2);
    await expect(restoreMailboxDeletion(db, owner(), first)).resolves.toMatchObject({
      id: first,
      status: "planned",
    });
    const after = await listMailboxRegistry(db, owner());
    expect(
      after.mailboxes
        .filter((m) => m.canSend)
        .map((m) => m.id)
        .sort(),
    ).toEqual([first, second].sort());
  });
});

describe("restoreMailboxDeletion", () => {
  it("puts the mailbox back as it was, mail included, until the deadline", async () => {
    const id = await box("alpha");
    await receive(id, "kept");
    await updateMailboxRegistry(db, owner(), {
      id,
      label: "alpha",
      ownerUserId: "owner",
      status: "suspended",
    });
    await requestMailboxDeletion(db, owner(), { id, address: "alpha@box.invalid" });
    await expect(restoreMailboxDeletion(db, owner(), id)).resolves.toMatchObject({
      status: "suspended",
    });
    await updateMailboxRegistry(db, owner(), {
      id,
      label: "alpha",
      ownerUserId: "owner",
      status: "planned",
    });
    // The mail it had is still there.
    expect(await listMailboxItems(db, owner(), id)).toHaveLength(1);
    await expect(restoreMailboxDeletion(db, owner(), id)).rejects.toMatchObject({
      code: "conflict",
    });
    await requestMailboxDeletion(db, owner(), { id, address: "alpha@box.invalid" });
    await expire(id);
    await expect(restoreMailboxDeletion(db, owner(), id)).rejects.toMatchObject({
      code: "conflict",
    });
  });
});

describe("purgeMailboxDeletion", () => {
  it("erases everything of a due mailbox, frees its addresses and leaves the others alone", async () => {
    const id = await box("alpha");
    const other = await box("other");
    await addMailboxAlias(db, owner(), { mailboxId: id, localPart: "vendas" });
    await grantMailboxRegistry(db, owner(), {
      mailboxId: id,
      userId: "member",
      permission: "read",
    });
    const folder = await createMailboxFolder(db, owner(), { mailboxId: id, name: "Clientes" });
    const first = await receive(id, "one");
    await receive(id, "two");
    await receive(id, "three");
    await receive(other, "untouched");
    await setMailboxItemFolder(db, owner(), {
      mailboxId: id,
      id: first.id,
      expectedRevision: first.revision,
      folderId: folder.id,
    });
    // A send record from an earlier billing period: no longer anyone's usage.
    const raw = "x";
    await db.insert(schema.mailboxOutbox).values({
      teamId,
      mailboxId: id,
      draftId: first.id,
      draftRevision: 1,
      approvedBy: "owner",
      approvedMembershipId: ownerMembership,
      recipientCount: 1,
      periodStart: new Date(Date.now() - 60 * 86400000),
      periodEnd: new Date(Date.now() - 30 * 86400000),
      rawBytes: 1,
      rawSha256: createHash("sha256").update(raw).digest("hex"),
      status: "accepted",
      providerMessageId: "fixture-provider-id",
      attemptId: randomUUID(),
      attemptedAt: new Date(),
      acceptedAt: new Date(),
    });

    await requestMailboxDeletion(db, owner(), { id, address: "alpha@box.invalid" });
    expect(await dueMailboxDeletions(db)).toEqual([]);
    expect(await purgeMailboxDeletion(db, { id, teamId })).toBe("gone");
    expect(await rows("mailbox_items", id)).toBe(3);

    await expire(id);
    const due = await dueMailboxDeletions(db);
    expect(due).toEqual([
      {
        id,
        teamId,
        addresses: expect.arrayContaining(["alpha@box.invalid", "vendas@box.invalid"]),
      },
    ]);
    // A batch at a time until the deadline, then the rest on the next call.
    expect(await purgeMailboxDeletion(db, { id, teamId }, { batch: 1, deadline: 0 })).toBe(
      "partial",
    );
    expect(await rows("mailbox_items", id)).toBe(2);
    expect(await purgeMailboxDeletion(db, { id, teamId })).toBe("erased");

    for (const table of [
      "mailbox_items",
      "mailbox_folders",
      "mailbox_aliases",
      "mailbox_grants",
      "mailbox_outbox",
    ] as const)
      expect(await rows(table, id)).toBe(0);
    expect(await db.select().from(schema.mailboxes).where(eq(schema.mailboxes.id, id))).toEqual([]);
    expect(await rows("mailbox_items", other)).toBe(1);
    // The address and the alias are free again.
    const again = await box("alpha");
    await addMailboxAlias(db, owner(), { mailboxId: again, localPart: "vendas" });
    expect(await purgeMailboxDeletion(db, { id, teamId })).toBe("gone");
  });

  it("waits for the billing period to turn when the mailbox sent mail in it", async () => {
    const id = await box("alpha");
    const draft = await receive(id, "sent-this-period");
    const [plan] = await db
      .select()
      .from(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    await db.insert(schema.mailboxOutbox).values({
      teamId,
      mailboxId: id,
      draftId: draft.id,
      draftRevision: 1,
      approvedBy: "owner",
      approvedMembershipId: ownerMembership,
      recipientCount: 1,
      periodStart: plan!.periodStart,
      periodEnd: plan!.periodEnd,
      rawBytes: 1,
      rawSha256: createHash("sha256").update("y").digest("hex"),
      status: "accepted",
      providerMessageId: "fixture-provider-id",
      attemptId: randomUUID(),
      attemptedAt: new Date(),
      acceptedAt: new Date(),
    });
    await requestMailboxDeletion(db, owner(), { id, address: "alpha@box.invalid" });
    await expire(id);
    expect(await purgeMailboxDeletion(db, { id, teamId })).toBe("waiting");
    // It does not hold the queue: the worker's due list leaves it out while it waits.
    expect(await dueMailboxDeletions(db)).toEqual([]);
    expect(await rows("mailbox_items", id)).toBe(1);
    // Next period: the record is history and the mailbox goes.
    await db
      .update(schema.mailboxSubscriptions)
      .set({ periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400000) })
      .where(and(eq(schema.mailboxSubscriptions.teamId, teamId)));
    expect(await purgeMailboxDeletion(db, { id, teamId })).toBe("erased");
  });
});
