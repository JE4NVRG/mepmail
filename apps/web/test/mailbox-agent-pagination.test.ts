import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  assessMailboxReceipt,
  createMailboxAgentKey,
  createMailboxRegistry,
  createMailboxTeamAgentKey,
  deriveMailboxSearchKey,
  EnvKeyring,
  importMailboxMime,
  indexMailboxSearch,
  receiveMailboxMime,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMailboxSearchDocument } from "../../worker/src/mailbox-search-document";
import { seedMailboxTestService } from "./mailbox-service-fixture";

// Real database (PGlite), real private store, real search index and the real public
// agent route: only the process singletons point at the fixtures.
const h = vi.hoisted(() => ({
  db: null as unknown,
  keys: null as unknown,
  search: null as unknown,
}));
vi.mock("@millionsend/db", async (original) => ({
  ...(await original<typeof import("@millionsend/db")>()),
  getDb: () => h.db,
}));
vi.mock("@/server/keyring", () => ({ getKeyring: () => h.keys }));
vi.mock("@/server/mailbox-search-key", () => ({ mailboxSearchKey: () => h.search }));
vi.mock("@/server/mailbox-sender-key", () => ({ mailboxSenderHmacKey: () => null }));

const { GET: itemsGet } = await import("@/app/api/mailbox-agent/items/route");

const base = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const mail = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
let client: PGlite, db: Db, teamId: string, foreignTeamId: string;
let boxA: string, boxB: string, foreignBox: string;
let token: string, foreignToken: string;
const keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
const searchKey = deriveMailboxSearchKey(randomBytes(32));
const START = Date.UTC(2026, 8, 1, 12, 0, 0);
const minute = (i: number) => new Date(START + i * 60_000);
const owner = () => ({ teamId, userId: "owner" });

interface Page {
  status: number;
  items: { id: string; subject: string; from: string; date: string }[];
  nextCursor: string | null;
  hasMore: boolean;
  mode?: string;
  limited?: boolean;
}
async function page(
  params: Record<string, string>,
  mailbox = "a@page.invalid",
  bearer = token,
): Promise<Page> {
  const url = new URL("http://localhost/api/mailbox-agent/items");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const response = await itemsGet(
    new Request(url, {
      headers: { authorization: `Bearer ${bearer}`, "mepmail-mailbox": mailbox },
    }),
  );
  const body = (await response.json()) as Omit<Page, "status">;
  return { status: response.status, ...body };
}
/** Follows nextCursor to the end; returns every page. */
async function walk(params: Record<string, string>, mailbox?: string) {
  const pages: Page[] = [];
  let cursor: string | null = null;
  do {
    const next: Page = await page({ ...params, ...(cursor ? { cursor } : {}) }, mailbox);
    expect(next.status).toBe(200);
    pages.push(next);
    cursor = next.nextCursor;
    expect(next.hasMore).toBe(cursor !== null);
  } while (cursor && pages.length < 50);
  return pages;
}
const ids = (pages: Page[]) => pages.flatMap((p) => p.items.map((item) => item.id));

function message(i: number) {
  const from = i % 3 === 0 ? "alerts@healthchecks.io" : `cliente${i}@example.com`;
  return Buffer.from(
    `From: ${from}\r\nTo: a@page.invalid\r\nSubject: Pedido ${i}${i % 10 === 0 ? " urgente" : ""}\r\nMessage-ID: <m${i}@page.invalid>\r\nDate: ${minute(i).toUTCString()}\r\n\r\nCorpo ${i}\r\n`,
  );
}
async function seed(i: number, mailboxId = boxA) {
  return importMailboxMime(db, keys, owner(), {
    mailboxId,
    sourceId: `seed-${mailboxId.slice(0, 8)}-${i}`,
    raw: message(i),
    history: { kind: "inbox", receivedAt: minute(i), seen: i % 2 === 0, archived: false },
  });
}

