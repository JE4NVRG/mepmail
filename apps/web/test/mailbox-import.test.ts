import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ImapError,
  type ImapFolder,
  type ImapImportSession,
} from "@/server/mailbox-migration/imap";
import {
  cancelMailboxImport,
  importTarget,
  listMailboxImports,
  mailboxImportStatus,
  resetMailboxImports,
  resumeMailboxImport,
  startMailboxImport,
} from "@/server/mailbox-migration/import";
import { EnvKeyring } from "../../../packages/core/src/crypto/keyring.js";
import { importMailboxMime } from "../../../packages/core/src/mailbox-private-store.js";
import { createMailboxRegistry } from "../../../packages/core/src/mailbox-registry.js";

const base = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
let client: PGlite;
let db: Db;
let teamId: string;
let mailboxId: string;
const owner = () => ({ teamId, userId: "owner" });

type Remote = Record<string, { flags?: string[]; validity: number; uids: number[] }>;
const raw = (folder: string, uid: number) =>
  Buffer.from(
    `From: ana@old.example\r\nSubject: ${folder} ${uid}\r\nMessage-ID: <${folder}-${uid}@old.example>\r\n\r\nBody ${uid}\r\n`,
  );

/** A remote account; `failAfterFetches` drops the connection like a network error. */
function account(remote: Remote, options: { failAfterFetches?: number; password?: string } = {}) {
  const calls: string[] = [];
  let fetches = 0;
  const open = vi.fn(async (input: { password: string }) => {
    if (input.password !== (options.password ?? "app-password")) throw new ImapError("login");
    let current = "";
    const session: ImapImportSession = {
      list: async () =>
        Object.entries(remote).map(
          ([name, f]): ImapFolder => ({ name, display: name, flags: f.flags ?? [] }),
        ),
      examine: async (name) => {
        current = name;
        calls.push(`EXAMINE ${name}`);
        const folder = remote[name]!;
        return { exists: folder.uids.length, uidValidity: folder.validity, uidNext: null };
      },
      uidSearchAfter: async (after) => remote[current]!.uids.filter((uid) => uid > after),
      uidFetchSizes: async (uids) => new Map(uids.map((uid) => [uid, raw(current, uid).length])),
      uidFetchMessages: async (uids) => {
        fetches += 1;
        if (options.failAfterFetches !== undefined && fetches > options.failAfterFetches)
          throw new ImapError("network");
        calls.push(`FETCH ${current} ${uids.join(",")}`);
        return uids.map((uid) => ({
          uid,
          flags: uid === 1 ? ["\\seen"] : [],
          internalDate: new Date(Date.UTC(2024, 0, uid)),
          raw: raw(current, uid),
        }));
      },
      fetchHeaders: async () => [],
      logout: async () => {},
    };
    return session;
  });
  return { open, calls };
}

function settled() {
  let resolve!: (id: string) => void;
  const done = new Promise<string>((r) => {
    resolve = r;
  });
  return { done, onSettled: (id: string) => resolve(id) };
}

const startInput = (
  folders: { name: string; target: "inbox" | "sent" | "archive" | "folder" }[] = [
    { name: "INBOX", target: "inbox" },
  ],
) => ({
  host: "imap.old.example",
  port: 993,
  username: "ana@old.example",
  password: "app-password",
  mailboxId,
  folders,
});

