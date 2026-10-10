import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvKeyring, type Keyring } from "../../../packages/core/src/crypto/keyring.js";
import {
  importMailboxMime,
  listMailboxItems,
  type MailboxContentActor,
  readMailboxItem,
  saveMailboxDraft,
  setMailboxDeliveryFolder,
} from "../../../packages/core/src/mailbox-private-store.js";
import {
  createMailboxRegistry,
  grantMailboxRegistry,
  revokeMailboxRegistry,
  updateMailboxRegistry,
} from "../../../packages/core/src/mailbox-registry.js";
import { seedMailboxTestService } from "./mailbox-service-fixture";

let client: PGlite,
  db: Db,
  teamId: string,
  otherTeam: string,
  mailboxId: string,
  agentId: string,
  foreignId: string,
  keyring: Keyring;
const folder = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const mime = Buffer.from(
  "From: sender@example.invalid\r\nTo: person@example.invalid\r\nSubject: Private fixture subject\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=local\r\n\r\n--local\r\nContent-Type: text/plain\r\n\r\nPrivate fixture body\r\n--local\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=secret.txt\r\nContent-Transfer-Encoding: base64\r\n\r\ncHJpdmF0ZS1hdHRhY2htZW50\r\n--local--\r\n",
);
const owner = () => ({ teamId, userId: "owner" });
const member = () => ({ teamId, userId: "member" });
const read = (id: string, actor: MailboxContentActor = owner(), box = mailboxId, keys = keyring) =>
  readMailboxItem(db, keys, actor, { mailboxId: box, id });
const imported = (sourceId = "fixture:1", box = mailboxId, raw = mime, keys = keyring) =>
  importMailboxMime(db, keys, owner(), { mailboxId: box, sourceId, raw });

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
  const teams = await db
    .insert(schema.teams)
    .values([
      { name: "Private", slug: "private" },
      { name: "Foreign", slug: "foreign" },
    ])
    .returning();
  teamId = teams[0]!.id;
  otherTeam = teams[1]!.id;
  await seedMailboxTestService(db, [teamId, otherTeam]);
  for (const id of ["owner", "member", "admin", "outsider"])
    await db
      .insert(schema.user)
      .values({ id, name: id, email: id + "@example.invalid", emailVerified: true });
  await db.insert(schema.teamMembers).values([
    { teamId, userId: "owner", role: "owner" },
    { teamId, userId: "member", role: "member" },
    { teamId, userId: "admin", role: "admin" },
    { teamId: otherTeam, userId: "outsider", role: "owner" },
  ]);
  const domains = await db
    .insert(schema.domains)
    .values([
      { teamId, name: "private.invalid", region: "us-east-1" },
      { teamId: otherTeam, name: "foreign.invalid", region: "us-east-1" },
    ])
    .returning();
  mailboxId = (
    await createMailboxRegistry(db, owner(), {
      domainId: domains[0]!.id,
      localPart: "person",
      label: "Person",
      kind: "person",
      ownerUserId: "owner",
    })
  ).id;
  agentId = (
    await createMailboxRegistry(db, owner(), {
      domainId: domains[0]!.id,
      localPart: "agent",
      label: "Agent",
      kind: "agent",
      ownerUserId: "owner",
    })
  ).id;
  foreignId = (
    await createMailboxRegistry(
      db,
      { teamId: otherTeam, userId: "outsider" },
      {
        domainId: domains[1]!.id,
        localPart: "other",
        label: "Other",
        kind: "person",
        ownerUserId: "outsider",
      },
    )
  ).id;
  keyring = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
});
afterEach(async () => {
  await client.close();
});

