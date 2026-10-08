import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MAILBOX_ACTIVITY_ACTIONS } from "../src/audit-actions.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import {
  archiveMailboxFolder,
  createMailboxFolder,
  listMailboxFolders,
  setMailboxItemArchive,
  setMailboxItemFolder,
  setMailboxItemSeen,
  setMailboxItemStar,
  updateMailboxFolder,
} from "../src/mailbox-organization.js";
import {
  countUnreadMailboxItems,
  importMailboxMime,
  listMailboxItems,
  readMailboxItem,
  saveMailboxDraft,
  setMailboxDeliveryFolder,
  setMailboxItemTrash,
} from "../src/mailbox-private-store.js";
import { createMailboxRegistry, grantMailboxRegistry } from "../src/mailbox-registry.js";
import { queueMailboxDraft } from "../src/mailbox-transport.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let foreignTeamId: string;
let mailboxId: string;
let agentBoxId: string;
let foreignBoxId: string;
const keys = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const actor = () => ({ teamId, userId: "owner" });
const raw = Buffer.from(
  "From: owner@box.invalid\r\nTo: receiver@example.invalid\r\nSubject: Synthetic organization\r\n\r\nPrivate bytes",
);
const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
const imported = () =>
  importMailboxMime(db, keys, actor(), { mailboxId, sourceId: "fixture:organization", raw });
const create = (name: string, box = mailboxId) =>
  createMailboxFolder(db, actor(), { mailboxId: box, name });
const star = (id: string, expectedRevision: number, starred = true) =>
  setMailboxItemStar(db, actor(), { mailboxId, id, expectedRevision, starred });
const move = (id: string, expectedRevision: number, folderId: string | null) =>
  setMailboxItemFolder(db, actor(), { mailboxId, id, expectedRevision, folderId });
const archive = (id: string, expectedRevision: number, archived = true) =>
  setMailboxItemArchive(db, actor(), { mailboxId, id, expectedRevision, archived });
const seen = (id: string, value: boolean, who = actor()) =>
  setMailboxItemSeen(db, who, { mailboxId, id, seen: value });
const unread = () => countUnreadMailboxItems(db, actor(), mailboxId);
const stored = async (id: string) =>
  (await db.select().from(schema.mailboxItems).where(eq(schema.mailboxItems.id, id)))[0]!;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  for (const file of readdirSync(extension)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + file, "utf8").split(
      "--> statement-breakpoint",
    ))
      if (statement.trim()) await db.execute(sql.raw(statement));
  teamId = await createTeam(db, "organization-fixture");
  foreignTeamId = await createTeam(db, "organization-foreign");
  await db.insert(schema.user).values([
    { id: "owner", name: "Owner", email: "owner@example.invalid" },
    { id: "delegate", name: "Delegate", email: "delegate@example.invalid" },
    { id: "outsider", name: "Outsider", email: "outsider@example.invalid" },
  ]);
  await db.insert(schema.teamMembers).values([
    { teamId, userId: "owner", role: "owner" },
    { teamId, userId: "delegate", role: "admin" },
    { teamId: foreignTeamId, userId: "outsider", role: "owner" },
  ]);
  const domains = await db
    .insert(schema.domains)
    .values([
      { teamId, name: "box.invalid", region: "us-east-1", status: "verified" },
      { teamId: foreignTeamId, name: "foreign.invalid", region: "us-east-1", status: "verified" },
    ])
    .returning();
  const now = Date.now();
  for (const id of [teamId, foreignTeamId])
    await db.insert(schema.mailboxSubscriptions).values({
      teamId: id,
      status: "active",
      seats: 10,
      storageBytesPerMailbox: 5 * 1024 * 1024,
      includedOutboundPerMailbox: 100,
      periodStart: new Date(now - 86400000),
      periodEnd: new Date(now + 86400000),
    });
  const box = (localPart: string, kind: "person" | "agent") =>
    createMailboxRegistry(db, actor(), {
      domainId: domains[0]!.id,
      localPart,
      label: localPart,
      kind,
      ownerUserId: "owner",
    });
  mailboxId = (await box("owner", "person")).id;
  agentBoxId = (await box("agent", "agent")).id;
  foreignBoxId = (
    await createMailboxRegistry(
      db,
      { teamId: foreignTeamId, userId: "outsider" },
      {
        domainId: domains[1]!.id,
        localPart: "foreign",
        label: "Foreign",
        kind: "person",
        ownerUserId: "outsider",
      },
    )
  ).id;
});
afterEach(async () => {
  await close();
});