beforeEach(async () => {
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  vi.stubEnv("MAILBOX_AGENT_RATE_LIMIT_PER_MINUTE", "100000");
  vi.stubEnv("MASTER_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  client = new PGlite();
  for (const name of readdirSync(base)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await client.transaction(async (tx) => {
      for (const statement of readFileSync(base + name, "utf8")
        .split("--> statement-breakpoint")
        .filter((part) => part.trim()))
        await tx.exec(statement);
    });
  const database = drizzle(client, { schema });
  db = database as unknown as Db;
  h.db = db;
  h.keys = keys;
  h.search = searchKey;
  await migrate(database, { migrationsFolder: mail, migrationsTable: "__mailbox_migrations" });
  const teams = await db
    .insert(schema.teams)
    .values([
      { name: "Paging", slug: "paging" },
      { name: "Other", slug: "paging-other" },
    ])
    .returning();
  teamId = teams[0]!.id;
  foreignTeamId = teams[1]!.id;
  await seedMailboxTestService(db, [teamId, foreignTeamId]);
  for (const id of ["owner", "foreign"])
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.invalid`, emailVerified: true });
  await db.insert(schema.teamMembers).values([
    { teamId, userId: "owner", role: "owner" },
    { teamId: foreignTeamId, userId: "foreign", role: "owner" },
  ]);
  const domains = await db
    .insert(schema.domains)
    .values([
      { teamId, name: "page.invalid", region: "us-east-1", status: "verified" },
      {
        teamId: foreignTeamId,
        name: "page-foreign.invalid",
        region: "us-east-1",
        status: "verified",
      },
    ])
    .returning();
  const box = async (actor: { teamId: string; userId: string }, domainId: string, local: string) =>
    (
      await createMailboxRegistry(db, actor, {
        domainId,
        localPart: local,
        label: local,
        kind: "person",
        ownerUserId: actor.userId,
      })
    ).id;
  boxA = await box(owner(), domains[0]!.id, "a");
  boxB = await box(owner(), domains[0]!.id, "b");
  foreignBox = await box({ teamId: foreignTeamId, userId: "foreign" }, domains[1]!.id, "x");
  for (let i = 1; i <= 120; i++) await seed(i);
  for (let i = 1; i <= 5; i++) await seed(i, boxB);
  token = (
    await createMailboxTeamAgentKey(db, owner(), {
      label: "Paging agent",
      mailboxIds: [boxA, boxB],
      scopes: ["read"],
    })
  ).token;
  foreignToken = (
    await createMailboxAgentKey(
      db,
      { teamId: foreignTeamId, userId: "foreign" },
      {
        mailboxId: foreignBox,
        label: "Foreign agent",
      },
    )
  ).token;
  while ((await indexMailboxSearch(db, keys, searchKey, readMailboxSearchDocument)).remaining);
});
afterEach(async () => {
  await client.close();
  vi.unstubAllEnvs();
});

describe("agent listing pages", () => {
  it("walks a mailbox of 120 to the end in pages, newest first, with no repeat or gap", async () => {
    // An old call with no new argument: the first 50, as before, now telling there is more.
    const first = await page({});
    expect(first).toMatchObject({ status: 200, mode: "list", hasMore: true, limited: true });
    expect(first.items).toHaveLength(50);
    expect(first.items[0]!.subject).toBe("Pedido 120 urgente");

    const pages = await walk({ limit: "50" });
    expect(pages.map((p) => p.items.length)).toEqual([50, 50, 20]);
    expect(pages.at(-1)).toMatchObject({ hasMore: false, nextCursor: null });
    const all = ids(pages);
    expect(new Set(all).size).toBe(120);
    const subjects = pages.flatMap((p) =>
      p.items.map((item) => item.subject.replace(" urgente", "")),
    );
    expect(subjects).toEqual(Array.from({ length: 120 }, (_, k) => `Pedido ${120 - k}`));
  });

  it("puts mail that arrives while paging before page one: the set being walked stays whole", async () => {
    const one = await page({ limit: "40" });
    // Two messages arrive between pages, newer than everything listed.
    await seed(500);
    await seed(501);
    const rest: Page[] = [one];
    let cursor = one.nextCursor;
    while (cursor) {
      const next = await page({ limit: "40", cursor });
      rest.push(next);
      cursor = next.nextCursor;
    }
    const all = ids(rest);
    expect(all).toHaveLength(120);
    expect(new Set(all).size).toBe(120);
    expect(rest.flatMap((p) => p.items.map((item) => item.subject))).not.toContain(
      "Pedido 500 urgente",
    );
    // Starting over shows them first.
    expect((await page({ limit: "2" })).items.map((item) => item.subject)).toEqual([
      "Pedido 501",
      "Pedido 500 urgente",
    ]);
  });

  it("applies unread and the time window on the server before cutting pages", async () => {
    const unread = await walk({ unread: "true", limit: "7" });
    const seen = ids(unread);
    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
    // Odd seeds are the unread ones.
    expect(
      unread.flatMap((p) => p.items.map((item) => Number(item.subject.split(" ")[1]) % 2)),
    ).toEqual(Array(60).fill(1));
    // [minute 30, minute 90): 60 messages, crossing pages of 25.
    const window = await walk({
      after: minute(30).toISOString(),
      before: minute(90).toISOString(),
      limit: "25",
    });
    expect(window.map((p) => p.items.length)).toEqual([25, 25, 10]);
    expect(new Set(ids(window)).size).toBe(60);
    // Combined: unread inside the window.
    const both = await walk({
      unread: "true",
      after: minute(30).toISOString(),
      before: minute(90).toISOString(),
      limit: "8",
    });
    expect(ids(both)).toHaveLength(30);
    // A day works too, and an empty result says there is nothing more, not that the box is empty.
    const none = await page({ after: "2030-01-01" });
    expect(none).toMatchObject({ status: 200, hasMore: false, nextCursor: null, items: [] });
  });

  it("searches sender and subject on the server, page by page, combined with the filters", async () => {
    const alerts = await walk({ from: "healthchecks.io", limit: "15" });
    expect(alerts[0]!.mode).toBe("search");
    const found = alerts.flatMap((p) => p.items);
    expect(found).toHaveLength(40);
    expect(new Set(found.map((item) => item.id)).size).toBe(40);
    expect(found.every((item) => item.from === "alerts@healthchecks.io")).toBe(true);
    const urgent = await walk({ subject: "urgente", limit: "5" });
    expect(urgent.flatMap((p) => p.items.map((item) => item.subject))).toEqual(
      Array.from({ length: 12 }, (_, k) => `Pedido ${120 - k * 10} urgente`),
    );
    // Sender + word + unread: the odd seeds from healthchecks.io (3, 9, ..., 117).
    const narrow = await walk({
      from: "healthchecks.io",
      q: "pedido",
      unread: "true",
      limit: "7",
    });
    const expected = Array.from({ length: 120 }, (_, k) => 120 - k).filter(
      (i) => i % 3 === 0 && i % 2 === 1,
    );
    expect(
      narrow.flatMap((p) => p.items.map((item) => Number(item.subject.split(" ")[1]))),
    ).toEqual(expected);
    // A search page holds at most 50 rows.
    expect((await page({ q: "pedido", limit: "100" })).items).toHaveLength(50);
  });

  it("refuses cursors from another mailbox, tenant or query, or altered, and keeps tenants apart", async () => {
    const one = await page({ limit: "10" });
    const cursor = one.nextCursor!;
    expect((await page({ limit: "10", cursor }, "b@page.invalid")).status).toBe(400);
    expect((await page({ limit: "10", cursor, unread: "true" })).status).toBe(400);
    expect((await page({ limit: "10", cursor, q: "pedido" })).status).toBe(400);
    const [inner, sig] = cursor.split(".");
    const flipped = `${inner}.${sig!.slice(0, -2)}${sig!.endsWith("AA") ? "AB" : "AA"}`;
    expect((await page({ limit: "10", cursor: flipped })).status).toBe(400);
    expect((await page({ limit: "10", cursor: inner! })).status).toBe(400);
    expect(
      (await page({ limit: "10", cursor }, "x@page-foreign.invalid", foreignToken)).status,
    ).toBe(400);
    // The same cursor, same mailbox and filters, still works (a different limit is fine).
    expect((await page({ limit: "5", cursor })).status).toBe(200);
    // A key for mailbox A alone cannot list or search B, another mailbox of the same owner.
    const onlyA = (await createMailboxAgentKey(db, owner(), { mailboxId: boxA, label: "Only A" }))
      .token;
    expect((await page({ q: "pedido" }, "a@page.invalid", onlyA)).status).toBe(200);
    expect((await page({ q: "pedido" }, "b@page.invalid", onlyA)).status).toBe(403);
    expect((await page({}, "b@page.invalid", onlyA)).status).toBe(403);
    // The credential never lists a mailbox outside it, and the foreign key never sees ours.
    expect((await page({}, "x@page-foreign.invalid")).status).toBe(403);
    expect((await page({}, "a@page.invalid", foreignToken)).status).toBe(403);
  });

  it("keeps quarantined and spam mail out of agent pages and searches", async () => {
    // Real receipts with the provider's verdicts: a virus is quarantined, spam goes to Spam.
    const receive = async (sourceId: string, virus: "PASS" | "FAIL") =>
      (
        await receiveMailboxMime(
          db,
          keys,
          {
            sourceId,
            recipients: ["a@page.invalid"],
            raw: message(sourceId === "held" ? 900 : 901),
            assessment: assessMailboxReceipt({
              virusVerdict: { status: virus },
              spamVerdict: { status: "FAIL" },
            }),
          },
          {
            parse: async () => ({
              from: "cliente900@example.com",
              to: ["a@page.invalid"],
              cc: [],
              bcc: [],
              attachmentBytes: [],
            }),
          },
        )
      ).items[0]!;
    const held = await receive("held", "FAIL");
    const spam = await receive("spam", "PASS");
    const folders = await db
      .select({ id: schema.mailboxItems.id, folder: schema.mailboxItems.deliveryFolder })
      .from(schema.mailboxItems)
      .where(eq(schema.mailboxItems.mailboxId, boxA));
    expect(folders.find((row) => row.id === held.id)?.folder).toBe("quarantine");
    expect(folders.find((row) => row.id === spam.id)?.folder).toBe("spam");
    while ((await indexMailboxSearch(db, keys, searchKey, readMailboxSearchDocument)).remaining);
    const listed = ids(await walk({ limit: "100" }));
    expect(listed).toHaveLength(120);
    expect(listed).not.toContain(held.id);
    expect(listed).not.toContain(spam.id);
    const searched = ids(await walk({ q: "pedido", limit: "50" }));
    expect(searched).not.toContain(held.id);
    expect(searched).not.toContain(spam.id);
  });
});
