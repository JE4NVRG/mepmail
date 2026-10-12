import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvKeyring } from "../src/crypto/keyring.js";
import {
  appendMailboxImapMessage,
  listMailboxImapFolders,
  moveMailboxImapMessages,
  readMailboxImapMessages,
  resolveMailboxImapFolder,
  setMailboxImapFlags,
  syncMailboxImapFolder,
} from "../src/mailbox-imap.js";
import { createMailboxFolder } from "../src/mailbox-organization.js";
import { importMailboxMime } from "../src/mailbox-private-store.js";
import { createMailboxRegistry } from "../src/mailbox-registry.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let mailboxId: string;
const keys = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const owner = () => ({ teamId, userId: "owner" });
const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
const mime = (name: string) =>
  Buffer.from(
    [
      `From: ${name}@sender.invalid`,
      "To: jean@box.invalid",
      `Subject: ${name}`,
      `Message-ID: <${name}@sender.invalid>`,
      "",
      `Body of ${name}`,
    ].join("\r\n"),
  );
let minute = 0;
const receive = (name: string) =>
  importMailboxMime(db, keys, owner(), {
    mailboxId,
    sourceId: `fixture:${name}`,
    raw: mime(name),
    history: {
      kind: "inbox",
      receivedAt: new Date(Date.UTC(2026, 9, 1, 12, minute++)),
      seen: false,
      archived: false,
    },
  });
const uids = async (key: Parameters<typeof syncMailboxImapFolder>[3]) =>
  (await syncMailboxImapFolder(db, owner(), mailboxId, key)).messages.map((m) => m.uid);

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  for (const file of readdirSync(extension)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + file, "utf8").split(
      "--> statement-breakpoint",
    ))
      if (statement.trim()) await db.execute(sql.raw(statement));
  teamId = await createTeam(db, "imap-fixture");
  await db.insert(schema.user).values({ id: "owner", name: "Owner", email: "o@example.invalid" });
  await db.insert(schema.teamMembers).values({ teamId, userId: "owner", role: "owner" });
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "box.invalid", region: "us-east-1", status: "verified" })
    .returning();
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "active",
    seats: 3,
    storageBytesPerMailbox: 50 * 1024 * 1024,
    includedOutboundPerMailbox: 100,
    periodStart: new Date(Date.now() - 86400000),
    periodEnd: new Date(Date.now() + 29 * 86400000),
  });
  mailboxId = (
    await createMailboxRegistry(db, owner(), {
      domainId: domain!.id,
      localPart: "jean",
      label: "Jean",
      kind: "person",
      ownerUserId: "owner",
    })
  ).id;
  minute = 0;
});
afterEach(async () => {
  await close();
});

describe("IMAP folders", () => {
  it("are the Correio's views plus the owner's folders, found by common names too", async () => {
    await createMailboxFolder(db, owner(), { mailboxId, name: "Clientes/2026" });
    await createMailboxFolder(db, owner(), { mailboxId, name: "Trash" });
    const folders = await listMailboxImapFolders(db, owner(), mailboxId);
    expect(folders.map((f) => [f.path, f.specialUse])).toEqual([
      ["INBOX", null],
      ["Sent", "\\Sent"],
      ["Drafts", "\\Drafts"],
      ["Archive", "\\Archive"],
      ["Junk", "\\Junk"],
      ["Trash", "\\Trash"],
      ["Clientes-2026", null],
      ["Trash (2)", null],
    ]);
    expect(resolveMailboxImapFolder(folders, "inbox")?.key).toBe("inbox");
    expect(resolveMailboxImapFolder(folders, "Sent Items")?.key).toBe("sent");
    expect(resolveMailboxImapFolder(folders, "[Gmail]/Spam")?.key).toBe("spam");
    expect(resolveMailboxImapFolder(folders, "Deleted Items")?.key).toBe("trash");
    expect(resolveMailboxImapFolder(folders, "clientes-2026")?.key).toMatch(/^folder:/);
    expect(resolveMailboxImapFolder(folders, "Nada")).toBeNull();
  });
});

