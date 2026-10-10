import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  claimDueMailboxSends,
  createMailboxRegistry,
  EnvKeyring,
  importMailboxMime,
  type MailboxTransportMimeAdapter,
  markDueMailboxFollowUps,
  saveMailboxDraft,
  wakeSnoozedMailboxItems,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { simpleParser } from "mailparser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKeyring } from "@/server/keyring";
import { mailboxesRouter } from "@/server/routers/mailboxes";
import { type Context, createCallerFactory, createContext, router } from "@/server/trpc";
import { runMailboxSchedules } from "../../worker/src/handlers/mailbox-scheduling";
import { seedMailboxTestService } from "./mailbox-service-fixture";

vi.mock("@/server/keyring", () => ({ getKeyring: vi.fn() }));
vi.mock("@/server/trpc", async (original) => ({
  ...(await original<typeof import("@/server/trpc")>()),
  createContext: vi.fn(),
}));
let client: PGlite, db: Db, teamId: string, mailboxId: string, keys: EnvKeyring;
const folder = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const caller = createCallerFactory(router({ mailboxes: mailboxesRouter }));
const ADDRESS = "person@scheduling.invalid";
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
const minutes = (n: number) => new Date(Date.now() + n * 60_000);
const mime: MailboxTransportMimeAdapter = {
  async parse(raw) {
    const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
    const list = (v: typeof parsed.to) =>
      (Array.isArray(v) ? v : v ? [v] : [])
        .flatMap((entry) => entry.value)
        .map((entry) => entry.address!)
        .filter(Boolean);
    return {
      from: parsed.from?.value[0]?.address ?? "",
      to: list(parsed.to),
      cc: list(parsed.cc),
      bcc: list(parsed.bcc),
      attachmentBytes: parsed.attachments.map((a) => a.content.length),
    };
  },
};
function message(id: string, references: string[] = []) {
  return Buffer.from(
    `From: Sender <sender@example.invalid>\r\nTo: ${ADDRESS}\r\nSubject: Message ${id}\r\nMessage-ID: <${id}@example.invalid>\r\n${references.length ? `References: ${references.map((r) => `<${r}@example.invalid>`).join(" ")}\r\n` : ""}MIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nBody ${id}\r\n`,
  );
}
/** Imports and pins created_at, so the order is known. */
async function arrive(id: string, at: string, references: string[] = []) {
  const item = await importMailboxMime(db, keys, actor(), {
    mailboxId,
    sourceId: `scheduling:${id}`,
    raw: message(id, references),
  });
  await db
    .update(schema.mailboxItems)
    .set({ createdAt: sql`${at}::timestamptz` })
    .where(eq(schema.mailboxItems.id, item.id));
  return item.id;
}
/** A message this mailbox sent, in its own conversation. */
async function sent(id: string, at: string) {
  const itemId = await arrive(id, at);
  await db
    .update(schema.mailboxItems)
    .set({ kind: "sent", sourceId: `sent:${id}` })
    .where(eq(schema.mailboxItems.id, itemId));
  return itemId;
}
const row = async (id: string) =>
  (await db.select().from(schema.mailboxItems).where(eq(schema.mailboxItems.id, id)))[0]!;
const subjects = async (folder: Parameters<ReturnType<typeof as>["items"]>[0]["folder"]) =>
  (await as().items({ mailboxId, folder })).items.map((item) => item.subject);
async function draft() {
  const raw = Buffer.from(
    `From: ${ADDRESS}\r\nTo: recipient@example.invalid\r\nSubject: Later\r\nMessage-ID: <later@scheduling.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nSent later\r\n`,
  );
  return saveMailboxDraft(db, keys, actor(), { mailboxId, expectedRevision: 0, raw });
}
const worker = (now: Date, transportEnabled = true) => {
  const enqueued: string[] = [];
  return {
    enqueued,
    run: () =>
      runMailboxSchedules(db, {
        keyring: keys,
        mime,
        transportEnabled,
        enqueue: async (outboxId) => {
          enqueued.push(outboxId);
        },
        now,
      }),
  };
};