beforeEach(async () => {
  resetMailboxImports();
  client = new PGlite();
  for (const name of readdirSync(base)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await client.transaction(async (tx) => {
      for (const statement of readFileSync(base + name, "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => s.trim()))
        await tx.exec(statement);
    });
  const database = drizzle(client, { schema });
  db = database as unknown as Db;
  await migrate(database, { migrationsFolder: extension, migrationsTable: "__mailbox_migrations" });
  const [team] = await db
    .insert(schema.teams)
    .values({ name: "Import", slug: "import" })
    .returning();
  teamId = team!.id;
  await db
    .insert(schema.user)
    .values({ id: "owner", name: "owner", email: "owner@example.invalid", emailVerified: true });
  await db.insert(schema.teamMembers).values({ teamId, userId: "owner", role: "owner" });
  const now = Date.now();
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "active",
    seats: 5,
    storageBytesPerMailbox: 64 * 1024 * 1024,
    includedOutboundPerMailbox: 10,
    periodStart: new Date(now - 86400000),
    periodEnd: new Date(now + 86400000),
  });
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "new.invalid", status: "verified", region: "us-east-1" })
    .returning();
  mailboxId = (
    await createMailboxRegistry(db, owner(), {
      domainId: domain!.id,
      localPart: "ana",
      label: "Ana",
      kind: "person",
      ownerUserId: "owner",
    })
  ).id;
});
afterEach(async () => {
  await client.close();
});