describe("syncMailboxImapFolder", () => {
  it("numbers messages once, and a message that leaves and comes back gets a new UID", async () => {
    const one = await receive("one");
    await receive("two");
    const first = await syncMailboxImapFolder(db, owner(), mailboxId, "inbox");
    expect(first.messages.map((m) => [m.uid, m.flags])).toEqual([
      [1, []],
      [2, []],
    ]);
    expect(first.uidNext).toBe(3);
    // Same state, same numbers, whatever the number of syncs.
    expect(await uids("inbox")).toEqual([1, 2]);

    await moveMailboxImapMessages(db, owner(), mailboxId, "inbox", "archive", [
      { itemId: one.id, revision: one.revision, kind: "inbox" },
    ]);
    expect(await uids("inbox")).toEqual([2]);
    expect(await uids("archive")).toEqual([1]);
    await moveMailboxImapMessages(db, owner(), mailboxId, "archive", "inbox", [
      { itemId: one.id, revision: one.revision, kind: "inbox" },
    ]);
    expect(await uids("inbox")).toEqual([2, 3]);
    await receive("three");
    expect(await uids("inbox")).toEqual([2, 3, 4]);
  });

  it("keeps \\Seen and \\Flagged in the Correio", async () => {
    const one = await receive("one");
    await setMailboxImapFlags(
      db,
      owner(),
      mailboxId,
      [{ itemId: one.id, revision: one.revision, kind: "inbox" }],
      {
        seen: true,
        flagged: true,
      },
    );
    const [message] = (await syncMailboxImapFolder(db, owner(), mailboxId, "inbox")).messages;
    expect(message?.flags.sort()).toEqual(["\\Flagged", "\\Seen"]);
    await setMailboxImapFlags(db, owner(), mailboxId, [message!], { seen: false, flagged: false });
    expect(
      (await syncMailboxImapFolder(db, owner(), mailboxId, "inbox")).messages[0]?.flags,
    ).toEqual([]);
  });

  it("moves through trash, spam and the owner's folders, and refuses Sent", async () => {
    const one = await receive("one");
    const folder = await createMailboxFolder(db, owner(), { mailboxId, name: "Clientes" });
    const key = `folder:${folder.id}` as const;
    const m = () => ({ itemId: one.id, revision: one.revision, kind: "inbox" as const });
    expect(await moveMailboxImapMessages(db, owner(), mailboxId, "inbox", key, [m()])).toBe(
      "moved",
    );
    expect(await uids(key)).toHaveLength(1);
    expect(await moveMailboxImapMessages(db, owner(), mailboxId, key, "trash", [m()])).toBe(
      "moved",
    );
    expect(await uids("trash")).toHaveLength(1);
    expect(await uids(key)).toHaveLength(0);
    expect(await moveMailboxImapMessages(db, owner(), mailboxId, "trash", "spam", [m()])).toBe(
      "moved",
    );
    expect(await uids("spam")).toHaveLength(1);
    expect(await moveMailboxImapMessages(db, owner(), mailboxId, "spam", "inbox", [m()])).toBe(
      "moved",
    );
    expect(await uids("inbox")).toHaveLength(1);
    expect(await moveMailboxImapMessages(db, owner(), mailboxId, "inbox", "sent", [m()])).toBe(
      "cannot",
    );
    const raw = await readMailboxImapMessages(db, keys, owner(), mailboxId, [one.id]);
    expect(raw.get(one.id)?.toString()).toContain("Body of one");
  });
});

describe("appendMailboxImapMessage", () => {
  it("saves drafts, imports into folders and does not duplicate a sent copy", async () => {
    const draft = await appendMailboxImapMessage(
      db,
      keys,
      owner(),
      mailboxId,
      "drafts",
      mime("rascunho"),
      {
        seen: true,
        date: null,
      },
    );
    expect((await syncMailboxImapFolder(db, owner(), mailboxId, "drafts")).messages).toEqual([
      expect.objectContaining({ itemId: draft!.itemId, flags: ["\\Seen", "\\Draft"] }),
    ]);
    const archived = await appendMailboxImapMessage(
      db,
      keys,
      owner(),
      mailboxId,
      "archive",
      mime("antiga"),
      {
        seen: true,
        date: new Date(Date.UTC(2020, 0, 1)),
      },
    );
    const archive = await syncMailboxImapFolder(db, owner(), mailboxId, "archive");
    expect(archive.messages).toEqual([
      expect.objectContaining({
        itemId: archived!.itemId,
        flags: ["\\Seen"],
        idate: new Date(Date.UTC(2020, 0, 1)),
      }),
    ]);
    // The same bytes again: the same message.
    expect(
      await appendMailboxImapMessage(db, keys, owner(), mailboxId, "archive", mime("antiga"), {
        seen: true,
        date: null,
      }),
    ).toEqual(archived);

    const sent = mime("enviada");
    expect(
      await appendMailboxImapMessage(db, keys, owner(), mailboxId, "sent", sent, {
        seen: true,
        date: null,
        recentlySent: () => true,
      }),
    ).toBeNull();
    expect((await syncMailboxImapFolder(db, owner(), mailboxId, "sent")).messages).toHaveLength(0);
    const kept = await appendMailboxImapMessage(db, keys, owner(), mailboxId, "sent", sent, {
      seen: true,
      date: null,
    });
    expect((await syncMailboxImapFolder(db, owner(), mailboxId, "sent")).messages).toEqual([
      expect.objectContaining({ itemId: kept!.itemId, kind: "sent" }),
    ]);
    // A second copy of a message already in Enviados (same Message-ID) is that message.
    expect(
      await appendMailboxImapMessage(
        db,
        keys,
        owner(),
        mailboxId,
        "sent",
        Buffer.concat([sent, Buffer.from("\r\n")]),
        {
          seen: true,
          date: null,
        },
      ),
    ).toEqual(kept);
    await expect(
      appendMailboxImapMessage(db, keys, owner(), mailboxId, "trash", mime("x"), {
        seen: true,
        date: null,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(
      await db
        .select()
        .from(schema.mailboxItems)
        .where(eq(schema.mailboxItems.mailboxId, mailboxId)),
    ).toHaveLength(3);
  });
});