beforeEach(async () => {
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  vi.stubEnv("MAILBOX_TRANSPORT_ENABLED", "1");
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
    .values({ name: "Scheduling", slug: "scheduling" })
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
    .values({ teamId, name: "scheduling.invalid", region: "us-east-1", status: "verified" })
    .returning();
  mailboxId = (
    await createMailboxRegistry(db, actor(), {
      domainId: domain!.id,
      localPart: "person",
      label: "Person",
      kind: "person",
      ownerUserId: "owner",
    })
  ).id;
  keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
  vi.mocked(getKeyring).mockReturnValue(keys);
  vi.mocked(createContext).mockImplementation(async () => ctx());
});
afterEach(async () => {
  await client.close();
  vi.unstubAllEnvs();
});

describe("snooze", () => {
  it("takes a message out of every view until it is due, then brings it back on top and unread", async () => {
    const a = await arrive("a", "2026-10-01T10:00:00Z");
    await arrive("b", "2026-10-02T10:00:00Z");
    await arrive("c", "2026-10-03T10:00:00Z");
    const seen = await as().setSeen({ mailboxId, id: a, seen: true });
    expect(seen).toBeTruthy();
    const archived = await as().setArchive({
      mailboxId,
      id: a,
      expectedRevision: (await row(a)).revision,
      archived: true,
    });
    const snoozed = await as().scheduling.snooze({
      mailboxId,
      id: a,
      expectedRevision: archived.revision,
      until: minutes(60),
    });
    expect(snoozed.snoozedUntil).toBeInstanceOf(Date);
    expect(await subjects("archive")).toEqual([]);
    expect(await subjects("snoozed")).toEqual(["Message a"]);
    expect(await subjects("inbox")).toEqual(["Message c", "Message b"]);
    expect(await as().scheduling.counts({ mailboxId })).toEqual({
      snoozed: 1,
      scheduled: 0,
      followUps: 0,
    });
    const counts = await as().folderCounts({ mailboxId });
    expect(counts).toBeTruthy();

    // Due: the worker returns it to the inbox, unread, ordered by when it came back.
    expect(await wakeSnoozedMailboxItems(db, minutes(61))).toBe(1);
    const woken = await row(a);
    expect(woken).toMatchObject({ snoozedUntil: null, archivedAt: null, seenAt: null });
    expect(woken.resurfacedAt).toBeInstanceOf(Date);
    expect(woken.revision).toBe(snoozed.revision + 1);
    expect(await subjects("inbox")).toEqual(["Message a", "Message c", "Message b"]);
    expect(await subjects("snoozed")).toEqual([]);
    expect((await as().unreadCounts()).counts[mailboxId]).toBe(3);
  });

  it("shows a message again as soon as it is due, even before the worker runs", async () => {
    const a = await arrive("a", "2026-10-01T10:00:00Z");
    await as().scheduling.snooze({ mailboxId, id: a, expectedRevision: 1, until: minutes(5) });
    expect(await subjects("inbox")).toEqual([]);
    expect((await as().unreadCounts()).counts[mailboxId]).toBe(0);
    await db
      .update(schema.mailboxItems)
      .set({ snoozedUntil: sql`now() - interval '1 minute'` })
      .where(eq(schema.mailboxItems.id, a));
    expect(await subjects("inbox")).toEqual(["Message a"]);
    expect((await as().unreadCounts()).counts[mailboxId]).toBe(1);
  });

  it("wakes by hand and refuses bad times, stale revisions, drafts and other people", async () => {
    const a = await arrive("a", "2026-10-01T10:00:00Z");
    const later = await as().scheduling.snooze({
      mailboxId,
      id: a,
      expectedRevision: 1,
      until: minutes(30),
    });
    const back = await as().scheduling.snooze({
      mailboxId,
      id: a,
      expectedRevision: later.revision,
      until: null,
    });
    expect(back.snoozedUntil).toBeNull();
    expect(await subjects("inbox")).toEqual(["Message a"]);
    const input = { mailboxId, id: a, expectedRevision: back.revision };
    await expect(as().scheduling.snooze({ ...input, until: minutes(-5) })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      as().scheduling.snooze({ ...input, until: minutes(367 * 24 * 60) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      as().scheduling.snooze({ ...input, expectedRevision: 1, until: minutes(30) }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      as("member").scheduling.snooze({ ...input, until: minutes(30) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const saved = await draft();
    await expect(
      as().scheduling.snooze({
        mailboxId,
        id: saved.id,
        expectedRevision: saved.revision,
        until: minutes(30),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps pages whole when a message comes back to the top", async () => {
    const ids: string[] = [];
    for (let n = 1; n <= 5; n++) ids.push(await arrive(`m${n}`, `2026-10-0${n}T10:00:00Z`));
    await as().scheduling.snooze({
      mailboxId,
      id: ids[1]!,
      expectedRevision: 1,
      until: minutes(5),
    });
    await wakeSnoozedMailboxItems(db, minutes(6));
    const pages: string[][] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await as().items({
        mailboxId,
        folder: "inbox",
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      pages.push(page.items.map((item) => item.subject));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(pages.flat()).toEqual([
      "Message m2",
      "Message m5",
      "Message m4",
      "Message m3",
      "Message m1",
    ]);
  });
});

describe("pin", () => {
  it("lists pinned inbox messages on their own and unpins them", async () => {
    const a = await arrive("a", "2026-10-01T10:00:00Z");
    await arrive("b", "2026-10-02T10:00:00Z");
    const pinned = await as().scheduling.pin({
      mailboxId,
      id: a,
      expectedRevision: 1,
      pinned: true,
    });
    expect(pinned.pinnedAt).toBeInstanceOf(Date);
    expect(await subjects("pinned")).toEqual(["Message a"]);
    expect((await as().items({ mailboxId, folder: "inbox" })).items[1]?.pinnedAt).toBeInstanceOf(
      Date,
    );
    const archived = await as().setArchive({
      mailboxId,
      id: a,
      expectedRevision: pinned.revision,
      archived: true,
    });
    expect(await subjects("pinned")).toEqual([]);
    const restored = await as().setArchive({
      mailboxId,
      id: a,
      expectedRevision: archived.revision,
      archived: false,
    });
    await as().scheduling.pin({
      mailboxId,
      id: a,
      expectedRevision: restored.revision,
      pinned: false,
    });
    expect(await subjects("pinned")).toEqual([]);
  });
});

describe("send later", () => {
  it("admits a scheduled draft as its owner when it comes due, exactly once", async () => {
    const saved = await draft();
    const scheduled = await as().scheduling.sendLater({
      mailboxId,
      id: saved.id,
      expectedRevision: saved.revision,
      sendAt: minutes(2),
    });
    expect(scheduled.sendAt).toBeInstanceOf(Date);
    expect(await subjects("scheduled")).toEqual(["Later"]);
    expect((await as().scheduling.counts({ mailboxId })).scheduled).toBe(1);

    const early = worker(minutes(1));
    expect(await early.run()).toMatchObject({ sent: 0, failed: 0 });
    const due = worker(minutes(3));
    expect(await due.run()).toMatchObject({ sent: 1, failed: 0, deferred: 0 });
    expect(due.enqueued).toHaveLength(1);
    const outbox = await db
      .select()
      .from(schema.mailboxOutbox)
      .where(eq(schema.mailboxOutbox.draftId, saved.id));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ approvedBy: "owner", draftRevision: scheduled.revision });
    expect(await row(saved.id)).toMatchObject({
      sendAt: null,
      sendClaimedAt: null,
      sendFailure: null,
    });
    expect(await subjects("scheduled")).toEqual([]);
    // A second run finds nothing to send.
    expect(await worker(minutes(4)).run()).toMatchObject({ sent: 0 });
  });

  it("stops with the reason when the send can no longer go out", async () => {
    const saved = await draft();
    const scheduled = await as().scheduling.sendLater({
      mailboxId,
      id: saved.id,
      expectedRevision: saved.revision,
      sendAt: minutes(2),
    });
    // The license lapsed after the schedule: the worker checks again and refuses.
    await db
      .delete(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    expect(await worker(minutes(3)).run()).toMatchObject({ sent: 0, failed: 1 });
    const failed = await row(saved.id);
    expect(failed).toMatchObject({ sendAt: null, sendFailure: "not_entitled" });
    expect(failed.revision).toBe(scheduled.revision);
    const item = await as().item({ mailboxId, id: saved.id });
    expect(item.sendFailure).toBe("not_entitled");
  });

  it("waits while transport is off, and refuses new schedules without it", async () => {
    const saved = await draft();
    await as().scheduling.sendLater({
      mailboxId,
      id: saved.id,
      expectedRevision: saved.revision,
      sendAt: minutes(2),
    });
    expect(await worker(minutes(3), false).run()).toMatchObject({ sent: 0, failed: 0 });
    expect((await row(saved.id)).sendAt).toBeInstanceOf(Date);
    expect(await claimDueMailboxSends(db, minutes(3))).toHaveLength(1);
    // Claimed: another run within the claim window leaves it alone.
    expect(await claimDueMailboxSends(db, minutes(4))).toHaveLength(0);
    vi.stubEnv("MAILBOX_TRANSPORT_ENABLED", "0");
    const other = await draft();
    await expect(
      as().scheduling.sendLater({
        mailboxId,
        id: other.id,
        expectedRevision: other.revision,
        sendAt: minutes(5),
      }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("cancels a schedule and refuses messages that are not drafts", async () => {
    const saved = await draft();
    const scheduled = await as().scheduling.sendLater({
      mailboxId,
      id: saved.id,
      expectedRevision: saved.revision,
      sendAt: minutes(10),
    });
    const cancelled = await as().scheduling.sendLater({
      mailboxId,
      id: saved.id,
      expectedRevision: scheduled.revision,
      sendAt: null,
    });
    expect(cancelled.sendAt).toBeNull();
    expect(await subjects("scheduled")).toEqual([]);
    const a = await arrive("a", "2026-10-01T10:00:00Z");
    await expect(
      as().scheduling.sendLater({ mailboxId, id: a, expectedRevision: 1, sendAt: minutes(10) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("follow-up", () => {
  it("comes due only when nobody replied in the conversation", async () => {
    const quiet = await sent("s1", "2026-10-01T10:00:00Z");
    const answered = await sent("s2", "2026-10-01T11:00:00Z");
    for (const id of [quiet, answered])
      await as().scheduling.followUp({ mailboxId, id, expectedRevision: 1, remindAt: minutes(2) });
    await arrive("r2", "2026-10-02T10:00:00Z", ["s2"]);
    expect(await markDueMailboxFollowUps(db, minutes(1))).toBe(0);
    expect(await markDueMailboxFollowUps(db, minutes(3))).toBe(1);
    expect(await subjects("followups")).toEqual(["Message s1"]);
    expect((await row(answered)).remindAt).toBeNull();
    expect((await as().scheduling.counts({ mailboxId })).followUps).toBe(1);

    // A reply that comes after the reminder takes it out of Follow-ups.
    await arrive("r1", "2026-10-03T10:00:00Z", ["s1"]);
    expect(await subjects("followups")).toEqual([]);
    expect((await as().scheduling.counts({ mailboxId })).followUps).toBe(0);
  });

  it("is done by hand and only applies to sent messages", async () => {
    const quiet = await sent("s1", "2026-10-01T10:00:00Z");
    const set = await as().scheduling.followUp({
      mailboxId,
      id: quiet,
      expectedRevision: 1,
      remindAt: minutes(2),
    });
    await markDueMailboxFollowUps(db, minutes(3));
    const done = await as().scheduling.followUp({
      mailboxId,
      id: quiet,
      expectedRevision: set.revision + 1,
      remindAt: null,
    });
    expect(done).toMatchObject({ remindAt: null, remindedAt: null });
    expect(await subjects("followups")).toEqual([]);
    const a = await arrive("a", "2026-10-01T10:00:00Z");
    await expect(
      as().scheduling.followUp({ mailboxId, id: a, expectedRevision: 1, remindAt: minutes(5) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
