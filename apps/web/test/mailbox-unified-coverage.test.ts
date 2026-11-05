import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  countMailboxViews,
  countUnreadMailboxItemsMany,
  EnvKeyring,
  listMailboxItemsMany,
  withMailboxContentAccess,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getKeyring } from "@/server/keyring";
import {
  getMailboxContentList,
  getMailboxFolderCounts,
  getMailboxRailFolders,
  getMailboxScheduleCounts,
  getMailboxUnreadCounts,
} from "@/server/mailbox-content";
import { encryptPayload } from "../../../packages/core/src/crypto/envelope";

vi.mock("@/server/keyring", () => ({ getKeyring: vi.fn() }));
vi.mock("@/server/mailbox-sender-key", () => ({ mailboxSenderHmacKey: vi.fn(() => null) }));
let client: PGlite;
afterEach(async () => {
  await client?.close();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("complete unified mailbox coverage", () => {
  it("covers 65 authorized boxes, bounded global pages, complete rails and fail-closed grants", async () => {
    vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
    client = new PGlite();
    const base = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
    await client.transaction(async (tx) => {
      for (const name of readdirSync(base)
        .filter((n) => n.endsWith(".sql"))
        .sort())
        for (const statement of readFileSync(base + name, "utf8")
          .split("--> statement-breakpoint")
          .filter((s) => s.trim()))
          await tx.exec(statement);
    });
    const database = drizzle(client, { schema });
    const db = database as unknown as Db;
    await migrate(database, {
      migrationsFolder: fileURLToPath(
        new URL("../../../packages/db/mailbox-drizzle/", import.meta.url),
      ),
      migrationsTable: "__mailbox_migrations",
    });
    const [team, foreignTeam] = await db
      .insert(schema.teams)
      .values([
        { name: "Coverage", slug: "coverage" },
        { name: "Foreign", slug: "foreign" },
      ])
      .returning();
    const teamId = team!.id;
    for (const id of ["owner", "reader", "stranger"])
      await db
        .insert(schema.user)
        .values({ id, name: id, email: `${id}@example.invalid`, emailVerified: true });
    const members = await db
      .insert(schema.teamMembers)
      .values([
        { teamId, userId: "owner", role: "owner" },
        { teamId, userId: "reader", role: "member" },
        { teamId, userId: "stranger", role: "admin" },
      ])
      .returning();
    const owner = { teamId, userId: "owner" };
    const boxes = await db
      .insert(schema.mailboxes)
      .values(
        Array.from({ length: 65 }, (_, i) => ({
          id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
          teamId,
          origin: "external" as const,
          address: `box${i}@example.invalid`,
          label: `Box ${String(i).padStart(3, "0")}`,
          kind: i % 2 ? ("agent" as const) : ("person" as const),
          ownerUserId: "owner",
          ownerMembershipId: members[0]!.id,
        })),
      )
      .returning();
    const keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
    vi.mocked(getKeyring).mockReturnValue(keys);
    const raw = Buffer.from(
      "From: sender@example.invalid\r\nTo: owner@example.invalid\r\nSubject: Coverage\r\nContent-Type: text/plain\r\n\r\nSynthetic fixture\r\n",
    );
    const rows = [];
    for (const [i, box] of boxes.entries()) {
      const id = randomUUID();
      rows.push({
        id,
        teamId,
        mailboxId: box.id,
        kind: "inbox" as const,
        sourceId: `coverage:${id}`,
        rawBytes: raw.length,
        createdAt: sql`'2026-10-01T10:00:00.000100Z'::timestamptz + ${i % 2} * interval '1 microsecond'`,
        ...(await encryptPayload(raw, keys, {
          teamId,
          rowId: `mailbox-private-v1:${box.id}:${id}`,
          kind: "email_body",
        })),
      });
    }
    await db.insert(schema.mailboxItems).values(rows);
    const ids = boxes.map((box) => box.id);
    const expected = [...rows]
      .sort((a, b) => {
        const parity =
          (boxes.findIndex((box) => box.id === b.mailboxId) % 2) -
          (boxes.findIndex((box) => box.id === a.mailboxId) % 2);
        return parity || b.id.localeCompare(a.id);
      })
      .map((row) => row.id);
    const unwrap = vi.spyOn(keys, "unwrapDek");
    const first = await getMailboxContentList(db, owner, {
      mailboxId: null,
      folder: "inbox",
      limit: 7,
    });
    expect(unwrap).toHaveBeenCalledTimes(7);
    expect(first.items.map((row) => row.id)).toEqual(expected.slice(0, 7));
    expect(first.mailboxesTruncated).toBe(false);
    // Only the displayed page gets decrypted and summary-cached, not the lookahead or other boxes.
    const cached = await client.query<{ count: number }>(
      "select count(*)::int as count from mailbox_items where summary_ciphertext is not null",
    );
    expect(cached.rows[0]!.count).toBe(7);
    const newId = randomUUID();
    await db.insert(schema.mailboxItems).values({
      ...rows[0]!,
      id: newId,
      sourceId: `coverage:${newId}`,
      createdAt: new Date("2026-10-02"),
      ...(await encryptPayload(raw, keys, {
        teamId,
        rowId: `mailbox-private-v1:${ids[0]}:${newId}`,
        kind: "email_body",
      })),
    });
    const walked = first.items.map((row) => row.id);
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await getMailboxContentList(db, owner, {
        mailboxId: null,
        folder: "inbox",
        limit: 7,
        cursor,
      });
      walked.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor;
      expect(walked.length).toBeLessThanOrEqual(65);
    }
    expect(walked).toEqual(expected);
    expect(new Set(walked).size).toBe(65);
    expect(
      (await getMailboxContentList(db, owner, { mailboxId: null, folder: "inbox", limit: 100 }))
        .items,
    ).toHaveLength(66);
    expect(
      (
        await getMailboxContentList(db, owner, {
          mailboxId: null,
          folder: "inbox",
          mailboxKind: "person",
          unread: true,
          after: new Date("2026-10-01"),
          before: new Date("2026-10-02"),
          groupByThread: true,
        })
      ).items,
    ).toHaveLength(33);
    expect((await getMailboxUnreadCounts(db, owner)).counts[ids[64]!]).toBe(1);
    expect(Object.keys((await getMailboxUnreadCounts(db, owner)).counts)).toHaveLength(65);
    expect(await getMailboxFolderCounts(db, owner, { mailboxId: null })).toMatchObject({
      inbox: { total: 66, unread: 66 },
      mailboxesTruncated: false,
    });
    const [folder] = await db
      .insert(schema.mailboxFolders)
      .values({ teamId, mailboxId: ids[64]!, name: "Last box folder" })
      .returning();
    expect(
      (await getMailboxRailFolders(db, owner, { mailboxId: null })).map((row) => row.id),
    ).toContain(folder!.id);
    await db
      .update(schema.mailboxItems)
      .set({ snoozedUntil: new Date("2099-01-01") })
      .where(eq(schema.mailboxItems.id, rows[64]!.id));
    expect(await getMailboxScheduleCounts(db, owner, { mailboxId: null })).toMatchObject({
      snoozed: 1,
    });
    await db.insert(schema.mailboxGrants).values(
      ids.map((mailboxId) => ({
        teamId,
        mailboxId,
        userId: "reader",
        membershipId: members[1]!.id,
        permission: "read" as const,
      })),
    );
    const reader = { teamId, userId: "reader" };
    expect(await listMailboxItemsMany(db, reader, ids, undefined, { limit: 101 })).toHaveLength(66);
    expect(await withMailboxContentAccess(db, reader, ids, async () => "authorized")).toBe(
      "authorized",
    );
    // Unified rail intentionally remains owner-only; explicit readable delegated box remains readable.
    expect((await getMailboxFolderCounts(db, reader, { mailboxId: null })).inbox.total).toBe(0);
    await db
      .update(schema.mailboxGrants)
      .set({ revokedAt: new Date() })
      .where(eq(schema.mailboxGrants.mailboxId, ids[64]!));
    for (const action of [
      () => listMailboxItemsMany(db, reader, ids),
      () => countUnreadMailboxItemsMany(db, reader, ids),
      () => countMailboxViews(db, reader, ids),
      () => withMailboxContentAccess(db, reader, ids, async () => "leak"),
    ])
      await expect(action()).rejects.toMatchObject({ code: "forbidden" });
    for (const denied of [
      { teamId, userId: "stranger" },
      { ...owner, supportView: true },
      { teamId: foreignTeam!.id, userId: "owner" },
    ])
      await expect(listMailboxItemsMany(db, denied, ids)).rejects.toMatchObject({
        code: "forbidden",
      });
    expect(
      (
        await getMailboxContentList(
          db,
          { ...owner, agentAccess: true },
          { mailboxId: null, folder: "inbox", limit: 100 },
        )
      ).items,
    ).toHaveLength(65);
    await expect(
      getMailboxContentList(
        db,
        { ...owner, agentAccess: true },
        { mailboxId: null, folder: "trash" },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
