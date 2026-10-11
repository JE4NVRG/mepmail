import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createMailboxRegistry, EnvKeyring, importMailboxMime } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKeyring } from "@/server/keyring";
import { decodeMailboxListCursor, encodeMailboxListCursor } from "@/server/mailbox-content";
import { MAILBOX_PREFERENCE_DEFAULTS } from "@/server/mailbox-preferences";
import { mailboxesRouter } from "@/server/routers/mailboxes";
import { type Context, createCallerFactory, createContext, router } from "@/server/trpc";
import { seedMailboxTestService } from "./mailbox-service-fixture";

vi.mock("@/server/keyring", () => ({ getKeyring: vi.fn() }));
vi.mock("@/server/trpc", async (original) => ({
  ...(await original<typeof import("@/server/trpc")>()),
  createContext: vi.fn(),
}));
let client: PGlite, db: Db, teamId: string, mailboxId: string, otherBox: string, keys: EnvKeyring;
const folder = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const caller = createCallerFactory(router({ mailboxes: mailboxesRouter }));
function ctx(userId = "owner"): Context {
  return {
    db,
    teamId,
    role: userId === "owner" ? "owner" : "member",
    session: { user: { id: userId, name: userId, email: `${userId}@example.invalid` } },
  };
}
const as = (userId = "owner") => caller(ctx(userId)).mailboxes;
const actor = () => ({ teamId, userId: "owner" });
function message(id: string, references: string[] = [], to = "person@paging.invalid") {
  return Buffer.from(
    `From: Sender <sender@example.invalid>\r\nTo: ${to}\r\nSubject: Message ${id}\r\nMessage-ID: <${id}@example.invalid>\r\n${references.length ? `References: ${references.map((r) => `<${r}@example.invalid>`).join(" ")}\r\n` : ""}MIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nBody ${id}\r\n`,
  );
}
/** Imports and pins created_at, so the order is known to the microsecond. */
async function arrive(id: string, at: string, references: string[] = [], box = mailboxId) {
  const item = await importMailboxMime(db, keys, actor(), {
    mailboxId: box,
    sourceId: `paging:${id}`,
    raw: message(id, references),
  });
  await db
    .update(schema.mailboxItems)
    .set({ createdAt: sql`${at}::timestamptz` })
    .where(eq(schema.mailboxItems.id, item.id));
  return item.id;
}
async function everyPage(input: Parameters<ReturnType<typeof as>["items"]>[0]) {
  const pages: string[][] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const page = await as().items({ ...input, ...(cursor ? { cursor } : {}) });
    pages.push(page.items.map((item) => item.subject));
    if (!page.nextCursor) {
      expect(page.limited).toBe(false);
      return pages;
    }
    expect(page.limited).toBe(true);
    cursor = page.nextCursor;
  }
  throw new Error("pagination did not end");
}

