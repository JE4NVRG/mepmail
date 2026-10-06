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
import {
  createMailboxAgentKey,
  withMailboxAgentAccess,
} from "../../../packages/core/src/mailbox-agent-access.js";
import {
  importMailboxMime,
  readMailboxItem,
  saveMailboxDraft,
} from "../../../packages/core/src/mailbox-private-store.js";
import {
  createMailboxRegistry,
  listMailboxRegistry,
} from "../../../packages/core/src/mailbox-registry.js";
import {
  lockMailboxService,
  mailboxServiceState,
  requireMailboxSeat,
} from "../../../packages/core/src/mailbox-service.js";
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

describe("operator-owned System mailbox licence and separate resource policy", () => {
  const system = async () => {
    await plan({ seats: 2 });
    await db.update(schema.teams).set({ plan: "system" }).where(eq(schema.teams.id, teamId));
  };
  const rawPlan = async () => {
    const [row] = await db
      .select()
      .from(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    return row;
  };

  it("licenses more than two person/agent boxes without changing the audited allowance row", async () => {
    await system();
    const before = await rawPlan();
    await create("personal");
    await create("agent-one", "agent");
    const third = await create("agent-two", "agent");
    const raw = Buffer.from("Third box private draft");
    const draft = await saveMailboxDraft(db, keys, actor(), {
      mailboxId: third.id,
      expectedRevision: 0,
      raw,
    });
    expect(
      (await readMailboxItem(db, keys, actor(), { mailboxId: third.id, id: draft.id })).raw,
    ).toEqual(raw);
    expect(await mailboxServiceState(db, teamId)).toMatchObject({
      active: true,
      unlimitedSeats: true,
      licenseKind: "system",
      resourcePolicyActive: true,
      reservedSeats: 3,
    });
    const listed = await listMailboxRegistry(db, actor());
    expect(listed.mailboxes.find((box) => box.id === third.id)).toMatchObject({
      canDraft: true,
      canSend: true,
    });
    expect(await rawPlan()).toEqual(before);
    expect((await rawPlan())?.seats).toBe(2);
  });

  it("admits the third agent box through the actual scoped bearer access path", async () => {
    await system();
    await create("first");
    await create("second");
    const box = await create("third-agent", "agent");
    const key = await createMailboxAgentKey(db, actor(), {
      mailboxId: box.id,
      label: "Offline System agent",
      scopes: ["read", "draft"],
    });
    const raw = Buffer.from("Private scoped agent draft");
    const draft = await withMailboxAgentAccess(
      db,
      key.token,
      "draft",
      ({ db: tx, actor, mailboxId }) =>
        saveMailboxDraft(tx, keys, actor, { mailboxId, expectedRevision: 0, raw }),
    );
    const item = await withMailboxAgentAccess(
      db,
      key.token,
      "read",
      ({ db: tx, actor, mailboxId }) =>
        readMailboxItem(tx, keys, actor, { mailboxId, id: draft.id }),
    );
    expect(item.raw).toEqual(raw);
    await plan({ periodEnd: new Date(Date.now() - 1000) });
    let invoked = false;
    await withMailboxAgentAccess(db, key.token, "draft", async () => {
      invoked = true;
    });
    expect(invoked).toBe(true);
  });

  it("uses the internal storage capacity instead of the historical pilot allowance", async () => {
    await system();
    await create("first");
    await create("second");
    const third = await create("third");
    await plan({ storageBytesPerMailbox: 50 });
    await saveMailboxDraft(db, keys, actor(), {
      mailboxId: third.id,
      expectedRevision: 0,
      raw: Buffer.alloc(50, 65),
    });
    await saveMailboxDraft(db, keys, actor(), {
      mailboxId: third.id,
      expectedRevision: 0,
      raw: Buffer.from("x"),
    });
    expect(await mailboxServiceState(db, teamId)).toMatchObject({
      unlimitedOutbound: true,
      storageBytesPerMailbox: 50 * 1024 ** 3,
    });
    expect(await rawPlan()).toMatchObject({
      seats: 2,
      storageBytesPerMailbox: 50,
      includedOutboundPerMailbox: 100,
    });
  });

  it.each(["expired", "absent"] as const)(
    "keeps the internal license with an %s snapshot and admits writes when the snapshot exists",
    async (kind) => {
      await system();
      const box = await create("readable");
      const raw = Buffer.from("Recoverable private content");
      const item = await importMailboxMime(db, keys, actor(), {
        mailboxId: box.id,
        sourceId: "system:recovery",
        raw,
      });
      if (kind === "expired") await plan({ periodEnd: new Date(Date.now() - 1000) });
      else
        await db
          .delete(schema.mailboxSubscriptions)
          .where(eq(schema.mailboxSubscriptions.teamId, teamId));
      await create("person-extra");
      await create("agent-extra", "agent");
      expect(await mailboxServiceState(db, teamId)).toMatchObject({
        active: true,
        unlimitedSeats: true,
        licenseKind: "system",
        resourcePolicyActive: kind !== "absent",
        reservedSeats: 3,
      });
      const write = saveMailboxDraft(db, keys, actor(), {
        mailboxId: box.id,
        expectedRevision: 0,
        raw,
      });
      if (kind === "absent") await expect(write).rejects.toMatchObject({ code: "not_entitled" });
      else await write;
      expect(
        (await readMailboxItem(db, keys, actor(), { mailboxId: box.id, id: item.id })).raw,
      ).toEqual(raw);
      if (kind === "absent") expect(await rawPlan()).toBeUndefined();
    },
  );

  it("removes the System exemption on suspension while retaining private recovery reads", async () => {
    await system();
    const box = await create("person");
    const raw = Buffer.from("Suspended System recovery");
    const item = await importMailboxMime(db, keys, actor(), {
      mailboxId: box.id,
      sourceId: "system:suspended",
      raw,
    });
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.teams.id, teamId));
    expect(await mailboxServiceState(db, teamId)).toMatchObject({
      active: false,
      unlimitedSeats: false,
    });
    await expect(create("blocked")).rejects.toMatchObject({ code: "not_entitled" });
    await expect(
      saveMailboxDraft(db, keys, actor(), { mailboxId: box.id, expectedRevision: 0, raw }),
    ).rejects.toMatchObject({ code: "not_entitled" });
    expect(
      (await readMailboxItem(db, keys, actor(), { mailboxId: box.id, id: item.id })).raw,
    ).toEqual(raw);
  });

  it.each(["operator_admin", "other_operator", "ordinary_admin"] as const)(
    "does not derive unlimited access from %s",
    async (reason) => {
      await system();
      if (reason === "other_operator")
        await db.insert(schema.user).values({
          id: "first-operator",
          name: "First operator",
          email: "first@example.invalid",
          createdAt: new Date(0),
        });
      else {
        await db
          .update(schema.teamMembers)
          .set({ role: "admin" })
          .where(eq(schema.teamMembers.teamId, teamId));
        if (reason === "ordinary_admin")
          await db.update(schema.teams).set({ plan: "free" }).where(eq(schema.teams.id, teamId));
      }
      await create("first");
      await create("second");
      expect(await mailboxServiceState(db, teamId)).toMatchObject({ unlimitedSeats: false });
      await expect(create("third")).rejects.toMatchObject({ code: "quota" });
    },
  );

  it("rechecks owner membership and downgrade, restoring finite allocation without deleting boxes", async () => {
    await system();
    await create("first");
    await create("second");
    await create("third");
    await db
      .update(schema.teamMembers)
      .set({ role: "admin" })
      .where(eq(schema.teamMembers.teamId, teamId));
    await expect(create("owner-lost")).rejects.toMatchObject({ code: "quota" });
    await db
      .update(schema.teamMembers)
      .set({ role: "owner" })
      .where(eq(schema.teamMembers.teamId, teamId));
    await create("owner-restored");
    await db.update(schema.teams).set({ plan: "free" }).where(eq(schema.teams.id, teamId));
    const listed = await listMailboxRegistry(db, actor());
    expect(listed.mailboxes).toHaveLength(4);
    expect(listed.mailboxes.filter((box) => box.canDraft)).toHaveLength(2);
    const unlicensed = listed.mailboxes.find((box) => !box.canDraft);
    if (!unlicensed) throw new Error("Expected a finite-allocation box after System downgrade");
    await expect(
      saveMailboxDraft(db, keys, actor(), {
        mailboxId: unlicensed.id,
        expectedRevision: 0,
        raw: Buffer.from("Unlicensed draft"),
      }),
    ).rejects.toMatchObject({ code: "not_entitled" });
    await expect(create("downgraded")).rejects.toMatchObject({ code: "quota" });
    expect(await mailboxServiceState(db, teamId)).toMatchObject({
      unlimitedSeats: false,
      reservedSeats: 4,
    });
  });

  it("does not let an unlimited effective policy license a foreign team's box", async () => {
    await system();
    const [foreign] = await db
      .insert(schema.teams)
      .values({ name: "Foreign", slug: "foreign-system-test" })
      .returning();
    if (!foreign) throw new Error("Expected the offline foreign team fixture");
    const foreignTeamId = foreign.id;
    await seedMailboxTestService(db, [foreignTeamId]);
    await db
      .insert(schema.teamMembers)
      .values({ teamId: foreignTeamId, userId: "owner", role: "owner" });
    const [domain] = await db
      .insert(schema.domains)
      .values({
        teamId: foreignTeamId,
        name: "foreign.invalid",
        region: "us-east-1",
        status: "verified",
      })
      .returning();
    if (!domain) throw new Error("Expected the offline foreign domain fixture");
    const box = await createMailboxRegistry(
      db,
      { teamId: foreignTeamId, userId: "owner" },
      {
        domainId: domain.id,
        localPart: "foreign",
        kind: "person",
        label: "Foreign",
        ownerUserId: "owner",
      },
    );
    const effective = await db.transaction((tx) => lockMailboxService(tx as unknown as Db, teamId));
    await expect(requireMailboxSeat(db, teamId, box.id, effective)).rejects.toMatchObject({
      code: "not_entitled",
    });
    await expect(requireMailboxSeat(db, foreignTeamId, box.id, effective)).rejects.toMatchObject({
      code: "not_entitled",
    });
  });
});