describe("IMAP history import", () => {
  it("maps remote folders to Correio by their special-use flags", () => {
    const f = (name: string, flags: string[] = []) => ({ name, display: name, flags });
    expect(importTarget(f("INBOX"))).toBe("inbox");
    expect(importTarget(f("Sent Items", ["\\sent"]))).toBe("sent");
    expect(importTarget(f("[Gmail]/All Mail", ["\\all"]))).toBe("archive");
    expect(importTarget(f("Projetos"))).toBe("folder");
    for (const flag of ["\\trash", "\\junk", "\\drafts", "\\noselect"])
      expect(importTarget(f("x", [flag]))).toBeNull();
  });

  it("imports every chosen folder with its kind, date and read state, and never keeps the password", async () => {
    const remote: Remote = {
      INBOX: { validity: 5, uids: [1, 2, 3] },
      "Sent Items": { flags: ["\\sent"], validity: 9, uids: [1, 2] },
    };
    const { open } = account(remote);
    const importItem = vi.fn(async () => ({}));
    const { done, onSettled } = settled();
    const job = await startMailboxImport(
      db,
      keys,
      owner(),
      startInput([
        { name: "INBOX", target: "inbox" },
        { name: "Sent Items", target: "sent" },
      ]),
      { open, importItem: importItem as never, onSettled },
    );
    expect(job.state).toBe("running");
    await done;
    const status = await mailboxImportStatus(db, owner(), job.jobId);
    expect(status).toMatchObject({ state: "done", imported: 5, failed: 0, skipped: 0 });
    expect(status.folders.map((f) => [f.name, f.total, f.imported])).toEqual([
      ["INBOX", 3, 3],
      ["Sent Items", 2, 2],
    ]);
    const calls = importItem.mock.calls.map((c) => (c as unknown[])[3] as Record<string, unknown>);
    expect(calls[0]).toMatchObject({
      mailboxId,
      history: {
        kind: "inbox",
        seen: true,
        archived: false,
        receivedAt: new Date(Date.UTC(2024, 0, 1)),
      },
    });
    expect(calls[1]).toMatchObject({ history: { kind: "inbox", seen: false } });
    expect(calls[3]).toMatchObject({ history: { kind: "sent", seen: true } });
    expect(new Set(calls.map((c) => c.sourceId)).size).toBe(5);
    const [row] = await db.select().from(schema.mailboxImportJobs);
    expect(JSON.stringify(row)).not.toContain("app-password");
  });

  it("stops as interrupted on a network drop and resumes after the last saved UID", async () => {
    const remote: Remote = {
      INBOX: { validity: 5, uids: Array.from({ length: 60 }, (_, i) => i + 1) },
    };
    const first = account(remote, { failAfterFetches: 1 });
    const imported: string[] = [];
    const importItem = vi.fn(
      async (_db: unknown, _k: unknown, _a: unknown, input: { sourceId: string }) => {
        imported.push(input.sourceId);
        return {};
      },
    );
    const run1 = settled();
    const job = await startMailboxImport(db, keys, owner(), startInput(), {
      open: first.open,
      importItem: importItem as never,
      onSettled: run1.onSettled,
    });
    await run1.done;
    expect(await mailboxImportStatus(db, owner(), job.jobId)).toMatchObject({
      state: "interrupted",
      error: "network",
      imported: 25,
    });
    await expect(
      resumeMailboxImport(
        db,
        keys,
        owner(),
        { jobId: job.jobId, password: "wrong" },
        {
          open: account(remote).open,
          importItem: importItem as never,
        },
      ).then(() => new Promise((r) => setTimeout(r, 50))),
    ).resolves.toBeUndefined();
    const run2 = settled();
    const second = account(remote);
    await resumeMailboxImport(
      db,
      keys,
      owner(),
      { jobId: job.jobId, password: "app-password" },
      { open: second.open, importItem: importItem as never, onSettled: run2.onSettled },
    ).catch(async () => {
      // The wrong-password run above may still be failing the job; wait and retry.
      await new Promise((r) => setTimeout(r, 50));
      return resumeMailboxImport(
        db,
        keys,
        owner(),
        { jobId: job.jobId, password: "app-password" },
        { open: second.open, importItem: importItem as never, onSettled: run2.onSettled },
      );
    });
    await run2.done;
    expect(await mailboxImportStatus(db, owner(), job.jobId)).toMatchObject({
      state: "done",
      imported: 60,
    });
    // Resumed after UID 25: nothing fetched twice.
    expect(second.calls.filter((c) => c.startsWith("FETCH")).join(" ")).not.toMatch(/\b(1|25),/);
    expect(new Set(imported).size).toBe(60);
  });

  it("imports into the mailbox for real and stays idempotent across runs", async () => {
    const remote: Remote = { INBOX: { validity: 5, uids: [1, 2] } };
    for (let run = 0; run < 2; run++) {
      const { done, onSettled } = settled();
      await startMailboxImport(db, keys, owner(), startInput(), {
        open: account(remote).open,
        importItem: importMailboxMime,
        onSettled,
      });
      await done;
    }
    expect(
      await db
        .select()
        .from(schema.mailboxItems)
        .where(eq(schema.mailboxItems.mailboxId, mailboxId)),
    ).toHaveLength(2);
    const items = await db
      .select()
      .from(schema.mailboxItems)
      .where(eq(schema.mailboxItems.mailboxId, mailboxId));
    // The history keeps the original date and read state, so it does not show up as new mail.
    const first = items.find((i) => i.createdAt.getTime() === Date.UTC(2024, 0, 1));
    const second = items.find((i) => i.createdAt.getTime() === Date.UTC(2024, 0, 2));
    expect(first?.seenAt).not.toBeNull();
    expect(second?.seenAt).toBeNull();
    expect((await listMailboxImports(db, owner(), null)).length).toBe(2);
    const jobs = await listMailboxImports(db, owner(), mailboxId);
    expect(jobs.map((j) => [j.state, j.imported])).toEqual([
      ["done", 2],
      ["done", 2],
    ]);
  });

  it("refuses a wrong password, someone else's mailbox and a second run on the same mailbox", async () => {
    const remote: Remote = { INBOX: { validity: 5, uids: [1] } };
    await expect(
      startMailboxImport(
        db,
        keys,
        owner(),
        { ...startInput(), password: "nope" },
        { open: account(remote).open },
      ),
    ).rejects.toMatchObject({ code: "login" });
    await expect(
      startMailboxImport(db, keys, { teamId, userId: "intruder" }, startInput(), {
        open: account(remote).open,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    const slow = account(remote);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const importItem = vi.fn(async () => {
      await gate;
      return {};
    });
    const { done, onSettled } = settled();
    const job = await startMailboxImport(db, keys, owner(), startInput(), {
      open: slow.open,
      importItem: importItem as never,
      onSettled,
    });
    await expect(
      startMailboxImport(db, keys, owner(), startInput(), { open: account(remote).open }),
    ).rejects.toMatchObject({ code: "running" });
    await cancelMailboxImport(db, owner(), job.jobId);
    release();
    await done;
    expect(await mailboxImportStatus(db, owner(), job.jobId)).toMatchObject({ state: "canceled" });
  });
});
