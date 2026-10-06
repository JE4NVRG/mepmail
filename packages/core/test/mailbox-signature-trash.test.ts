import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MAILBOX_ACTIVITY_ACTIONS } from "../src/audit-actions.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import {
  importMailboxMime,
  listMailboxItems,
  readMailboxItem,
  saveMailboxDraft,
  setMailboxItemTrash,
} from "../src/mailbox-private-store.js";
import {
  createMailboxRegistry,
  grantMailboxRegistry,
  listMailboxRegistry,
  updateMailboxRegistry,
} from "../src/mailbox-registry.js";
import { assertMailboxStorage } from "../src/mailbox-service.js";
import { queueMailboxDraft } from "../src/mailbox-transport.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let mailboxId: string;
let domainId: string;
const keys = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const actor = () => ({ teamId, userId: "owner" });
const raw = Buffer.from(
  "From: sender@example.invalid\r\nTo: owner@box.invalid\r\nMessage-ID: <inbound@example.invalid>\r\nSubject: Fixture\r\n\r\nPrivate synthetic fixture",
);
const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
const imported = () =>
  importMailboxMime(db, keys, actor(), { mailboxId, sourceId: "fixture:inbound", raw });
const trash = (id: string, expectedRevision: number, trashed = true) =>
  setMailboxItemTrash(db, actor(), { mailboxId, id, expectedRevision, trashed });

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  for (const name of readdirSync(extension)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + name, "utf8").split(
      "--> statement-breakpoint",
    ))
      if (statement.trim()) await db.execute(sql.raw(statement));
  teamId = await createTeam(db, "signature-trash-fixture");
  await db.insert(schema.user).values([
    { id: "owner", name: "Owner", email: "owner@example.invalid" },
    { id: "delegate", name: "Delegate", email: "delegate@example.invalid" },
  ]);
  await db.insert(schema.teamMembers).values([
    { teamId, userId: "owner", role: "owner" },
    { teamId, userId: "delegate", role: "member" },
  ]);
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "box.invalid", region: "us-east-1", status: "verified" })
    .returning();
  domainId = domain!.id;
  const now = Date.now();
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "active",
    seats: 10,
    storageBytesPerMailbox: 5 * 1024 * 1024,
    includedOutboundPerMailbox: 100,
    periodStart: new Date(now - 86400000),
    periodEnd: new Date(now + 86400000),
  });
  mailboxId = (
    await createMailboxRegistry(db, actor(), {
      domainId,
      localPart: "owner",
      label: "Owner",
      kind: "person",
      ownerUserId: "owner",
    })
  ).id;
});
afterEach(async () => {
  await close();
});

it("stores multiline signatures per box, preserves omitted updates and permits explicit removal", async () => {
  const update = {
    id: mailboxId,
    label: "Owner",
    ownerUserId: "owner",
    status: "planned" as const,
  };
  await updateMailboxRegistry(db, actor(), {
    ...update,
    signatureText: "Jean\r\nMepMail\rSuporte",
  });
  await updateMailboxRegistry(db, actor(), update);
  expect((await listMailboxRegistry(db, actor())).mailboxes[0]!.signatureText).toBe(
    "Jean\nMepMail\nSuporte",
  );
  await expect(
    updateMailboxRegistry(db, actor(), { ...update, signatureText: "x".repeat(4001) }),
  ).rejects.toMatchObject({ code: "invalid" });
  await expect(
    updateMailboxRegistry(db, actor(), { ...update, signatureText: "bad\u0000text" }),
  ).rejects.toMatchObject({ code: "invalid" });
  await expect(
    updateMailboxRegistry(
      db,
      { teamId, userId: "delegate" },
      { ...update, signatureText: "forged" },
    ),
  ).rejects.toMatchObject({ code: "forbidden" });
  await updateMailboxRegistry(db, actor(), { ...update, signatureText: "" });
  expect((await listMailboxRegistry(db, actor())).mailboxes[0]!.signatureText).toBe("");
});

it("soft-trashes and restores the original folder while retaining ciphertext and charged storage", async () => {
  const item = await imported();
  const [before] = await db
    .select()
    .from(schema.mailboxItems)
    .where(eq(schema.mailboxItems.id, item.id));
  const moved = await trash(item.id, 1);
  expect(moved).toMatchObject({
    kind: "inbox",
    deliveryFolder: "inbox",
    revision: 2,
    changed: true,
  });
  expect(moved.trashedAt).toBeInstanceOf(Date);
  const [plan] = await db
    .select()
    .from(schema.mailboxSubscriptions)
    .where(eq(schema.mailboxSubscriptions.teamId, teamId));
  await expect(
    assertMailboxStorage(
      db,
      teamId,
      mailboxId,
      plan!.storageBytesPerMailbox - raw.length + 1,
      plan!,
    ),
  ).rejects.toMatchObject({ code: "quota" });
  expect(await listMailboxItems(db, actor(), mailboxId)).toHaveLength(0);
  expect(await listMailboxItems(db, actor(), mailboxId, { trashed: true })).toHaveLength(1);
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
  await expect(trash(item.id, 1, false)).rejects.toMatchObject({ code: "conflict" });
  expect(await trash(item.id, 2, false)).toMatchObject({
    trashedAt: null,
    revision: 3,
    changed: true,
  });
  expect(await trash(item.id, 3, false)).toMatchObject({ revision: 3, changed: false });
});