describe("private mailbox persistence", () => {
  it("lets only the human owner classify inbound messages with a current revision, preserving encrypted bytes", async () => {
    const item = await imported();
    await grantMailboxRegistry(db, owner(), { mailboxId, userId: "member", permission: "draft" });
    for (const actor of [
      member(),
      { teamId, userId: "admin" },
      { ...owner(), supportView: true },
      { ...owner(), agentAccess: true },
    ])
      await expect(
        setMailboxDeliveryFolder(db, actor, {
          mailboxId,
          id: item.id,
          expectedRevision: 1,
          folder: "spam",
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
    const moved = await setMailboxDeliveryFolder(db, owner(), {
      mailboxId,
      id: item.id,
      expectedRevision: 1,
      folder: "spam",
    });
    expect(moved).toMatchObject({ deliveryFolder: "spam", revision: 2 });
    expect((await read(item.id)).raw.equals(mime)).toBe(true);
    await expect(read(item.id, { ...owner(), agentAccess: true })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await listMailboxItems(db, { ...owner(), agentAccess: true }, mailboxId)).toHaveLength(
      0,
    );
    await expect(
      setMailboxDeliveryFolder(db, owner(), {
        mailboxId,
        id: item.id,
        expectedRevision: 1,
        folder: "inbox",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await setMailboxDeliveryFolder(db, owner(), {
      mailboxId,
      id: item.id,
      expectedRevision: 2,
      folder: "inbox",
    });
    expect((await read(item.id, { ...owner(), agentAccess: true })).raw.equals(mime)).toBe(true);
  });
  it("round-trips personal and agent MIME including private attachments without plaintext content columns", async () => {
    const person = await imported();
    const agent = await imported("fixture:1", agentId);
    expect((await read(person.id)).raw.equals(mime)).toBe(true);
    expect((await read(agent.id, owner(), agentId)).raw.equals(mime)).toBe(true);
    const [stored] = await db
      .select()
      .from(schema.mailboxItems)
      .where(eq(schema.mailboxItems.id, person.id));
    expect(Buffer.from(stored!.ciphertext).includes(Buffer.from("Private fixture subject"))).toBe(
      false,
    );
    expect(JSON.stringify(stored)).not.toContain("secret.txt");
    expect(stored!.keyVersion).toBeGreaterThanOrEqual(2000000);
    const rows = await listMailboxItems(db, owner(), mailboxId);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!)).not.toContain("ciphertext");
  });
  it("enforces current read/draft grants; admin and support-view have no implicit content access", async () => {
    const item = await imported();
    await expect(read(item.id, member())).rejects.toMatchObject({ code: "forbidden" });
    await expect(read(item.id, { teamId, userId: "admin" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      readMailboxItem(db, keyring, { ...owner(), supportView: true }, { mailboxId, id: item.id }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const grant = await grantMailboxRegistry(db, owner(), {
      mailboxId,
      userId: "member",
      permission: "read",
    });
    expect((await read(item.id, member())).raw.equals(mime)).toBe(true);
    await expect(
      saveMailboxDraft(db, keyring, member(), { mailboxId, expectedRevision: 0, raw: mime }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      importMailboxMime(db, keyring, member(), { mailboxId, sourceId: "not-owner", raw: mime }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await revokeMailboxRegistry(db, owner(), grant.id);
    await expect(read(item.id, member())).rejects.toMatchObject({ code: "forbidden" });
  });
  it("suspension and membership reincarnation invalidate content rights without deleting bytes", async () => {
    const item = await imported();
    await grantMailboxRegistry(db, owner(), { mailboxId, userId: "member", permission: "draft" });
    await updateMailboxRegistry(db, owner(), {
      id: mailboxId,
      label: "Person",
      ownerUserId: "owner",
      status: "suspended",
    });
    await expect(read(item.id)).rejects.toMatchObject({ code: "forbidden" });
    await updateMailboxRegistry(db, owner(), {
      id: mailboxId,
      label: "Person",
      ownerUserId: "owner",
      status: "planned",
    });
    await db
      .delete(schema.teamMembers)
      .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, "member")));
    await db.insert(schema.teamMembers).values({ teamId, userId: "member", role: "member" });
    await expect(read(item.id, member())).rejects.toMatchObject({ code: "forbidden" });
    await db
      .delete(schema.teamMembers)
      .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, "owner")));
    await db.insert(schema.teamMembers).values({ teamId, userId: "owner", role: "owner" });
    await expect(read(item.id)).rejects.toMatchObject({ code: "forbidden" });
    expect(await db.select().from(schema.mailboxItems)).toHaveLength(1);
  });
  it("scopes item identity by mailbox and team and rejects forged composite foreign keys", async () => {
    const item = await imported();
    await expect(read(item.id, owner(), agentId)).rejects.toMatchObject({ code: "not_found" });
    await expect(read(item.id, { teamId: otherTeam, userId: "outsider" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(read(item.id, owner(), foreignId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      db
        .update(schema.mailboxItems)
        .set({ teamId: otherTeam })
        .where(eq(schema.mailboxItems.id, item.id)),
    ).rejects.toThrow();
  });
  it("serializes idempotent imports and rejects reused source with different MIME", async () => {
    const result = await Promise.all([imported(), imported()]);
    expect(result[0]!.id).toBe(result[1]!.id);
    await expect(imported("fixture:1", mailboxId, Buffer.from("different"))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await db.select().from(schema.mailboxItems)).toHaveLength(1);
  });
  it("uses optimistic draft revisions and never replaces inbox or a foreign-box draft", async () => {
    await grantMailboxRegistry(db, owner(), { mailboxId, userId: "member", permission: "draft" });
    const draft = await saveMailboxDraft(db, keyring, member(), {
      mailboxId,
      expectedRevision: 0,
      raw: mime,
    });
    const updates = await Promise.allSettled(
      [1, 2].map((n) =>
        saveMailboxDraft(db, keyring, member(), {
          mailboxId,
          id: draft.id,
          expectedRevision: 1,
          raw: Buffer.from(`draft ${n}`),
        }),
      ),
    );
    expect(updates.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(updates.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await read(draft.id)).revision).toBe(2);
    const inbox = await imported();
    await expect(
      saveMailboxDraft(db, keyring, owner(), {
        mailboxId,
        id: inbox.id,
        expectedRevision: 1,
        raw: mime,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      saveMailboxDraft(db, keyring, owner(), {
        mailboxId: agentId,
        id: draft.id,
        expectedRevision: 2,
        raw: mime,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  it("fails closed for swapped envelopes, tampering and missing keys, preserving existing items", async () => {
    const person = await imported();
    const agent = await imported("fixture:2", agentId);
    const [stored] = await db
      .select()
      .from(schema.mailboxItems)
      .where(eq(schema.mailboxItems.id, person.id));
    const envelope = {
      ciphertext: stored!.ciphertext,
      iv: stored!.iv,
      wrappedDek: stored!.wrappedDek,
      keyVersion: stored!.keyVersion,
    };
    await db.update(schema.mailboxItems).set(envelope).where(eq(schema.mailboxItems.id, agent.id));
    await expect(read(agent.id, owner(), agentId)).rejects.toThrow();
    const corrupted = Buffer.from(stored!.ciphertext);
    corrupted[0] = corrupted[0]! ^ 1;
    await db
      .update(schema.mailboxItems)
      .set({ ciphertext: corrupted })
      .where(eq(schema.mailboxItems.id, person.id));
    await expect(read(person.id)).rejects.toThrow();
    const wrong = new EnvKeyring(new Map([[2, randomBytes(32)]]), 2);
    await expect(read(person.id, owner(), mailboxId, wrong)).rejects.toThrow();
    await expect(
      db
        .update(schema.mailboxItems)
        .set({ keyVersion: 1 })
        .where(eq(schema.mailboxItems.id, person.id)),
    ).rejects.toThrow();
    expect(await db.select().from(schema.mailboxItems)).toHaveLength(2);
  });
  it("rolls back failed encryption and bounds payloads without storing partial data", async () => {
    const broken: Keyring = {
      wrapDek: async () => {
        throw new Error("fixture key unavailable");
      },
      unwrapDek: keyring.unwrapDek.bind(keyring),
    };
    await expect(imported("broken", mailboxId, mime, broken)).rejects.toThrow(
      "fixture key unavailable",
    );
    await expect(imported("empty", mailboxId, Buffer.alloc(0))).rejects.toMatchObject({
      code: "invalid",
    });
    // Received and imported mail is kept up to 25 MiB (migration 0026), not 1 MiB.
    await expect(
      imported("large", mailboxId, Buffer.alloc(25 * 1024 * 1024 + 1)),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await db.select().from(schema.mailboxItems)).toHaveLength(0);
    const big = Buffer.concat([mime, Buffer.alloc(2 * 1024 * 1024, 0x61)]);
    const stored = await imported("two-megabytes", mailboxId, big);
    expect((await read(stored.id)).raw.equals(big)).toBe(true);
  });
  it("snapshots caller bytes before asynchronous key operations", async () => {
    const mutable = Buffer.from(mime);
    const hook: Keyring = {
      wrapDek: async (dek, context) => {
        mutable.fill(0);
        return keyring.wrapDek(dek, context);
      },
      unwrapDek: keyring.unwrapDek.bind(keyring),
    };
    const item = await imported("mutable", mailboxId, mutable, hook);
    expect((await read(item.id)).raw.equals(mime)).toBe(true);
  });
});
