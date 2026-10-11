import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvKeyring } from "../src/crypto/keyring.js";
import {
  countUnreadMailboxItems,
  countUnreadMailboxItemsMany,
  importMailboxMime,
  listMailboxItems,
  listMailboxItemsMany,
  type MailboxContentActor,
  type MailboxListFilter,
  type MailboxListPage,
  saveMailboxDraft,
  withMailboxContentAccess,
} from "../src/mailbox-private-store.js";
import {
  createMailboxRegistry,
  grantMailboxRegistry,
  revokeMailboxRegistry,
} from "../src/mailbox-registry.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let foreignTeamId: string;
let alpha: string;
let bravo: string;
let charlie: string;
let foreign: string;
const keys = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const owner = (): MailboxContentActor => ({ teamId, userId: "owner" });
const delegate = (): MailboxContentActor => ({ teamId, userId: "delegate" });
const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
const base = Date.UTC(2026, 9, 1, 12);
const at = (minutes: number) => new Date(base + minutes * 60_000);

/** A received message; `headers` adds threading lines. */
function mime(name: string, headers: string[] = []) {
  return Buffer.from(
    [
      `From: ${name}@sender.invalid`,
      "To: owner@box.invalid",
      `Subject: Synthetic ${name}`,
      `Message-ID: <${name}@sender.invalid>`,
      ...headers,
      "",
      `Body of ${name}`,
    ].join("\r\n"),
  );
}
const receive = (
  mailboxId: string,
  name: string,
  minutes: number,
  options: { headers?: string[]; seen?: boolean; archived?: boolean; kind?: "inbox" | "sent" } = {},
) =>
  importMailboxMime(db, keys, owner(), {
    mailboxId,
    sourceId: `fixture:${name}`,
    raw: mime(name, options.headers),
    history: {
      kind: options.kind ?? "inbox",
      receivedAt: at(minutes),
      seen: options.seen === true,
      archived: options.archived === true,
    },
  });

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  for (const file of readdirSync(extension)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + file, "utf8").split(
      "--> statement-breakpoint",
    ))
      if (statement.trim()) await db.execute(sql.raw(statement));
  teamId = await createTeam(db, "read-many-fixture");
  foreignTeamId = await createTeam(db, "read-many-foreign");
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
      seats: 60,
      storageBytesPerMailbox: 5 * 1024 * 1024,
      includedOutboundPerMailbox: 100,
      periodStart: new Date(now - 86400000),
      periodEnd: new Date(now + 86400000),
    });
  const box = async (localPart: string, kind: "person" | "agent") =>
    (
      await createMailboxRegistry(db, owner(), {
        domainId: domains[0]!.id,
        localPart,
        label: localPart,
        kind,
        ownerUserId: "owner",
      })
    ).id;
  alpha = await box("alpha", "person");
  bravo = await box("bravo", "agent");
  charlie = await box("charlie", "person");
  foreign = (
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

  // Alpha: a conversation (a1, then the reply a3), one read, one archived.
  await receive(alpha, "a1", 1);
  await receive(alpha, "a2", 3, { seen: true });
  await receive(alpha, "a3", 5, { headers: ["In-Reply-To: <a1@sender.invalid>"] });
  await receive(alpha, "a4", 7, { archived: true });
  await receive(alpha, "a5", 9);
  // Bravo: interleaved with Alpha, one at the very same minute as a3 (the id breaks the tie).
  await receive(bravo, "b1", 2);
  await receive(bravo, "b2", 5);
  await receive(bravo, "b3", 8, { headers: ["References: <b1@sender.invalid>"] });
  await receive(bravo, "b4", 10, { kind: "sent" });
  // Charlie: two received, one sent, one draft.
  await receive(charlie, "c1", 4);
  await receive(charlie, "c2", 6, { seen: true });
  await receive(charlie, "c3", 11, { kind: "sent" });
  await saveMailboxDraft(db, keys, owner(), {
    mailboxId: charlie,
    expectedRevision: 0,
    raw: Buffer.from("From: charlie@box.invalid\r\nSubject: Draft\r\n\r\nDraft body"),
  });
});
afterEach(async () => {
  await close();
});

const position = (row: { orderAt: string; id: string }) => ({ at: row.orderAt, id: row.id });
const newerFirst = (a: { at: string; id: string }, b: { at: string; id: string }) => {
  const gap = BigInt(b.at) - BigInt(a.at);
  return gap > 0n ? 1 : gap < 0n ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};
const shape = (rows: { mailboxId: string; id: string; orderAt: string; kind: string }[]) =>
  rows.map((row) => `${row.mailboxId}:${row.id}:${row.orderAt}:${row.kind}`);

