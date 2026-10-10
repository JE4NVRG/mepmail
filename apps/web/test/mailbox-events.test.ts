import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  createMailboxRegistry,
  EnvKeyring,
  grantMailboxRegistry,
  importMailboxMime,
  revokeMailboxRegistry,
  saveMailboxDraft,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { arrivalMailboxId } from "@/lib/mailbox-live";
import { arrivalEvent, parseMailboxArrival, readableMailboxIds } from "@/server/mailbox-events";
import { seedMailboxTestService } from "./mailbox-service-fixture";

let client: PGlite, db: Db, teamId: string, mailboxId: string, keys: EnvKeyring;
const folder = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const actor = () => ({ teamId, userId: "owner" });
const message = (subject: string) =>
  Buffer.from(
    `From: Ana <ana@example.invalid>\r\nTo: person@events.invalid\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nCorpo\r\n`,
  );
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(async () => {
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
  const [team] = await db.insert(schema.teams).values({ name: "Live", slug: "live" }).returning();
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
    .values({ teamId, name: "events.invalid", region: "us-east-1", status: "verified" })
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
});
afterEach(async () => {
  await client.close();
});

describe("live mailbox updates", () => {
  it("announces mail received now, by id only, and stays quiet for history and drafts", async () => {
    const heard: string[] = [];
    await client.listen("mailbox_arrivals", (payload) => heard.push(payload));
    await importMailboxMime(db, keys, actor(), {
      mailboxId,
      sourceId: "fixture:now",
      raw: message("Agora"),
    });
    await settle();
    expect(heard.map(parseMailboxArrival)).toEqual([{ teamId, mailboxId }]);
    expect(heard[0]).not.toContain("Agora");
    // A history import (imap: source, old date) and a draft never ring.
    await importMailboxMime(db, keys, actor(), {
      mailboxId,
      sourceId: "imap:0123456789abcdef0123456789abcdef",
      raw: message("Antiga"),
      history: {
        kind: "inbox",
        receivedAt: new Date(Date.UTC(2025, 0, 2)),
        seen: false,
        archived: false,
      },
    });
    await saveMailboxDraft(db, keys, actor(), {
      mailboxId,
      expectedRevision: 0,
      raw: message("Rascunho"),
    });
    await settle();
    expect(heard).toHaveLength(1);
  });

  it("streams only the mailboxes a person reads", async () => {
    expect(await readableMailboxIds(db, actor())).toEqual(new Set([mailboxId]));
    const member = { teamId, userId: "member" };
    expect(await readableMailboxIds(db, member)).toEqual(new Set());
    const grant = await grantMailboxRegistry(db, actor(), {
      mailboxId,
      userId: "member",
      permission: "read",
    });
    expect(await readableMailboxIds(db, member)).toEqual(new Set([mailboxId]));
    await revokeMailboxRegistry(db, actor(), grant.id);
    expect(await readableMailboxIds(db, member)).toEqual(new Set());
  });

  it("reads and writes the event format on both ends", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(arrivalEvent(id)).toBe(`event: arrival\ndata: {"mailboxId":"${id}"}\n\n`);
    expect(arrivalMailboxId(JSON.stringify({ mailboxId: id }))).toBe(id);
    expect(arrivalMailboxId("not json")).toBeNull();
    expect(parseMailboxArrival(JSON.stringify({ t: id, m: id }))).toEqual({
      teamId: id,
      mailboxId: id,
    });
    expect(parseMailboxArrival(JSON.stringify({ t: "x", m: id }))).toBeNull();
    expect(parseMailboxArrival("{")).toBeNull();
  });
});