it("persists names per box, case-insensitive uniqueness, rename CAS, and archived history", async () => {
  const folder = await create("  Leads   Luna  ");
  expect(folder).toMatchObject({ name: "Leads Luna", revision: 1, archivedAt: null });
  await expect(create("leads luna")).rejects.toMatchObject({ code: "conflict" });
  expect((await create("Leads Luna", agentBoxId)).name).toBe("Leads Luna");
  const renamed = await updateMailboxFolder(db, actor(), {
    mailboxId,
    id: folder.id,
    expectedRevision: 1,
    name: "Respondidos",
  });
  expect(renamed).toMatchObject({ name: "Respondidos", revision: 2 });
  await expect(
    updateMailboxFolder(db, actor(), {
      mailboxId,
      id: folder.id,
      expectedRevision: 1,
      name: "Stale",
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  await archiveMailboxFolder(db, actor(), { mailboxId, id: folder.id, expectedRevision: 2 });
  expect(await listMailboxFolders(db, actor(), { mailboxId })).toEqual([]);
  const [retained] = await db
    .select()
    .from(schema.mailboxFolders)
    .where(eq(schema.mailboxFolders.id, folder.id));
  expect(retained!.archivedAt).toBeInstanceOf(Date);
  expect((await create("Respondidos")).id).not.toBe(folder.id);
  for (const invalid of ["   ", "x".repeat(81), "bad\u0000name", "bad\nname"])
    await expect(create(invalid)).rejects.toMatchObject({ code: "invalid" });
});

it("rechecks private ACL for folder names and owner authority for organization", async () => {
  const folder = await create("Private leads");
  const item = await imported();
  await expect(
    listMailboxFolders(db, { teamId, userId: "delegate" }, { mailboxId }),
  ).rejects.toMatchObject({ code: "forbidden" });
  await grantMailboxRegistry(db, actor(), { mailboxId, userId: "delegate", permission: "draft" });
  expect((await listMailboxFolders(db, { teamId, userId: "delegate" }, { mailboxId }))[0]!.id).toBe(
    folder.id,
  );
  for (const denied of [
    { teamId, userId: "delegate" },
    { ...actor(), supportView: true },
    { ...actor(), agentAccess: true },
    { teamId: foreignTeamId, userId: "outsider" },
  ]) {
    await expect(
      createMailboxFolder(db, denied, { mailboxId, name: "Forged" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      setMailboxItemStar(db, denied, {
        mailboxId,
        id: item.id,
        expectedRevision: 1,
        starred: true,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      setMailboxItemFolder(db, denied, {
        mailboxId,
        id: item.id,
        expectedRevision: 1,
        folderId: folder.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  }
  await expect(listMailboxFolders(db, actor(), { mailboxId: foreignBoxId })).rejects.toMatchObject({
    code: "forbidden",
  });
});

it("protects message revisions and encrypted content while starring and moving", async () => {
  const item = await imported();
  const [before] = await db
    .select()
    .from(schema.mailboxItems)
    .where(eq(schema.mailboxItems.id, item.id));
  const folder = await create("Leads");
  expect(await star(item.id, 1)).toMatchObject({ revision: 2, changed: true });
  expect(await star(item.id, 2)).toMatchObject({ revision: 2, changed: false });
  await expect(move(item.id, 1, folder.id)).rejects.toMatchObject({ code: "conflict" });
  expect(await move(item.id, 2, folder.id)).toMatchObject({ revision: 3, folderId: folder.id });
  expect(await listMailboxItems(db, actor(), mailboxId, { folderId: null })).toHaveLength(0);
  expect(
    await listMailboxItems(db, actor(), mailboxId, { folderId: folder.id, safeOnly: true }),
  ).toHaveLength(1);
  expect(
    await listMailboxItems(db, actor(), mailboxId, { starred: true, safeOnly: true }),
  ).toHaveLength(1);
  const [after] = await db
    .select()
    .from(schema.mailboxItems)
    .where(eq(schema.mailboxItems.id, item.id));
  for (const field of [
    "ciphertext",
    "iv",
    "wrappedDek",
    "keyVersion",
    "rawBytes",
    "kind",
    "deliveryFolder",
    "sourceId",
  ] as const)
    expect(after![field]).toEqual(before![field]);
  expect((await readMailboxItem(db, keys, actor(), { mailboxId, id: item.id })).raw).toEqual(raw);
  expect(await star(item.id, 3, false)).toMatchObject({ starredAt: null, revision: 4 });
  expect(await move(item.id, 4, null)).toMatchObject({ folderId: null, revision: 5 });
});

it("keeps read state off the revision, list order and content, and counts the unread inbox", async () => {
  const item = await imported();
  const before = await stored(item.id);
  expect(before.seenAt).toBeNull();
  expect(await unread()).toBe(1);
  const read = await seen(item.id, true);
  expect(read).toMatchObject({ revision: 1, changed: true });
  expect(read.seenAt).toBeInstanceOf(Date);
  expect(await seen(item.id, true)).toMatchObject({ changed: false });
  const after = await stored(item.id);
  expect(after).toMatchObject({ revision: before.revision, updatedAt: before.updatedAt });
  expect(after.ciphertext).toEqual(before.ciphertext);
  expect(await unread()).toBe(0);
  expect(await seen(item.id, false)).toMatchObject({ seenAt: null, changed: true });
  expect(await unread()).toBe(1);
  // A star still works on the same revision afterwards: read state never conflicts.
  expect(await star(item.id, 1)).toMatchObject({ revision: 2, changed: true });
  for (const denied of [
    { teamId, userId: "delegate" },
    { ...actor(), agentAccess: true },
    { ...actor(), supportView: true },
    { teamId: foreignTeamId, userId: "outsider" },
  ])
    await expect(seen(item.id, true, denied)).rejects.toMatchObject({ code: "forbidden" });
  const draft = await saveMailboxDraft(db, keys, actor(), { mailboxId, expectedRevision: 0, raw });
  await expect(seen(draft.id, true)).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    countUnreadMailboxItems(db, { teamId: foreignTeamId, userId: "outsider" }, mailboxId),
  ).rejects.toMatchObject({ code: "forbidden" });
});

it("archives out of the inbox and named folders and back, never drafts or Trash", async () => {
  const item = await imported();
  const folder = await create("Leads");
  expect(await move(item.id, 1, folder.id)).toMatchObject({ folderId: folder.id, revision: 2 });
  const archived = await archive(item.id, 2);
  expect(archived).toMatchObject({ folderId: null, revision: 3, changed: true });
  expect(archived.archivedAt).toBeInstanceOf(Date);
  expect(await archive(item.id, 3)).toMatchObject({ changed: false });
  await expect(archive(item.id, 2, false)).rejects.toMatchObject({ code: "conflict" });
  expect(
    await listMailboxItems(db, actor(), mailboxId, { folderId: null, archived: false }),
  ).toHaveLength(0);
  expect(
    await listMailboxItems(db, actor(), mailboxId, { archived: true, safeOnly: true }),
  ).toHaveLength(1);
  expect(await unread()).toBe(0);
  expect(await archive(item.id, 3, false)).toMatchObject({ archivedAt: null, revision: 4 });
  expect(await unread()).toBe(1);
  // Filing an archived message takes it out of the archive, into the folder.
  await archive(item.id, 4);
  expect(await move(item.id, 5, folder.id)).toMatchObject({
    archivedAt: null,
    folderId: folder.id,
  });
  await setMailboxItemTrash(db, actor(), {
    mailboxId,
    id: item.id,
    expectedRevision: 6,
    trashed: true,
  });
  await expect(archive(item.id, 7)).rejects.toMatchObject({ code: "forbidden" });
  const draft = await saveMailboxDraft(db, keys, actor(), { mailboxId, expectedRevision: 0, raw });
  await expect(archive(draft.id, 1)).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    setMailboxItemArchive(
      db,
      { teamId, userId: "delegate" },
      {
        mailboxId,
        id: item.id,
        expectedRevision: 7,
        archived: false,
      },
    ),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect((await readMailboxItem(db, keys, actor(), { mailboxId, id: item.id })).raw).toEqual(raw);
});

it("rejects folder IDs from another box or team, including at the composite foreign key", async () => {
  const item = await imported();
  const otherFolder = await create("Other agent", agentBoxId);
  const foreignFolder = await createMailboxFolder(
    db,
    { teamId: foreignTeamId, userId: "outsider" },
    { mailboxId: foreignBoxId, name: "Foreign" },
  );
  for (const folderId of [otherFolder.id, foreignFolder.id]) {
    await expect(move(item.id, 1, folderId)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      db.update(schema.mailboxItems).set({ folderId }).where(eq(schema.mailboxItems.id, item.id)),
    ).rejects.toThrow();
  }
});

it("archives without deleting messages, retaining favorites, Trash and original classification", async () => {
  const item = await imported();
  const folder = await create("Leads");
  await star(item.id, 1);
  await move(item.id, 2, folder.id);
  await setMailboxItemTrash(db, actor(), {
    mailboxId,
    id: item.id,
    expectedRevision: 3,
    trashed: true,
  });
  await archiveMailboxFolder(db, actor(), { mailboxId, id: folder.id, expectedRevision: 1 });
  const [retained] = await db
    .select()
    .from(schema.mailboxItems)
    .where(eq(schema.mailboxItems.id, item.id));
  expect(retained).toMatchObject({
    folderId: null,
    kind: "inbox",
    deliveryFolder: "inbox",
    revision: 5,
  });
  expect(retained!.starredAt).toBeInstanceOf(Date);
  expect(retained!.trashedAt).toBeInstanceOf(Date);
  await setMailboxItemTrash(db, actor(), {
    mailboxId,
    id: item.id,
    expectedRevision: 5,
    trashed: false,
  });
  expect(await listMailboxItems(db, actor(), mailboxId, { folderId: null })).toHaveLength(1);
  expect((await readMailboxItem(db, keys, actor(), { mailboxId, id: item.id })).raw).toEqual(raw);
});

it("never exposes Spam, quarantine or Trash through favorites and custom folders", async () => {
  const item = await imported();
  const folder = await create("Leads");
  await star(item.id, 1);
  await move(item.id, 2, folder.id);
  await setMailboxDeliveryFolder(db, actor(), {
    mailboxId,
    id: item.id,
    expectedRevision: 3,
    folder: "spam",
  });
  expect(
    await listMailboxItems(db, actor(), mailboxId, { starred: true, safeOnly: true }),
  ).toHaveLength(0);
  expect(
    await listMailboxItems(db, actor(), mailboxId, { folderId: folder.id, safeOnly: true }),
  ).toHaveLength(0);
  await expect(star(item.id, 4, false)).rejects.toMatchObject({ code: "forbidden" });
  await setMailboxDeliveryFolder(db, actor(), {
    mailboxId,
    id: item.id,
    expectedRevision: 4,
    folder: "inbox",
  });
  await setMailboxItemTrash(db, actor(), {
    mailboxId,
    id: item.id,
    expectedRevision: 5,
    trashed: true,
  });
  expect(
    await listMailboxItems(db, actor(), mailboxId, { starred: true, safeOnly: true }),
  ).toHaveLength(0);
  await expect(move(item.id, 6, null)).rejects.toMatchObject({ code: "forbidden" });
  await setMailboxItemTrash(db, actor(), {
    mailboxId,
    id: item.id,
    expectedRevision: 6,
    trashed: false,
  });
  await db
    .update(schema.mailboxItems)
    .set({
      deliveryFolder: "quarantine",
      inboundAssessment: {
        version: 1,
        decision: "quarantine",
        verdicts: { virus: "FAIL", spam: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" },
        dmarcPolicy: null,
        reasons: ["virus"],
      },
    })
    .where(eq(schema.mailboxItems.id, item.id));
  expect(
    await listMailboxItems(db, actor(), mailboxId, { starred: true, safeOnly: true }),
  ).toHaveLength(0);
  await expect(star(item.id, 7, false)).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    readMailboxItem(db, keys, actor(), { mailboxId, id: item.id }),
  ).rejects.toMatchObject({ code: "forbidden" });
});

it("does not change an approved draft revision or allow its organization to enable duplicate send", async () => {
  const item = await saveMailboxDraft(db, keys, actor(), { mailboxId, expectedRevision: 0, raw });
  const folder = await create("Prepared");
  await move(item.id, 1, folder.id);
  const queued = await queueMailboxDraft(
    db,
    keys,
    actor(),
    { mailboxId, id: item.id, expectedRevision: 2 },
    {
      parse: async () => ({
        from: "owner@box.invalid",
        to: ["receiver@example.invalid"],
        attachmentBytes: [],
      }),
    },
  );
  for (const status of ["queued", "sending", "unknown", "accepted"] as const) {
    await db
      .update(schema.mailboxOutbox)
      .set({
        status,
        ...(status === "queued" ? {} : { attemptId: randomUUID(), attemptedAt: new Date() }),
        ...(status === "accepted"
          ? {
              ciphertext: null,
              iv: null,
              wrappedDek: null,
              keyVersion: null,
              providerMessageId: "synthetic-provider-accepted",
              acceptedAt: new Date(),
            }
          : {}),
      })
      .where(eq(schema.mailboxOutbox.id, queued.id));
    await expect(star(item.id, 2)).rejects.toMatchObject({ code: "conflict" });
    await expect(move(item.id, 2, null)).rejects.toMatchObject({ code: "conflict" });
    await expect(
      archiveMailboxFolder(db, actor(), { mailboxId, id: folder.id, expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      setMailboxItemTrash(db, actor(), {
        mailboxId,
        id: item.id,
        expectedRevision: 2,
        trashed: true,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  }
  const [retained] = await db
    .select()
    .from(schema.mailboxItems)
    .where(eq(schema.mailboxItems.id, item.id));
  expect(retained).toMatchObject({
    revision: 2,
    folderId: folder.id,
    starredAt: null,
    trashedAt: null,
  });
  // Previous releases allowed moving accepted drafts to Trash. Restoring that
  // retained legacy state must not create a fresh revision eligible for resend.
  const legacyTrashTime = new Date();
  await db
    .update(schema.mailboxItems)
    .set({ trashedAt: legacyTrashTime, revision: 3 })
    .where(eq(schema.mailboxItems.id, item.id));
  await expect(
    setMailboxItemTrash(db, actor(), {
      mailboxId,
      id: item.id,
      expectedRevision: 3,
      trashed: false,
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(
    queueMailboxDraft(
      db,
      keys,
      actor(),
      { mailboxId, id: item.id, expectedRevision: 3 },
      {
        parse: async () => ({
          from: "owner@box.invalid",
          to: ["receiver@example.invalid"],
          attachmentBytes: [],
        }),
      },
    ),
  ).rejects.toMatchObject({ code: "conflict" });
  const [legacyRetained] = await db
    .select()
    .from(schema.mailboxItems)
    .where(eq(schema.mailboxItems.id, item.id));
  expect(legacyRetained).toMatchObject({
    revision: 3,
    trashedAt: legacyTrashTime,
    folderId: folder.id,
  });
});

it("keeps organization activity out of general audit feeds", () => {
  for (const action of [
    "mailbox.item_starred",
    "mailbox.item_unstarred",
    "mailbox.item_archived",
    "mailbox.item_unarchived",
    "mailbox.item_folder_changed",
    "mailbox.folder_created",
    "mailbox.folder_renamed",
    "mailbox.folder_archived",
  ])
    expect(MAILBOX_ACTIVITY_ACTIONS).toContain(action);
});