/** What the unified view did before: each mailbox's own page, merged and cut. */
async function merged(
  actor: MailboxContentActor,
  boxes: string[],
  filter: MailboxListFilter,
  page: MailboxListPage & { limit: number },
) {
  const rows = (
    await Promise.all(boxes.map((id) => listMailboxItems(db, actor, id, filter, page)))
  ).flat();
  rows.sort((a, b) => newerFirst(position(a), position(b)));
  return rows.slice(0, page.limit);
}

describe("listMailboxItemsMany", () => {
  const inbox: MailboxListFilter = {
    kind: "inbox",
    deliveryFolder: "inbox",
    folderId: null,
    archived: false,
    snoozed: false,
  };
  const filters: [string, MailboxListFilter][] = [
    ["inbox", inbox],
    ["sent", { kind: "sent", folderId: null, archived: false, snoozed: false }],
    ["drafts", { kind: "draft", folderId: null, archived: false, snoozed: false }],
    ["archive", { archived: true, safeOnly: true, snoozed: false }],
    ["every kind", {}],
  ];

  it.each(filters)(
    "gives the page the per-mailbox listings merged give (%s)",
    async (_, filter) => {
      const boxes = [alpha, bravo, charlie];
      for (const latestPerThread of [false, true])
        for (const limit of [2, 3, 101]) {
          const page = { limit, latestPerThread };
          const first = await listMailboxItemsMany(db, owner(), boxes, filter, page);
          expect(shape(first)).toEqual(shape(await merged(owner(), boxes, filter, page)));
          const last = first.at(-1);
          if (!last || first.length < limit) continue;
          const next = { ...page, before: position(last) };
          expect(shape(await listMailboxItemsMany(db, owner(), boxes, filter, next))).toEqual(
            shape(await merged(owner(), boxes, filter, next)),
          );
        }
    },
  );

  it("orders across mailboxes by arrival, groups a conversation within its mailbox", async () => {
    const rows = await listMailboxItemsMany(db, owner(), [charlie, bravo, alpha, alpha], inbox, {
      limit: 101,
      latestPerThread: true,
    });
    const box = (row: { mailboxId: string }) =>
      row.mailboxId === alpha ? "a" : row.mailboxId === bravo ? "b" : "c";
    // a5, b3 (stands for b1's conversation), c2, then a3 (a1's) and b2 at the same
    // minute in id order, c1, a2. a1 and b1 are hidden behind their replies.
    expect(rows.map(box).join("")).toMatch(/^abc(ab|ba)ca$/);
    expect(new Set(rows.map((row) => row.id)).size).toBe(7);
    expect(
      rows.every((row, i) => i === 0 || newerFirst(position(rows[i - 1]!), position(row)) < 0),
    ).toBe(true);
  });

  it("refuses the whole read when one mailbox is not readable", async () => {
    await expect(
      listMailboxItemsMany(db, owner(), [alpha, foreign], inbox, { limit: 10 }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      listMailboxItemsMany(db, delegate(), [alpha], inbox, { limit: 10 }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const grant = await grantMailboxRegistry(db, owner(), {
      mailboxId: alpha,
      userId: "delegate",
      permission: "read",
    });
    // a1, a2, a3 and a5 (a4 is archived).
    expect(await listMailboxItemsMany(db, delegate(), [alpha], inbox, { limit: 10 })).toHaveLength(
      4,
    );
    // One readable mailbox does not open the others.
    await expect(
      listMailboxItemsMany(db, delegate(), [alpha, bravo], inbox, { limit: 10 }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await revokeMailboxRegistry(db, owner(), grant.id);
    await expect(
      listMailboxItemsMany(db, delegate(), [alpha], inbox, { limit: 10 }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("checks membership, mailbox state, support view, agents and size like the single read", async () => {
    await grantMailboxRegistry(db, owner(), {
      mailboxId: alpha,
      userId: "delegate",
      permission: "read",
    });
    await db.delete(schema.teamMembers).where(eq(schema.teamMembers.userId, "delegate"));
    for (const read of [
      () => listMailboxItems(db, delegate(), alpha, inbox),
      () => listMailboxItemsMany(db, delegate(), [alpha], inbox),
    ])
      await expect(read()).rejects.toMatchObject({ code: "forbidden" });

    for (const actor of [
      { ...owner(), supportView: true },
      { teamId: foreignTeamId, userId: "outsider" },
    ])
      await expect(listMailboxItemsMany(db, actor, [alpha], inbox)).rejects.toMatchObject({
        code: "forbidden",
      });
    await expect(
      listMailboxItemsMany(db, { ...owner(), supportView: true }, [], inbox),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      listMailboxItemsMany(db, { ...owner(), agentAccess: true }, [alpha], { trashed: true }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const many = Array.from({ length: 51 }, () => randomUUID());
    await expect(listMailboxItemsMany(db, owner(), many, inbox)).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(
      listMailboxItemsMany(db, owner(), [alpha], inbox, { limit: 102 }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      listMailboxItemsMany(db, owner(), [alpha], inbox, { before: { at: "x", id: "y" } }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await listMailboxItemsMany(db, owner(), [], inbox)).toEqual([]);

    await db
      .update(schema.mailboxes)
      .set({ status: "suspended" })
      .where(eq(schema.mailboxes.id, bravo));
    for (const read of [
      () => listMailboxItems(db, owner(), bravo, inbox),
      () => listMailboxItemsMany(db, owner(), [alpha, bravo], inbox),
    ])
      await expect(read()).rejects.toMatchObject({ code: "forbidden" });
  });

  it("reads up to 50 mailboxes at once, as many as a page of search results can span", async () => {
    const [domain] = await db
      .select({ id: schema.domains.id })
      .from(schema.domains)
      .where(eq(schema.domains.teamId, teamId));
    const extra: string[] = [];
    for (let i = 0; i < 24; i++)
      extra.push(
        (
          await createMailboxRegistry(db, owner(), {
            domainId: domain!.id,
            localPart: `extra${i}`,
            label: `Extra ${i}`,
            kind: "person",
            ownerUserId: "owner",
          })
        ).id,
      );
    const boxes = [alpha, bravo, charlie, ...extra];
    expect(boxes).toHaveLength(27);
    expect(shape(await listMailboxItemsMany(db, owner(), boxes, inbox, { limit: 101 }))).toEqual(
      shape(await merged(owner(), boxes, inbox, { limit: 101 })),
    );
    expect((await countUnreadMailboxItemsMany(db, owner(), boxes)).size).toBe(27);
    expect(await withMailboxContentAccess(db, owner(), boxes, async () => "ok")).toBe("ok");
  });

  it("keeps reading a suspended team's retained mail, as the single read does", async () => {
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.teams.id, teamId));
    const single = await listMailboxItems(db, owner(), alpha, inbox);
    const many = await listMailboxItemsMany(db, owner(), [alpha], inbox);
    expect(shape(many)).toEqual(shape(single));
    expect(many.length).toBeGreaterThan(0);
  });
});

describe("countUnreadMailboxItemsMany", () => {
  it("counts each mailbox's unread Inbox like the single count, 0 where none", async () => {
    const counts = await countUnreadMailboxItemsMany(db, owner(), [alpha, bravo, charlie]);
    for (const id of [alpha, bravo, charlie])
      expect(counts.get(id)).toBe(await countUnreadMailboxItems(db, owner(), id));
    // a1, a3, a5 / b1, b2, b3 / c1 (a2 and c2 read, a4 archived, sent and drafts never count).
    expect([counts.get(alpha), counts.get(bravo), counts.get(charlie)]).toEqual([3, 3, 1]);
    await db
      .update(schema.mailboxItems)
      .set({ seenAt: new Date() })
      .where(eq(schema.mailboxItems.mailboxId, charlie));
    expect((await countUnreadMailboxItemsMany(db, owner(), [charlie])).get(charlie)).toBe(0);
    expect(await countUnreadMailboxItemsMany(db, owner(), [])).toEqual(new Map());
  });

  it("refuses a mailbox the actor cannot read", async () => {
    await expect(countUnreadMailboxItemsMany(db, owner(), [alpha, foreign])).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(countUnreadMailboxItemsMany(db, delegate(), [alpha])).rejects.toMatchObject({
      code: "forbidden",
    });
  });
});

describe("withMailboxContentAccess over several mailboxes", () => {
  it("runs the operation once, inside the authorized read, and refuses any unreadable mailbox", async () => {
    let runs = 0;
    expect(
      await withMailboxContentAccess(db, owner(), [charlie, alpha, bravo, alpha], async (tx) => {
        runs += 1;
        return (await tx.select({ id: schema.mailboxes.id }).from(schema.mailboxes)).length;
      }),
    ).toBe(4);
    expect(runs).toBe(1);
    await expect(
      withMailboxContentAccess(db, owner(), [alpha, foreign], async () => "leaked"),
    ).rejects.toMatchObject({ code: "forbidden" });
    await grantMailboxRegistry(db, owner(), {
      mailboxId: charlie,
      userId: "delegate",
      permission: "read",
    });
    expect(await withMailboxContentAccess(db, delegate(), [charlie], async () => "ok")).toBe("ok");
    await expect(
      withMailboxContentAccess(db, delegate(), [charlie, alpha], async () => "leaked"),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
