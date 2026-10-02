import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvKeyring } from "../../../packages/core/src/crypto/keyring.js";
import { createMailboxRegistry } from "../../../packages/core/src/mailbox-registry.js";
import {
  importMailboxMime,
  readMailboxItem,
  saveMailboxDraft,
} from "../../../packages/core/src/mailbox-private-store.js";
import { mailboxServiceState } from "../../../packages/core/src/mailbox-service.js";
import { seedMailboxTestService } from "./mailbox-service-fixture";

let client: PGlite, db: Db, teamId: string, domainId: string, keys: EnvKeyring;
const base = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const actor = () => ({ teamId, userId: "owner" });
const create = (localPart: string, kind: "person" | "agent" = "person") =>
  createMailboxRegistry(db, actor(), {
    domainId,
    localPart,
    kind,
    label: localPart,
    ownerUserId: "owner",
  });
const plan = (values: Partial<typeof schema.mailboxSubscriptions.$inferInsert>) =>
  db
    .update(schema.mailboxSubscriptions)
    .set(values)
    .where(eq(schema.mailboxSubscriptions.teamId, teamId));
beforeEach(async () => {
  client = new PGlite();
  for (const file of readdirSync(base)
    .filter((n) => n.endsWith(".sql") && n.slice(0, 4) <= "0042")
    .sort())
    for (const statement of readFileSync(base + file, "utf8")
      .split("--> statement-breakpoint")
      .filter((s) => s.trim()))
      await client.exec(statement);
  const database = drizzle(client, { schema });
  db = database as unknown as Db;
  await migrate(database, { migrationsFolder: extension, migrationsTable: "__mailbox_migrations" });
  const [team] = await db
    .insert(schema.teams)
    .values({ name: "Service fixture", slug: "service-fixture" })
    .returning();
  teamId = team!.id;
  await seedMailboxTestService(db, [teamId]);
  await db
    .insert(schema.user)
    .values({ id: "owner", name: "Owner", email: "owner@example.invalid", emailVerified: true });
  await db.insert(schema.teamMembers).values({ teamId, userId: "owner", role: "owner" });
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "service.invalid", region: "us-east-1", status: "verified" })
    .returning();
  domainId = domain!.id;
  keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
});
afterEach(async () => {
  await client.close();
});

describe("separate paid mailbox entitlement and included quotas", () => {
  it("requires a paid service and charges one seat equally for a person or agent", async () => {
    await plan({ seats: 2 });
    await create("person");
    await create("agent", "agent");
    await expect(create("extra")).rejects.toMatchObject({ code: "quota" });
    expect(await mailboxServiceState(db, teamId)).toMatchObject({
      active: true,
      seats: 2,
      reservedSeats: 2,
    });
    await db
      .delete(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    await expect(create("unpaid")).rejects.toMatchObject({ code: "not_entitled" });
    expect(await mailboxServiceState(db, teamId)).toMatchObject({
      active: false,
      seats: 0,
      reservedSeats: 2,
    });
  });
  it("keeps authorized reads recoverable while past due, canceled or expired but refuses new writes", async () => {
    const box = await create("person");
    const raw = Buffer.from("Private MIME fixture");
    const item = await importMailboxMime(db, keys, actor(), {
      mailboxId: box.id,
      sourceId: "fixture:read",
      raw,
    });
    for (const status of ["past_due", "canceled"] as const) {
      await plan({ status });
      expect(
        (await readMailboxItem(db, keys, actor(), { mailboxId: box.id, id: item.id })).raw.equals(
          raw,
        ),
      ).toBe(true);
      await expect(
        saveMailboxDraft(db, keys, actor(), { mailboxId: box.id, expectedRevision: 0, raw }),
      ).rejects.toMatchObject({ code: "not_entitled" });
    }
    await plan({ status: "active", periodEnd: new Date(Date.now() - 1000) });
    await expect(create("expired")).rejects.toMatchObject({ code: "not_entitled" });
    expect(
      (await readMailboxItem(db, keys, actor(), { mailboxId: box.id, id: item.id })).raw.equals(
        raw,
      ),
    ).toBe(true);
  });
  it("keeps downgraded seats readable and allocates write access deterministically", async () => {
    const a = await create("person");
    const b = await create("agent", "agent");
    const raw = Buffer.from("Private fixture");
    const item = await importMailboxMime(db, keys, actor(), {
      mailboxId: b.id,
      sourceId: "fixture:b",
      raw,
    });
    await plan({ seats: 1 });
    await saveMailboxDraft(db, keys, actor(), { mailboxId: a.id, expectedRevision: 0, raw });
    await expect(
      saveMailboxDraft(db, keys, actor(), { mailboxId: b.id, expectedRevision: 0, raw }),
    ).rejects.toMatchObject({ code: "not_entitled" });
    expect(
      (await readMailboxItem(db, keys, actor(), { mailboxId: b.id, id: item.id })).raw.equals(raw),
    ).toBe(true);
  });
  it("refuses mutations for a globally suspended team while preserving private recovery reads", async () => {
    const box = await create("person");
    const raw = Buffer.from("Private fixture");
    const item = await importMailboxMime(db, keys, actor(), {
      mailboxId: box.id,
      sourceId: "fixture:suspended",
      raw,
    });
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.teams.id, teamId));
    await expect(create("blocked")).rejects.toMatchObject({ code: "not_entitled" });
    await expect(
      saveMailboxDraft(db, keys, actor(), { mailboxId: box.id, expectedRevision: 0, raw }),
    ).rejects.toMatchObject({ code: "not_entitled" });
    expect(
      (await readMailboxItem(db, keys, actor(), { mailboxId: box.id, id: item.id })).raw.equals(
        raw,
      ),
    ).toBe(true);
  });
  it("counts actual MIME bytes per box, updates only the delta and does not double-charge a duplicate", async () => {
    const a = await create("person");
    const b = await create("other");
    await plan({ storageBytesPerMailbox: 100 });
    const raw = Buffer.alloc(60, 65);
    const one = await importMailboxMime(db, keys, actor(), {
      mailboxId: a.id,
      sourceId: "fixture:one",
      raw,
    });
    const duplicate = await importMailboxMime(db, keys, actor(), {
      mailboxId: a.id,
      sourceId: "fixture:one",
      raw,
    });
    expect(duplicate.id).toBe(one.id);
    const draft = await saveMailboxDraft(db, keys, actor(), {
      mailboxId: a.id,
      expectedRevision: 0,
      raw: Buffer.alloc(40, 66),
    });
    await expect(
      importMailboxMime(db, keys, actor(), {
        mailboxId: a.id,
        sourceId: "fixture:overflow",
        raw: Buffer.from("x"),
      }),
    ).rejects.toMatchObject({ code: "quota" });
    await saveMailboxDraft(db, keys, actor(), {
      mailboxId: a.id,
      id: draft.id,
      expectedRevision: 1,
      raw: Buffer.alloc(10, 67),
    });
    await importMailboxMime(db, keys, actor(), {
      mailboxId: a.id,
      sourceId: "fixture:fits",
      raw: Buffer.alloc(30, 68),
    });
    await importMailboxMime(db, keys, actor(), {
      mailboxId: b.id,
      sourceId: "fixture:independent",
      raw: Buffer.alloc(100, 69),
    });
    expect((await db.select().from(schema.mailboxItems)).length).toBe(4);
  });
});
