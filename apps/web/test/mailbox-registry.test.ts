import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withMailboxDomainDeletion } from "@/server/mailboxes";
import { mailboxesRouter } from "@/server/routers/mailboxes";
import { type Context, createCallerFactory, router } from "@/server/trpc";
import { seedMailboxTestService } from "./mailbox-service-fixture";

let client: PGlite, db: Db;
let team: string, otherTeam: string, domain: string, otherDomain: string;
const folder = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const caller = createCallerFactory(router({ mailboxes: mailboxesRouter }));
function as(
  userId = "owner",
  teamId = team,
  role: Context["role"] = "owner",
  extra: Partial<Context> = {},
) {
  return caller({
    db,
    teamId,
    role,
    session: { user: { id: userId, name: userId, email: userId + "@example.test" } },
    ...extra,
  });
}
function input(overrides = {}) {
  return {
    domainId: domain,
    localPart: "Jean",
    label: "Pessoal",
    kind: "person" as const,
    ownerUserId: "owner",
    ...overrides,
  };
}
async function box(overrides = {}) {
  return (await as().mailboxes.create(input(overrides))).id;
}

beforeEach(async () => {
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  client = new PGlite();
  // Exercise the current Main schema with an independent optional mailbox ledger.
  await client.transaction(async (tx) => {
    for (const name of readdirSync(folder)
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      for (const statement of readFileSync(folder + name, "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => s.trim()))
        await tx.exec(statement);
    }
  });
  const database = drizzle(client, { schema });
  db = database as unknown as Db;
  await migrate(database, { migrationsFolder: extension, migrationsTable: "__mailbox_migrations" });
  const teams = await db
    .insert(schema.teams)
    .values([
      { name: "Local", slug: "mailbox-local" },
      { name: "Other", slug: "mailbox-other" },
    ])
    .returning({ id: schema.teams.id });
  team = teams[0]!.id;
  otherTeam = teams[1]!.id;
  await seedMailboxTestService(db, [team, otherTeam]);
  for (const id of ["owner", "member", "reader", "outsider"])
    await db
      .insert(schema.user)
      .values({ id, name: id, email: id + "@example.test", emailVerified: true });
  await db.insert(schema.teamMembers).values([
    { teamId: team, userId: "owner", role: "owner" },
    { teamId: team, userId: "member", role: "member" },
    { teamId: team, userId: "reader", role: "member" },
    { teamId: otherTeam, userId: "outsider", role: "owner" },
  ]);
  const domains = await db
    .insert(schema.domains)
    .values([
      { teamId: team, name: "piloto.test", region: "us-east-1", status: "verified" },
      { teamId: otherTeam, name: "piloto.test", region: "us-east-1" },
    ])
    .returning({ id: schema.domains.id });
  domain = domains[0]!.id;
  otherDomain = domains[1]!.id;
});
afterEach(async () => {
  await client.close();
  vi.unstubAllEnvs();
});

describe("authenticated persistent mailbox registry", () => {
  it("reserves normalized addresses without claiming active delivery", async () => {
    const id = await box();
    const result = await as().mailboxes.list();
    expect(result.mailboxes[0]).toMatchObject({
      id,
      address: "jean@piloto.test",
      kind: "person",
      status: "planned",
      deliveryReady: false,
      canRead: true,
    });
    expect(await as().mailboxes.capabilities()).toEqual({
      enabled: true,
      deliveryReady: false,
      offered: false,
    });
    expect((await as().mailboxes.options()).domains[0]?.status).toBe("verified");
  });
  it("rejects duplicate addresses across domain rows/teams without revealing ownership", async () => {
    await box();
    await expect(as().mailboxes.create(input())).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      as("outsider", otherTeam).mailboxes.create(
        input({ domainId: otherDomain, ownerUserId: "outsider" }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("rejects a foreign domain and owner, plus malformed address and control text", async () => {
    await expect(as().mailboxes.create(input({ domainId: otherDomain }))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(as().mailboxes.create(input({ ownerUserId: "outsider" }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    for (const localPart of ["a..b", "a@b", "*", "a.", "a\nb"])
      await expect(as().mailboxes.create(input({ localPart }))).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    await expect(as().mailboxes.create(input({ label: "a\nb" }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      db.insert(schema.mailboxes).values({
        teamId: team,
        domainId: otherDomain,
        address: "db@piloto.test",
        label: "DB",
        kind: "agent",
        ownerUserId: "owner",
      }),
    ).rejects.toThrow();
  });
  it("revalidates live membership/role instead of trusting caller context", async () => {
    const id = await box();
    await expect(as("member", team, "owner").mailboxes.create(input())).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await db
      .update(schema.teamMembers)
      .set({ role: "member" })
      .where(and(eq(schema.teamMembers.teamId, team), eq(schema.teamMembers.userId, "owner")));
    await expect(as().mailboxes.create(input())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as().mailboxes.options()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as().mailboxes.grants({ mailboxId: id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
  it("isolates private boxes and rechecks changed or revoked grants", async () => {
    const id = await box();
    expect((await as("reader", team, "member").mailboxes.list()).mailboxes).toEqual([]);
    const grant = await as().mailboxes.grant({
      mailboxId: id,
      userId: "reader",
      permission: "read",
    });
    expect((await as("reader", team, "member").mailboxes.list()).mailboxes[0]).toMatchObject({
      canRead: true,
      canDraft: false,
    });
    const replacement = await as().mailboxes.grant({
      mailboxId: id,
      userId: "reader",
      permission: "draft",
    });
    expect((await as().mailboxes.grants({ mailboxId: id })).map((g) => g.id)).toEqual([
      replacement.id,
    ]);
    await expect(as().mailboxes.revoke({ id: grant.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await as().mailboxes.revoke({ id: replacement.id });
    expect((await as("reader", team, "member").mailboxes.list()).mailboxes).toEqual([]);
  });
  it("does not give admins automatic private reading and preserves departed owners", async () => {
    const id = await box({ ownerUserId: "member" });
    expect((await as().mailboxes.list()).mailboxes[0]).toMatchObject({
      canRead: false,
      canDraft: false,
    });
    await db
      .delete(schema.teamMembers)
      .where(and(eq(schema.teamMembers.teamId, team), eq(schema.teamMembers.userId, "member")));
    await expect(as("member", team, "member").mailboxes.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await as().mailboxes.list()).mailboxes[0]?.id).toBe(id);
    await db.insert(schema.teamMembers).values({ teamId: team, userId: "member", role: "member" });
    expect((await as("member", team, "member").mailboxes.list()).mailboxes).toEqual([]);
    await as().mailboxes.update({
      id,
      label: "Reassigned",
      ownerUserId: "owner",
      status: "planned",
    });
    expect((await as().mailboxes.list()).mailboxes[0]).toMatchObject({
      canRead: true,
      label: "Reassigned",
    });
  });
  it("grants cease to work on membership removal and cross-team grants cannot be forged", async () => {
    const id = await box();
    await as().mailboxes.grant({ mailboxId: id, userId: "reader", permission: "read" });
    await db
      .delete(schema.teamMembers)
      .where(and(eq(schema.teamMembers.teamId, team), eq(schema.teamMembers.userId, "reader")));
    await expect(as("reader", team, "member").mailboxes.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await as().mailboxes.grants({ mailboxId: id })).toEqual([]);
    await db.insert(schema.teamMembers).values({ teamId: team, userId: "reader", role: "member" });
    expect((await as("reader", team, "member").mailboxes.list()).mailboxes).toEqual([]);
    await expect(
      as().mailboxes.grant({ mailboxId: id, userId: "outsider", permission: "read" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      as("outsider", otherTeam).mailboxes.grants({ mailboxId: id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      db
        .insert(schema.mailboxGrants)
        .values({ teamId: otherTeam, mailboxId: id, userId: "outsider", permission: "read" }),
    ).rejects.toThrow();
  });
  it("suspends permission without erasing the box and never accepts an active status", async () => {
    const id = await box();
    await as().mailboxes.update({ id, label: "Paused", ownerUserId: "owner", status: "suspended" });
    expect((await as().mailboxes.list()).mailboxes[0]).toMatchObject({
      status: "suspended",
      canRead: false,
      canDraft: false,
      deliveryReady: false,
    });
    await expect(
      as().mailboxes.update({
        id,
        label: "x",
        ownerUserId: "owner",
        status: "active" as "planned",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("denies unauthenticated and operator-support requests; off mode touches no registry tables", async () => {
    await box();
    await expect(
      as("owner", team, "viewer", {
        supportView: { grantId: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60000) },
      }).mailboxes.list(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      as("owner", team, "owner", { session: null }).mailboxes.list(),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "false");
    expect(await as().mailboxes.capabilities()).toEqual({
      enabled: false,
      deliveryReady: false,
      offered: false,
    });
    await expect(as().mailboxes.create(input())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("blocks domain deletion before external side effects, including with feature switched off", async () => {
    await box();
    const external = vi.fn(async () => "deleted");
    vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "false");
    await expect(withMailboxDomainDeletion(db, team, domain, external)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(external).not.toHaveBeenCalled();
    await expect(withMailboxDomainDeletion(db, otherTeam, domain, external)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(db.delete(schema.domains).where(eq(schema.domains.id, domain))).rejects.toThrow();
    expect(await withMailboxDomainDeletion(db, otherTeam, otherDomain, external)).toBe("deleted");
  });
  it("stores a bounded per-box plaintext signature and preserves it when old clients omit the field", async () => {
    const id = await box({ signatureText: "Jean\r\nSuporte\rMepMail" });
    const entry = (await as().mailboxes.list()).mailboxes.find((row) => row.id === id)!;
    expect(entry.signatureText).toBe("Jean\nSuporte\nMepMail");
    const update = { id, label: "Updated", ownerUserId: "owner", status: "planned" as const };
    await as().mailboxes.update(update);
    expect((await as().mailboxes.list()).mailboxes[0]!.signatureText).toBe(entry.signatureText);
    await as().mailboxes.update({ ...update, signatureText: "" });
    expect((await as().mailboxes.list()).mailboxes[0]!.signatureText).toBe("");
    await expect(
      as("member", team, "member").mailboxes.update({ ...update, signatureText: "forged" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const audit = await db.select().from(schema.auditLog);
    expect(JSON.stringify(audit.map((row) => row.data))).not.toContain("Jean\\nSuporte");
    await expect(
      box({ localPart: "large", signatureText: "x".repeat(4001) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      box({ localPart: "control", signatureText: "bad\u0000text" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("uses an idempotent independent mailbox migration ledger alongside the current Main schema", async () => {
    await box();
    await migrate(drizzle(client), {
      migrationsFolder: extension,
      migrationsTable: "__mailbox_migrations",
    });
    const columns = await client.query(
      "select column_name,is_nullable from information_schema.columns where table_schema='public' and table_name='account' and column_name='issuer'",
    );
    expect(columns.rows).toEqual([{ column_name: "issuer", is_nullable: "YES" }]);
    const identityIndex = await client.query(
      "select i.indisunique,i.indisvalid,i.indisready from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace join pg_class ix on ix.oid=i.indexrelid where n.nspname='public' and c.relname='account' and ix.relname='account_provider_account_id_idx'",
    );
    expect(identityIndex.rows).toEqual([{ indisunique: true, indisvalid: true, indisready: true }]);
    expect((await db.select().from(schema.mailboxes)).length).toBe(1);
    expect(
      (await client.query("select count(*) as count from drizzle.__mailbox_migrations")).rows[0],
    ).toMatchObject({ count: 14 });
    expect(
      (await client.query("select to_regclass('drizzle.__drizzle_migrations') as ledger")).rows[0],
    ).toMatchObject({ ledger: null });
  });
});