beforeEach(async () => {
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  client = new PGlite();
  await client.transaction(async (tx) => {
    for (const name of readdirSync(folder)
      .filter((n) => n.endsWith(".sql"))
      .sort())
      for (const statement of readFileSync(folder + name, "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => s.trim()))
        await tx.exec(statement);
  });
  const database = drizzle(client, { schema });
  db = database as unknown as Db;
  await migrate(database, { migrationsFolder: extension, migrationsTable: "__mailbox_migrations" });
  const [team] = await db
    .insert(schema.teams)
    .values({ name: "Paging", slug: "paging" })
    .returning();
  teamId = team!.id;
  await seedMailboxTestService(db, [teamId]);
  for (const id of ["owner", "member"])
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.invalid`, emailVerified: true });
  await db.insert(schema.teamMembers).values([
    { teamId, userId: "owner", role: "owner" },
    { teamId, userId: "member", role: "member" },
  ]);
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "paging.invalid", region: "us-east-1" })
    .returning();
  const box = (localPart: string) =>
    createMailboxRegistry(db, actor(), {
      domainId: domain!.id,
      localPart,
      label: localPart,
      kind: "person",
      ownerUserId: "owner",
    });
  mailboxId = (await box("person")).id;
  otherBox = (await box("second")).id;
  keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
  vi.mocked(getKeyring).mockReturnValue(keys);
  vi.mocked(createContext).mockImplementation(async () => ctx());
});
afterEach(async () => {
  await client.close();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("message list pages", () => {
  it("walks every message once, newest first, across microsecond ties and mailboxes", async () => {
    // Same millisecond, different microseconds: a millisecond cursor would skip one.
    await arrive("a", "2026-10-01T10:00:00.000100Z");
    await arrive("b", "2026-10-01T10:00:00.000900Z");
    await arrive("c", "2026-10-01T10:00:01Z");
    await arrive("d", "2026-10-01T10:00:02Z", [], otherBox);
    await arrive("e", "2026-10-01T10:00:03Z");
    // Identical instants fall back to the id, in both mailboxes.
    await arrive("f", "2026-10-01T10:00:04Z");
    await arrive("g", "2026-10-01T10:00:04Z", [], otherBox);
    const pages = await everyPage({ mailboxId: null, folder: "inbox", limit: 2 });
    const all = pages.flat();
    expect(pages.map((page) => page.length)).toEqual([2, 2, 2, 1]);
    expect(new Set(all).size).toBe(7);
    expect(all.slice(2)).toEqual(["Message e", "Message d", "Message c", "Message b", "Message a"]);
    expect(new Set(all.slice(0, 2))).toEqual(new Set(["Message f", "Message g"]));
    // One mailbox only, default page size: a single page with no cursor.
    const single = await as().items({ mailboxId, folder: "inbox" });
    expect(single.items).toHaveLength(5);
    expect(single).toMatchObject({ nextCursor: null, limited: false, mailboxesTruncated: false });
  });

  it("rejects cursors it did not issue and page sizes out of range", async () => {
    await expect(
      as().items({ mailboxId, folder: "inbox", cursor: "bm90LWEtY3Vyc29y" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(as().items({ mailboxId, folder: "inbox", limit: 101 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const position = { at: "1791000000000123", id: "00000000-0000-4000-8000-000000000001" };
    expect(decodeMailboxListCursor(encodeMailboxListCursor(position))).toEqual(position);
    expect(() =>
      decodeMailboxListCursor(Buffer.from("1.x; drop table").toString("base64url")),
    ).toThrow();
  });
});

describe("conversations in the list", () => {
  it("shows a conversation once, as its newest message, with total and unread counts", async () => {
    const root = await arrive("root", "2026-10-02T09:00:00Z");
    await arrive("other", "2026-10-02T09:30:00Z");
    const reply = await arrive("reply", "2026-10-02T10:00:00Z", ["root"]);
    const flat = await as().items({ mailboxId, folder: "inbox" });
    expect(flat.items.map((item) => item.subject)).toEqual([
      "Message reply",
      "Message other",
      "Message root",
    ]);
    const grouped = await as().items({ mailboxId, folder: "inbox", groupByThread: true });
    expect(
      grouped.items.map((item) => [item.subject, item.threadCount, item.threadUnread]),
    ).toEqual([
      ["Message reply", 2, 2],
      ["Message other", 1, 1],
    ]);
    const threadKey = grouped.items[0]!.threadKey;
    expect(threadKey).toMatch(/^[a-f0-9]{32}$/);
    expect(flat.items.find((item) => item.id === root)!.threadKey).toBe(threadKey);
    await as().setSeen({ mailboxId, id: root, seen: true });
    const after = await as().items({ mailboxId, folder: "inbox", groupByThread: true });
    expect(after.items[0]).toMatchObject({ id: reply, threadCount: 2, threadUnread: 1 });
    // Pages of conversations keep going after the newest one.
    const first = await as().items({ mailboxId, folder: "inbox", groupByThread: true, limit: 1 });
    expect(first.items.map((item) => item.id)).toEqual([reply]);
    const second = await as().items({
      mailboxId,
      folder: "inbox",
      groupByThread: true,
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.subject)).toEqual(["Message other"]);
    expect(second.nextCursor).toBeNull();
  });
});

describe("folder color and order", () => {
  it("adds new folders last, recolors without activity, and reorders the full set", async () => {
    const work = await as().createFolder({ mailboxId, name: "Work", color: "blue" });
    const bills = await as().createFolder({ mailboxId, name: "Bills" });
    const travel = await as().createFolder({ mailboxId, name: "Travel", color: "teal" });
    expect([work.position, bills.position, travel.position]).toEqual([0, 1, 2]);
    expect((await as().folders({ mailboxId })).map((f) => [f.name, f.color])).toEqual([
      ["Work", "blue"],
      ["Bills", null],
      ["Travel", "teal"],
    ]);
    const recolored = await as().updateFolder({
      mailboxId,
      id: bills.id,
      expectedRevision: bills.revision,
      color: "amber",
    });
    expect(recolored).toMatchObject({
      color: "amber",
      name: "Bills",
      changed: true,
      renamed: false,
    });
    const renamed = await as().updateFolder({
      mailboxId,
      id: bills.id,
      expectedRevision: recolored.revision,
      name: "Invoices",
    });
    expect(renamed).toMatchObject({ name: "Invoices", color: "amber", renamed: true });
    const activity = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.target, `mailbox:${mailboxId}`));
    expect(activity.filter((row) => row.action === "mailbox.folder_renamed")).toHaveLength(1);
    await expect(
      as().updateFolder({
        mailboxId,
        id: bills.id,
        expectedRevision: renamed.revision,
        color: "neon" as never,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      as().updateFolder({ mailboxId, id: bills.id, expectedRevision: renamed.revision }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const order = [travel.id, work.id, bills.id];
    expect(await as().reorderFolders({ mailboxId, ids: order })).toEqual({
      ids: order,
      changed: true,
    });
    expect((await as().folders({ mailboxId })).map((f) => f.id)).toEqual(order);
    // Reordering keeps revisions, so an open rename dialog still saves.
    expect((await as().folders({ mailboxId })).find((f) => f.id === bills.id)!.revision).toBe(
      renamed.revision,
    );
    // A stale or partial list never drops a folder from the order.
    await expect(
      as().reorderFolders({ mailboxId, ids: [work.id, bills.id] }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      as().reorderFolders({ mailboxId, ids: [work.id, work.id, bills.id] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(as("member").reorderFolders({ mailboxId, ids: order })).rejects.toBeTruthy();
  });
});

describe("inbox preferences", () => {
  it("opens the next message after a removal unless the person turns it off", async () => {
    expect((await as().preferences.get()).openNextAfterRemove).toBe(true);
    expect((await as().preferences.set({ openNextAfterRemove: false })).openNextAfterRemove).toBe(
      false,
    );
    expect((await as().preferences.get()).openNextAfterRemove).toBe(false);
    await expect(as().preferences.set({ openNextAfterRemove: "yes" })).rejects.toMatchObject({
      message: "invalid_preference:openNextAfterRemove",
    });
  });

  it("fills defaults, merges partial changes per person and names the invalid field", async () => {
    expect(await as().preferences.get()).toEqual({
      ...MAILBOX_PREFERENCE_DEFAULTS,
      updatedAt: null,
    });
    const saved = await as().preferences.set({ density: "compact", readingPane: "bottom" });
    expect(saved).toEqual({
      ...MAILBOX_PREFERENCE_DEFAULTS,
      density: "compact",
      readingPane: "bottom",
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    // The full object read back can be sent as is.
    expect(await as().preferences.set(saved)).toMatchObject({ density: "compact" });
    const folderStart = `folder:${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`;
    const merged = await as().preferences.set({ startFolder: folderStart, markSeenAfterMs: null });
    expect(merged).toMatchObject({
      density: "compact",
      readingPane: "bottom",
      startFolder: folderStart,
      markSeenAfterMs: null,
    });
    await expect(as().preferences.set({ density: "huge" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "invalid_preference:density",
    });
    await expect(as().preferences.set({ fontSize: 14 })).rejects.toMatchObject({
      message: "invalid_preference:fontSize",
    });
    await expect(as().preferences.set({ startFolder: "folder:../../etc" })).rejects.toMatchObject({
      message: "invalid_preference:startFolder",
    });
    // Another person keeps the defaults; a corrupted stored value falls back alone.
    expect(await as("member").preferences.get()).toEqual({
      ...MAILBOX_PREFERENCE_DEFAULTS,
      updatedAt: null,
    });
    await db
      .update(schema.mailboxUserPreferences)
      .set({ preferences: { density: "compact", previewLines: 9 } })
      .where(eq(schema.mailboxUserPreferences.userId, "owner"));
    expect(await as().preferences.get()).toMatchObject({
      ...MAILBOX_PREFERENCE_DEFAULTS,
      density: "compact",
    });
  });

  it("keeps the undo-send delay and short quick replies within the stored object's ceiling", async () => {
    const saved = await as().preferences.set({
      undoSendSeconds: 20,
      quickReplies: ["  Obrigado! ", "Combinado."],
    });
    expect(saved).toMatchObject({ undoSendSeconds: 20, quickReplies: ["Obrigado!", "Combinado."] });
    expect(await as().preferences.set({ quickReplies: null })).toMatchObject({
      quickReplies: null,
    });
    await expect(as().preferences.set({ undoSendSeconds: 7 })).rejects.toMatchObject({
      message: "invalid_preference:undoSendSeconds",
    });
    await expect(
      as().preferences.set({ quickReplies: Array.from({ length: 9 }, (_, i) => `r${i}`) }),
    ).rejects.toMatchObject({ message: "invalid_preference:quickReplies" });
    await expect(
      as().preferences.set({
        quickReplies: Array.from({ length: 8 }, (_, i) => `${i}${"😀".repeat(79)}`),
      }),
    ).rejects.toMatchObject({ message: "invalid_preference:quickReplies" });
    // The largest accepted list next to the longest value of every other field
    // still fits the 4 KiB check on the stored object.
    const widest = Array.from({ length: 8 }, (_, i) => `${i || ""}${"ç".repeat(126)}`);
    const folderStart = `folder:${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`;
    expect(
      await as().preferences.set({
        ...MAILBOX_PREFERENCE_DEFAULTS,
        theme: "system",
        density: "comfortable",
        readingPane: "bottom",
        startFolder: folderStart,
        quickReplies: widest,
      }),
    ).toMatchObject({ quickReplies: widest });
  });
});

describe("folder rail across mailboxes", () => {
  it("lists every owned mailbox's folders and counts each view", async () => {
    const work = await as().createFolder({ mailboxId, name: "Work" });
    const elsewhere = await as().createFolder({ mailboxId: otherBox, name: "Receipts" });
    const all = await as().folders({ mailboxId: null });
    expect(all.map((f) => [f.mailboxId, f.name])).toEqual([
      [mailboxId, "Work"],
      [otherBox, "Receipts"],
    ]);
    expect((await as().folders({ mailboxId })).map((f) => f.id)).toEqual([work.id]);

    const read = await arrive("read", "2026-10-03T08:00:00Z");
    const filed = await arrive("filed", "2026-10-03T09:00:00Z");
    await arrive("new", "2026-10-03T10:00:00Z");
    await arrive("other", "2026-10-03T11:00:00Z", [], otherBox);
    const archived = await arrive("archived", "2026-10-03T12:00:00Z");
    await as().setSeen({ mailboxId, id: read, seen: true });
    const revisionOf = async (id: string) =>
      (
        await db
          .select({ revision: schema.mailboxItems.revision })
          .from(schema.mailboxItems)
          .where(eq(schema.mailboxItems.id, id))
      )[0]!.revision;
    await as().setItemFolder({
      mailboxId,
      id: filed,
      expectedRevision: await revisionOf(filed),
      folderId: work.id,
    });
    await as().setArchive({
      mailboxId,
      id: archived,
      expectedRevision: await revisionOf(archived),
      archived: true,
    });
    expect(await as().folderCounts({ mailboxId })).toEqual({
      inbox: { unread: 1, total: 2 },
      spam: { unread: 0, total: 0 },
      folders: { [work.id]: { unread: 1, total: 1 } },
      mailboxesTruncated: false,
    });
    expect(await as().folderCounts({ mailboxId: null })).toEqual({
      inbox: { unread: 2, total: 3 },
      spam: { unread: 0, total: 0 },
      folders: { [work.id]: { unread: 1, total: 1 } },
      mailboxesTruncated: false,
    });
    expect(elsewhere.mailboxId).toBe(otherBox);
    // Someone without access to these mailboxes sees no folders and gets no counts.
    expect(await as("member").folders({ mailboxId: null })).toEqual([]);
    await expect(as("member").folderCounts({ mailboxId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
