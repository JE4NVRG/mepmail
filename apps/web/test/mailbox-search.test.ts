import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  createMailboxRegistry,
  deriveMailboxSearchKey,
  EnvKeyring,
  grantMailboxRegistry,
  importMailboxMime,
  indexMailboxSearch,
  setMailboxItemTrash,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKeyring } from "@/server/keyring";
import { mailboxSearchKey } from "@/server/mailbox-search-key";
import { mailboxesRouter } from "@/server/routers/mailboxes";
import { type Context, createCallerFactory, router } from "@/server/trpc";
import { readMailboxSearchDocument } from "../../worker/src/mailbox-search-document";
import { seedMailboxTestService } from "./mailbox-service-fixture";

vi.mock("@/server/keyring", () => ({ getKeyring: vi.fn() }));
vi.mock("@/server/mailbox-sender-key", () => ({ mailboxSenderHmacKey: vi.fn(() => null) }));
vi.mock("@/server/mailbox-search-key", () => ({ mailboxSearchKey: vi.fn() }));

let client: PGlite, db: Db, teamId: string, mailboxId: string, keys: EnvKeyring;
const searchKey = deriveMailboxSearchKey(randomBytes(32));
const base = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const caller = createCallerFactory(router({ mailboxes: mailboxesRouter }));
const as = (userId = "owner") =>
  caller({
    db,
    teamId,
    role: userId === "owner" ? "owner" : "member",
    session: { user: { id: userId, name: userId, email: `${userId}@example.invalid` } },
  } satisfies Context).mailboxes;
const actor = () => ({ teamId, userId: "owner" });
const message = (subject: string, body: string, extra = "") =>
  Buffer.from(
    `From: Ana Souza <ana@cliente.invalid>\r\nTo: person@search.invalid\r\nSubject: ${subject}\r\nMessage-ID: <${randomBytes(6).toString("hex")}@cliente.invalid>\r\nMIME-Version: 1.0\r\n${extra}Content-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`,
  );
const imported = (sourceId: string, subject: string, body: string) =>
  importMailboxMime(db, keys, actor(), { mailboxId, sourceId, raw: message(subject, body) });
const index = () => indexMailboxSearch(db, keys, searchKey, readMailboxSearchDocument);
const ids = (result: { items: { id: string }[] }) => result.items.map((item) => item.id);

beforeEach(async () => {
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  client = new PGlite();
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
  db = database as unknown as Db;
  await migrate(database, { migrationsFolder: extension, migrationsTable: "__mailbox_migrations" });
  teamId = (
    await db.insert(schema.teams).values({ name: "Search", slug: "search" }).returning()
  )[0]!.id;
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
    .values({ teamId, name: "search.invalid", region: "us-east-1" })
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
  vi.mocked(mailboxSearchKey).mockReturnValue(searchKey);
});
afterEach(async () => {
  await client.close();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("mailboxes.search", () => {
  it("answers with the rows items returns, plus each one's folder", async () => {
    const proposal = await imported("s:1", "Proposta para o piloto", "Segue o contrato revisado.");
    await imported("s:2", "Nota fiscal de outubro", "Valor da cobrança.");
    await index();
    const found = await as().search({ query: "propo", mailboxId: null });
    expect(ids(found)).toEqual([proposal.id]);
    const listed = (await as().items({ mailboxId: null, folder: "inbox" })).items.find(
      (item) => item.id === proposal.id,
    );
    expect(found).toEqual({
      items: [{ ...listed, folder: "inbox" }],
      nextCursor: null,
      tooShort: false,
    });
  });

  it("reads operators and checks phrases on the message, in order", async () => {
    const proposal = await imported(
      "o:1",
      "Proposta para o piloto",
      "Segue o contrato revisado hoje.",
    );
    const invoice = await imported("o:2", "Nota fiscal", "Revisado o contrato de outubro.");
    await index();
    const search = (query: string) => as().search({ query, mailboxId });
    expect(ids(await search("contrato revisado"))).toEqual([invoice.id, proposal.id]);
    expect(ids(await search('"contrato revisado"'))).toEqual([proposal.id]);
    expect(ids(await search('"revisado o contrato"'))).toEqual([invoice.id]);
    expect(ids(await search("assunto:nota"))).toEqual([invoice.id]);
    expect(ids(await search("subject:nota"))).toEqual([invoice.id]);
    expect(ids(await search("de:ana"))).toEqual([invoice.id, proposal.id]);
    expect(ids(await search("from:ana para:ninguem"))).toEqual([]);
    expect(await search("a !")).toEqual({ items: [], nextCursor: null, tooShort: true });
  });

  it("labels folders, leaves Trash out of all and finds it in Trash", async () => {
    const gone = await imported("f:1", "Relatório antigo", "texto");
    const kept = await imported("f:2", "Relatório novo", "texto");
    const draft = await as().saveDraft({
      mailboxId,
      expectedRevision: 0,
      to: ["ana@cliente.invalid"],
      subject: "Relatório rascunho",
      text: "texto",
      retainedAttachments: [],
      uploads: [],
    });
    await setMailboxItemTrash(db, actor(), {
      mailboxId,
      id: gone.id,
      expectedRevision: 1,
      trashed: true,
    });
    await index();
    const all = await as().search({ query: "relatorio", mailboxId });
    expect(all.items.map((item) => [item.id, item.folder])).toEqual([
      [draft.id, "drafts"],
      [kept.id, "inbox"],
    ]);
    const trash = await as().search({ query: "relatorio", mailboxId, folder: "trash" });
    expect(trash.items.map((item) => [item.id, item.folder])).toEqual([[gone.id, "trash"]]);
  });

  it("pages with a cursor and searches only mailboxes the person can read", async () => {
    const first = await imported("p:1", "Pedido 1", "texto");
    const second = await imported("p:2", "Pedido 2", "texto");
    const third = await imported("p:3", "Pedido 3", "texto");
    await index();
    const page = await as().search({ query: "pedido", mailboxId: null, limit: 2 });
    expect(ids(page)).toEqual([third.id, second.id]);
    expect(page.nextCursor).toEqual(expect.any(String));
    const rest = await as().search({
      query: "pedido",
      mailboxId: null,
      limit: 2,
      cursor: page.nextCursor!,
    });
    expect(ids(rest)).toEqual([first.id]);
    expect(rest.nextCursor).toBeNull();
    // A member without a grant finds nothing, and cannot name the mailbox.
    expect(ids(await as("member").search({ query: "pedido", mailboxId: null }))).toEqual([]);
    await expect(as("member").search({ query: "pedido", mailboxId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await grantMailboxRegistry(db, actor(), { mailboxId, userId: "member", permission: "read" });
    expect(ids(await as("member").search({ query: "pedido", mailboxId }))).toEqual([
      third.id,
      second.id,
      first.id,
    ]);
  });

  it("finds nothing until the worker has indexed the message", async () => {
    const fresh = await imported("i:1", "Recém chegado", "texto");
    expect(ids(await as().search({ query: "chegado", mailboxId }))).toEqual([]);
    await index();
    expect(ids(await as().search({ query: "chegado", mailboxId }))).toEqual([fresh.id]);
    await db.delete(schema.mailboxItems).where(eq(schema.mailboxItems.id, fresh.id));
    expect(ids(await as().search({ query: "chegado", mailboxId }))).toEqual([]);
  });
});
