import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImapSession } from "@/server/mailbox-migration/imap";
import { resetMigrationState } from "@/server/mailbox-migration/service";
import { mailboxesRouter } from "@/server/routers/mailboxes";
import { type Context, createCallerFactory, router } from "@/server/trpc";
import { seedMailboxTestService } from "./mailbox-service-fixture";

const imap = vi.hoisted(() => ({ open: vi.fn(), hold: null as Promise<void> | null }));
vi.mock("@/server/mailbox-migration/imap", async (original) => ({
  ...(await original<typeof import("@/server/mailbox-migration/imap")>()),
  openImap: imap.open,
}));
vi.mock("node:dns/promises", async (original) => ({
  ...(await original<typeof import("node:dns/promises")>()),
  resolveMx: vi.fn(async () => [{ exchange: "mailserver.purelymail.com", priority: 50 }]),
}));

let client: PGlite, db: Db, team: string, domain: string, jean: string;
const folder = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const caller = createCallerFactory(router({ mailboxes: mailboxesRouter }));
const as = (userId = "owner", role: Context["role"] = "owner") =>
  caller({
    db,
    teamId: team,
    role,
    session: { user: { id: userId, name: userId, email: `${userId}@example.test` } },
  }).mailboxes.migration;

function fakeSession(): ImapSession {
  const inbox = [
    { header: "To: jean@piloto.test\r\nCc: friend@gmail.example\r\n", date: "2026-08-01" },
    { header: "Delivered-To: contato@piloto.test\r\n", date: "2026-09-01" },
    { header: "Delivered-To: vendas@piloto.test\r\nTo: x@else.example\r\n", date: "2026-09-02" },
  ];
  return {
    list: async () => [{ name: "INBOX", display: "INBOX", flags: [] }],
    examine: async () => {
      await imap.hold;
      return { exists: inbox.length };
    },
    fetchHeaders: async (from, to) =>
      inbox.slice(from - 1, to).map((m) => ({ header: m.header, internalDate: new Date(m.date) })),
    logout: async () => {},
  };
}
const connectInput = {
  provider: "purelymail" as const,
  host: "imap.purelymail.com",
  port: 993,
  secure: true as const,
  username: "jean@piloto.test",
  password: "not-stored",
};
async function scanned(sourceId: string) {
  for (let i = 0; i < 50; i++) {
    const status = await as().status({ sourceId });
    if (status.phase !== "scanning") return status;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("scan did not finish");
}

beforeEach(async () => {
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  resetMigrationState();
  imap.hold = null;
  imap.open.mockReset();
  imap.open.mockImplementation(async () => fakeSession());
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
  [{ id: team }] = (await db
    .insert(schema.teams)
    .values({ name: "Local", slug: "migration-local" })
    .returning({ id: schema.teams.id })) as [{ id: string }];
  await seedMailboxTestService(db, [team]);
  for (const id of ["owner", "member", "other"])
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.test`, emailVerified: true });
  await db.insert(schema.teamMembers).values([
    { teamId: team, userId: "owner", role: "owner" },
    { teamId: team, userId: "member", role: "member" },
    { teamId: team, userId: "other", role: "admin" },
  ]);
  [{ id: domain }] = (await db
    .insert(schema.domains)
    .values({ teamId: team, name: "piloto.test", region: "us-east-1", status: "verified" })
    .returning({ id: schema.domains.id })) as [{ id: string }];
  jean = (
    await caller({
      db,
      teamId: team,
      role: "owner",
      session: { user: { id: "owner", name: "owner", email: "owner@example.test" } },
    }).mailboxes.create({
      domainId: domain,
      localPart: "jean",
      label: "Jean",
      kind: "person",
      ownerUserId: "owner",
    })
  ).id;
});
afterEach(async () => {
  await client.close();
  vi.unstubAllEnvs();
});

describe("mailbox migration assistant", () => {
  it("discovers own-domain addresses, plans, applies and reports MX readiness", async () => {
    const { sourceId, folders } = await as().connect(connectInput);
    expect(folders).toEqual(["INBOX"]);
    expect(imap.open.mock.calls[0]?.[0]).toMatchObject({
      host: "imap.purelymail.com",
      port: 993,
      username: "jean@piloto.test",
    });
    const status = await scanned(sourceId);
    expect(status).toMatchObject({ phase: "scanned", messagesSeen: 3, failure: null });
    expect(status.addresses.map((a) => [a.address, a.inMepMail])).toEqual(
      expect.arrayContaining([
        ["jean@piloto.test", "mailbox"],
        ["contato@piloto.test", null],
        ["vendas@piloto.test", null],
      ]),
    );
    expect(status.addresses).toHaveLength(3);
    expect(status.externalByDomain).toEqual(
      expect.arrayContaining([
        { domain: "gmail.example", messages: 1 },
        { domain: "else.example", messages: 1 },
      ]),
    );
    const items = [
      {
        address: "contato@piloto.test",
        action: "alias" as const,
        mailboxId: jean,
        ownerUserId: null,
        label: null,
      },
      {
        address: "vendas@piloto.test",
        action: "mailbox" as const,
        mailboxId: null,
        ownerUserId: "owner",
        label: "Vendas",
      },
      {
        address: "jean@piloto.test",
        action: "mailbox" as const,
        mailboxId: null,
        ownerUserId: "owner",
        label: null,
      },
      {
        address: "ignored@piloto.test",
        action: "ignore" as const,
        mailboxId: null,
        ownerUserId: null,
        label: null,
      },
      {
        address: "x@nowhere.example",
        action: "alias" as const,
        mailboxId: jean,
        ownerUserId: null,
        label: null,
      },
      {
        address: "bad local@piloto.test",
        action: "mailbox" as const,
        mailboxId: null,
        ownerUserId: "owner",
        label: null,
      },
    ];
    expect(await as().plan({ sourceId, items })).toEqual({
      results: [
        { address: "contato@piloto.test", outcome: "ok" },
        { address: "vendas@piloto.test", outcome: "ok" },
        { address: "jean@piloto.test", outcome: "exists" },
        { address: "ignored@piloto.test", outcome: "ignored" },
        { address: "x@nowhere.example", outcome: "domain_missing" },
        { address: "bad local@piloto.test", outcome: "invalid" },
      ],
      newMailboxes: 1,
      newAliases: 1,
      licensesNeeded: 0,
    });
    const applied = await as().applyPlan({ sourceId, items });
    expect(applied.results.map((r) => [r.address, r.outcome])).toEqual([
      ["contato@piloto.test", "created_alias"],
      ["vendas@piloto.test", "created_mailbox"],
      ["jean@piloto.test", "skipped"],
      ["ignored@piloto.test", "skipped"],
      ["x@nowhere.example", "skipped"],
      ["bad local@piloto.test", "skipped"],
    ]);
    const after = await as().status({ sourceId });
    expect(Object.fromEntries(after.addresses.map((a) => [a.address, a.inMepMail]))).toEqual({
      "jean@piloto.test": "mailbox",
      "contato@piloto.test": "alias",
      "vendas@piloto.test": "mailbox",
    });
    expect(await as().mxReadiness({ sourceId })).toEqual({
      domains: [
        {
          domain: "piloto.test",
          domainId: domain,
          pending: [],
          recipients: 3,
          recipientCap: 100,
          receivingState: expect.any(String),
          mx: { exchange: "mailserver.purelymail.com", priority: 50 },
        },
      ],
    });
    const actions = (await db.select().from(schema.auditLog)).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining(["mailbox.migration_connected", "mailbox.migration_applied"]),
    );
    expect(JSON.stringify(await db.select().from(schema.auditLog))).not.toContain("not-stored");
  });
  it("marks mailboxes beyond the licensed seats as needs_license", async () => {
    await db
      .update(schema.mailboxSubscriptions)
      .set({ seats: 2 })
      .where(eq(schema.mailboxSubscriptions.teamId, team));
    const { sourceId } = await as().connect(connectInput);
    await scanned(sourceId);
    const plan = await as().plan({
      sourceId,
      items: ["a", "b"].map((local) => ({
        address: `${local}@piloto.test`,
        action: "mailbox" as const,
        mailboxId: null,
        ownerUserId: "owner",
        label: null,
      })),
    });
    expect(plan.results.map((r) => r.outcome)).toEqual(["ok", "needs_license"]);
    expect(plan.licensesNeeded).toBe(1);
  });
  it("is for owners and admins only, keeps a source private to who connected, and maps failures", async () => {
    await expect(as("member", "member").connect(connectInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const { sourceId } = await as().connect(connectInput);
    await scanned(sourceId);
    expect(await as("other", "admin").status({ sourceId })).toMatchObject({
      phase: "failed",
      failure: "reconnect",
      addresses: [],
    });
    await expect(as("other", "admin").mxReadiness({ sourceId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const { ImapError } = await import("@/server/mailbox-migration/imap");
    imap.open.mockRejectedValueOnce(new ImapError("login"));
    await expect(as().connect(connectInput)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "login",
    });
    imap.open.mockRejectedValueOnce(new ImapError("blocked"));
    await expect(as().connect({ ...connectInput, host: "10.0.0.5" })).rejects.toMatchObject({
      message: "blocked",
    });
  });
  it("runs one scan per team at a time and limits sign-ins per hour", async () => {
    let release!: () => void;
    imap.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = await as().connect(connectInput);
    await expect(as().connect(connectInput)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "busy",
    });
    release();
    await scanned(first.sourceId);
    // The refused "busy" attempt does not count: ten sign-ins in total, then the limit.
    for (let i = 0; i < 9; i++) await scanned((await as().connect(connectInput)).sourceId);
    await expect(as().connect(connectInput)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});