it("keeps human ownership and agent restrictions on soft trash and trash reads", async () => {
  const item = await imported();
  await grantMailboxRegistry(db, actor(), { mailboxId, userId: "delegate", permission: "draft" });
  for (const denied of [
    { teamId, userId: "delegate" },
    { ...actor(), supportView: true },
    { ...actor(), agentAccess: true },
  ])
    await expect(
      setMailboxItemTrash(db, denied, {
        mailboxId,
        id: item.id,
        expectedRevision: 1,
        trashed: true,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  await trash(item.id, 1);
  await expect(
    readMailboxItem(db, keys, { ...actor(), agentAccess: true }, { mailboxId, id: item.id }),
  ).rejects.toMatchObject({ code: "forbidden" });
  await expect(
    listMailboxItems(db, { ...actor(), agentAccess: true }, mailboxId, { trashed: true }),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(await listMailboxItems(db, { ...actor(), agentAccess: true }, mailboxId)).toHaveLength(0);
});

it("never releases quarantined content when moving to or restoring from trash", async () => {
  const item = await imported();
  const assessment = {
    version: 1 as const,
    decision: "quarantine" as const,
    verdicts: {
      virus: "FAIL" as const,
      spam: "PASS" as const,
      spf: "PASS" as const,
      dkim: "PASS" as const,
      dmarc: "PASS" as const,
    },
    dmarcPolicy: null,
    reasons: ["virus" as const],
  };
  await db
    .update(schema.mailboxItems)
    .set({ deliveryFolder: "quarantine", inboundAssessment: assessment })
    .where(eq(schema.mailboxItems.id, item.id));
  await trash(item.id, 1);
  await expect(
    readMailboxItem(db, keys, actor(), { mailboxId, id: item.id }),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(await trash(item.id, 2, false)).toMatchObject({
    deliveryFolder: "quarantine",
    inboundAssessment: assessment,
    trashedAt: null,
  });
  await expect(
    readMailboxItem(db, keys, actor(), { mailboxId, id: item.id }),
  ).rejects.toMatchObject({ code: "forbidden" });
});

it("blocks saving and newly approving a trashed draft until restoration", async () => {
  const item = await saveMailboxDraft(db, keys, actor(), { mailboxId, expectedRevision: 0, raw });
  await trash(item.id, 1);
  await expect(
    saveMailboxDraft(db, keys, actor(), { mailboxId, id: item.id, expectedRevision: 2, raw }),
  ).rejects.toMatchObject({ code: "conflict" });
  const parse = async () => ({
    from: "owner@box.invalid",
    to: ["to@example.invalid"],
    attachmentBytes: [],
  });
  await expect(
    queueMailboxDraft(
      db,
      keys,
      actor(),
      { mailboxId, id: item.id, expectedRevision: 2 },
      { parse },
    ),
  ).rejects.toMatchObject({ code: "conflict" });
  await trash(item.id, 2, false);
  expect(
    await saveMailboxDraft(db, keys, actor(), { mailboxId, id: item.id, expectedRevision: 3, raw }),
  ).toMatchObject({ revision: 4 });
});

it("does not hide an already approved pending draft or alter its reservation", async () => {
  const item = await saveMailboxDraft(db, keys, actor(), { mailboxId, expectedRevision: 0, raw });
  const parse = async () => ({
    from: "owner@box.invalid",
    to: ["to@example.invalid"],
    attachmentBytes: [],
  });
  const pending = await queueMailboxDraft(
    db,
    keys,
    actor(),
    { mailboxId, id: item.id, expectedRevision: 1 },
    { parse },
  );
  const [before] = await db
    .select()
    .from(schema.mailboxOutbox)
    .where(eq(schema.mailboxOutbox.id, pending.id));
  await expect(trash(item.id, 1)).rejects.toMatchObject({ code: "conflict" });
  const [after] = await db
    .select()
    .from(schema.mailboxOutbox)
    .where(eq(schema.mailboxOutbox.id, pending.id));
  expect(after).toEqual(before);
  expect(
    (await listMailboxItems(db, actor(), mailboxId, { kind: "draft" }))[0]!.trashedAt,
  ).toBeNull();
});

it("retains trash and restore in the private activity exclusion list", () => {
  expect(MAILBOX_ACTIVITY_ACTIONS).toContain("mailbox.item_trashed");
  expect(MAILBOX_ACTIVITY_ACTIONS).toContain("mailbox.item_restored");
});
