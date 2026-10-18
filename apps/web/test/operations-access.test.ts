import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consoleTeamInvitationsRouter } from "@/server/routers/console/team-invitations";
import { consoleUsersRouter } from "@/server/routers/console/users";
import { mailboxesRouter } from "@/server/routers/mailboxes";
import { type Context, createCallerFactory, operatorProcedure, router } from "@/server/trpc";
import { EnvKeyring } from "../../../packages/core/src/crypto/keyring.js";
import {
  importMailboxMime,
  readMailboxItem,
  withMailboxSendAccess,
} from "../../../packages/core/src/mailbox-private-store.js";
import {
  createMailboxRegistry,
  grantMailboxRegistry,
} from "../../../packages/core/src/mailbox-registry.js";
import {
  canReadUserDirectory,
  mailboxCreationAccess,
  type OperationsAccess,
  type OperationsInvitationAccess,
  operationsInvitationTargets,
  parseOperationsAccess,
  parseOperationsInvitationAccess,
} from "../../../packages/core/src/operations-access.js";
import { seedMailboxTestService } from "./mailbox-service-fixture";

const UUID = "00000000-0000-4000-8000-000000000001";
const policy = (domainIds: string[] = [UUID]): OperationsAccess => ({
  version: 1,
  userDirectoryRead: true,
  mailboxCreateDomainIds: domainIds,
});

describe("operations capability parsing", () => {
  it("rejects unknown formats, extra rights, wrong types, duplicate IDs and oversized scopes", () => {
    const invalid = [
      null,
      false,
      [],
      {},
      { ...policy(), version: 2 },
      { ...policy(), version: "1" },
      { ...policy(), userDirectoryRead: "true" },
      { ...policy(), mailboxCreateDomainIds: "*" },
      { ...policy(), mailboxCreateDomainIds: ["fullcommerce360.com"] },
      { ...policy(), mailboxCreateDomainIds: [UUID, UUID] },
      { ...policy(), mailboxCreateDomainIds: Array.from({ length: 21 }, () => randomUUID()) },
      { ...policy(), operator: true },
      { ...policy(), sendMailboxIds: [UUID] },
    ];
    for (const value of invalid) expect(parseOperationsAccess(value)).toBeNull();
    expect(parseOperationsAccess(policy())).toEqual(policy());
    expect(parseOperationsAccess({ ...policy([]), userDirectoryRead: false })).toEqual({
      ...policy([]),
      userDirectoryRead: false,
    });
  });

  it("accepts an explicit invitation scope and refuses malformed mailbox targets", () => {
    const invitation = { ...policy(), sendMailboxIds: [UUID] };
    expect(parseOperationsInvitationAccess(invitation)).toEqual(invitation);
    for (const value of [
      policy(),
      { ...invitation, sendMailboxIds: "*" },
      { ...invitation, sendMailboxIds: ["ops-only-personal@example.invalid"] },
      { ...invitation, sendMailboxIds: [UUID, UUID] },
      { ...invitation, sendMailboxIds: Array.from({ length: 21 }, () => randomUUID()) },
      { ...invitation, operator: true },
    ])
      expect(parseOperationsInvitationAccess(value)).toBeNull();
  });
});

const OPERATOR = "ops-only-operator";
const OWNER = "ops-only-owner";
const DELEGATE = "ops-only-delegate";
const ORDINARY = "ops-only-ordinary";
const FOREIGN = "ops-only-foreign";
const mainMigrations = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const mailboxMigrations = fileURLToPath(
  new URL("../../../packages/db/mailbox-drizzle/", import.meta.url),
);
const caller = createCallerFactory(
  router({
    mailboxes: mailboxesRouter,
    console: router({ users: consoleUsersRouter, invitations: consoleTeamInvitationsRouter }),
    operatorOnly: operatorProcedure.mutation(() => ({ allowed: true })),
  }),
);

describe("current operational capabilities with synthetic memberships", () => {
  let client: PGlite;
  let db: Db;
  let teamId: string;
  let foreignTeamId: string;
  let productDomainIds: string[];
  let thirdDomainId: string;
  let foreignDomainId: string;
  let supportMailboxId: string;
  let alertsMailboxId: string;
  let personalMailboxId: string;
  let thirdMailboxId: string;
  let foreignMailboxId: string;

  const owner = () => ({ teamId, userId: OWNER });
  const delegate = () => ({ teamId, userId: DELEGATE });
  const membership = () =>
    and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, DELEGATE));
  const access = (): OperationsAccess => policy(productDomainIds);
  const invitation = (
    sendMailboxIds = [supportMailboxId, alertsMailboxId],
  ): OperationsInvitationAccess => ({
    ...access(),
    sendMailboxIds,
  });
  const as = (userId: string | null = DELEGATE, role: Context["role"] = "member") =>
    caller({
      db,
      teamId,
      role,
      session: userId
        ? { user: { id: userId, name: userId, email: `${userId}@example.invalid` } }
        : null,
    });
  const createInput = (domainId = productDomainIds[0]!, ownerUserId = DELEGATE) => ({
    domainId,
    localPart: "ops-only-created",
    label: "ops-only-created",
    kind: "person" as const,
    ownerUserId,
  });

  beforeEach(async () => {
    vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
    vi.stubEnv("MAILBOX_PILOT_TEAM_IDS", undefined);
    vi.stubEnv("MAILBOX_PILOT_USER_IDS", undefined);
    vi.stubEnv("MAILBOX_EARLY_ACCESS_COHORT", undefined);
    client = new PGlite();
    for (const name of readdirSync(mainMigrations)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      await client.transaction(async (tx) => {
        for (const statement of readFileSync(mainMigrations + name, "utf8")
          .split("--> statement-breakpoint")
          .filter((statement) => statement.trim()))
          await tx.exec(statement);
      });
    }
    const database = drizzle(client, { schema });
    db = database as unknown as Db;
    await migrate(database, {
      migrationsFolder: mailboxMigrations,
      migrationsTable: "__mailbox_migrations",
    });
    const teams = await db
      .insert(schema.teams)
      .values([
        { name: "ops-only-products", slug: "ops-only-products" },
        { name: "ops-only-foreign", slug: "ops-only-foreign" },
      ])
      .returning();
    teamId = teams[0]!.id;
    foreignTeamId = teams[1]!.id;
    await seedMailboxTestService(db, [teamId, foreignTeamId]);
    await db.insert(schema.user).values(
      [OPERATOR, OWNER, DELEGATE, ORDINARY, FOREIGN].map((id, index) => ({
        id,
        name: id,
        email: `${id}@example.invalid`,
        emailVerified: true,
        createdAt: new Date(index),
      })),
    );
    const domains = await db
      .insert(schema.domains)
      .values([
        { teamId, name: "ops-only-fullcommerce.invalid", region: "us-east-1", status: "verified" },
        { teamId, name: "ops-only-mepmail.invalid", region: "us-east-1", status: "verified" },
        { teamId, name: "ops-only-personal.invalid", region: "us-east-1", status: "verified" },
        {
          teamId: foreignTeamId,
          name: "ops-only-foreign.invalid",
          region: "us-east-1",
          status: "verified",
        },
      ])
      .returning();
    productDomainIds = [domains[0]!.id, domains[1]!.id];
    thirdDomainId = domains[2]!.id;
    foreignDomainId = domains[3]!.id;
    await db.insert(schema.teamMembers).values([
      { teamId, userId: OWNER, role: "owner" },
      { teamId, userId: DELEGATE, role: "member", operationsAccess: access() },
      { teamId, userId: ORDINARY, role: "member" },
      { teamId: foreignTeamId, userId: FOREIGN, role: "owner" },
    ]);
    const create = (domainId: string, localPart: string) =>
      createMailboxRegistry(db, owner(), { ...createInput(domainId, OWNER), localPart });
    supportMailboxId = (await create(productDomainIds[0]!, "ops-only-support")).id;
    alertsMailboxId = (await create(productDomainIds[1]!, "ops-only-alerts")).id;
    personalMailboxId = (await create(productDomainIds[0]!, "ops-only-personal")).id;
    thirdMailboxId = (await create(thirdDomainId, "ops-only-private")).id;
    foreignMailboxId = (
      await createMailboxRegistry(
        db,
        { teamId: foreignTeamId, userId: FOREIGN },
        {
          ...createInput(foreignDomainId, FOREIGN),
          localPart: "ops-only-foreign",
        },
      )
    ).id;
  });

  afterEach(async () => {
    await client.close();
    vi.unstubAllEnvs();
  });

  it("requires a current verified member capability in a nonsuspended team for directory reads", async () => {
    expect(await canReadUserDirectory(db, DELEGATE)).toBe(true);
    expect(await canReadUserDirectory(db, ORDINARY)).toBe(false);
    expect(await canReadUserDirectory(db, OWNER)).toBe(false);
    await db.update(schema.user).set({ emailVerified: false }).where(eq(schema.user.id, DELEGATE));
    expect(await canReadUserDirectory(db, DELEGATE)).toBe(false);
    await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, DELEGATE));
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.teams.id, teamId));
    expect(await canReadUserDirectory(db, DELEGATE)).toBe(false);
    expect(await mailboxCreationAccess(db, delegate())).toMatchObject({ canCreate: false });
    await db.update(schema.teams).set({ suspendedAt: null }).where(eq(schema.teams.id, teamId));
    await db
      .update(schema.teamMembers)
      .set({
        operationsAccess: { ...access(), userDirectoryRead: false },
      })
      .where(membership());
    expect(await canReadUserDirectory(db, DELEGATE)).toBe(false);
    await db
      .update(schema.teamMembers)
      .set({
        operationsAccess: {
          ...access(),
          mailboxCreateDomainIds: [...productDomainIds, productDomainIds[0]!],
        },
      })
      .where(membership());
    expect(await canReadUserDirectory(db, DELEGATE)).toBe(false);
    expect(await mailboxCreationAccess(db, delegate())).toMatchObject({ canCreate: false });
    await db.update(schema.teamMembers).set({ operationsAccess: access() }).where(membership());
    expect(await canReadUserDirectory(db, DELEGATE)).toBe(true);
    await db.delete(schema.teamMembers).where(membership());
    expect(await canReadUserDirectory(db, DELEGATE)).toBe(false);
    await db.insert(schema.teamMembers).values({ teamId, userId: DELEGATE, role: "member" });
    expect(await canReadUserDirectory(db, DELEGATE)).toBe(false);
  });

  it("admits only the global user listing and keeps all operator mutations closed", async () => {
    const directory = await as().console.users.list({});
    expect(directory.items.map((user) => user.id)).toContain(FOREIGN);
    expect(directory.items.find((user) => user.id === DELEGATE)).toMatchObject({
      isOperator: false,
    });
    await expect(as().operatorOnly()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      as().console.invitations.create({
        teamId: foreignTeamId,
        email: "ops-only-unauthorized@example.invalid",
        role: "admin",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.select().from(schema.teamInvitations)).toEqual([]);
    await expect(as(ORDINARY, "owner").console.users.list({})).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(as(null).console.users.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await db.update(schema.user).set({ emailVerified: false }).where(eq(schema.user.id, DELEGATE));
    await expect(as().console.users.list({})).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await as(OPERATOR, null).operatorOnly()).toEqual({ allowed: true });
  });

  it("shows only creation domains and self while preserving an empty private mailbox list", async () => {
    expect(await mailboxCreationAccess(db, delegate())).toEqual({
      canManage: false,
      canCreate: true,
      domainIds: productDomainIds,
    });
    const options = await as().mailboxes.options();
    expect(options.domains.map((domain) => domain.id).sort()).toEqual([...productDomainIds].sort());
    expect(options.members.map((member) => member.id)).toEqual([DELEGATE]);
    expect(options.canManage).toBe(false);
    expect(await as().mailboxes.list()).toMatchObject({
      canManage: false,
      canCreate: true,
      mailboxes: [],
    });
    await expect(as(ORDINARY, "owner").mailboxes.options()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("creates only self-owned boxes on the allowlist and refuses other owners, domains or teams", async () => {
    for (const domainId of productDomainIds) {
      const created = await as().mailboxes.create(createInput(domainId));
      const [box] = await db
        .select()
        .from(schema.mailboxes)
        .where(eq(schema.mailboxes.id, created.id));
      expect(box).toMatchObject({ teamId, domainId, ownerUserId: DELEGATE });
      const [member] = await db.select().from(schema.teamMembers).where(membership());
      expect(box!.ownerMembershipId).toBe(member!.id);
    }
    await expect(
      as(DELEGATE, "owner").mailboxes.create(createInput(productDomainIds[0]!, OWNER)),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    for (const domainId of [thirdDomainId, foreignDomainId])
      await expect(as().mailboxes.create(createInput(domainId))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    await db
      .update(schema.teamMembers)
      .set({
        operationsAccess: { ...access(), mailboxCreateDomainIds: [foreignDomainId] },
      })
      .where(membership());
    await expect(
      createMailboxRegistry(db, delegate(), createInput(foreignDomainId)),
    ).rejects.toMatchObject({ code: "forbidden" });
    await db.update(schema.teamMembers).set({ operationsAccess: access() }).where(membership());
    await db.update(schema.user).set({ emailVerified: false }).where(eq(schema.user.id, DELEGATE));
    await expect(
      as().mailboxes.create({ ...createInput(), localPart: "ops-only-unverified" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("does not turn creation or directory capability into personal content or self-grant rights", async () => {
    const keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
    const raw = Buffer.from(
      "From: ops-only-sender@example.invalid\r\nTo: ops-only-personal@example.invalid\r\nSubject: ops-only-private\r\n\r\nops-only-private-body",
    );
    const item = await importMailboxMime(db, keys, owner(), {
      mailboxId: personalMailboxId,
      sourceId: "ops-only-private-content",
      raw,
    });
    await expect(
      readMailboxItem(db, keys, delegate(), { mailboxId: personalMailboxId, id: item.id }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      withMailboxSendAccess(db, delegate(), personalMailboxId, async () => true),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      as(DELEGATE, "owner").mailboxes.grant({
        mailboxId: personalMailboxId,
        userId: DELEGATE,
        permission: "send",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      as(DELEGATE, "owner").mailboxes.update({
        id: personalMailboxId,
        label: "ops-only-forged-owner",
        ownerUserId: DELEGATE,
        status: "planned",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await grantMailboxRegistry(db, owner(), {
      mailboxId: supportMailboxId,
      userId: DELEGATE,
      permission: "draft",
    });
    await expect(
      withMailboxSendAccess(db, delegate(), supportMailboxId, async () => true),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect((await as().mailboxes.list()).mailboxes.map((box) => box.id)).toEqual([
      supportMailboxId,
    ]);
  });

  it("resolves reviewed invitation targets and rejects third-domain, cross-team and external boxes", async () => {
    const targets = await operationsInvitationTargets(db, teamId, invitation());
    expect(targets.domains.map((domain) => domain.id).sort()).toEqual([...productDomainIds].sort());
    expect(targets.mailboxes.map((box) => box.id).sort()).toEqual(
      [supportMailboxId, alertsMailboxId].sort(),
    );
    for (const boxId of [thirdMailboxId, foreignMailboxId, randomUUID()])
      await expect(operationsInvitationTargets(db, teamId, invitation([boxId]))).rejects.toThrow(
        "invalid_operations_mailbox_scope",
      );
    await expect(
      operationsInvitationTargets(db, teamId, {
        ...invitation([]),
        mailboxCreateDomainIds: [foreignDomainId],
      }),
    ).rejects.toThrow("invalid_operations_domain_scope");
    await expect(
      operationsInvitationTargets(db, teamId, {
        ...invitation([]),
        mailboxCreateDomainIds: [],
      }),
    ).rejects.toThrow("invalid_operations_access");
    const [ownerMembership] = await db
      .select()
      .from(schema.teamMembers)
      .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, OWNER)));
    const [external] = await db
      .insert(schema.mailboxes)
      .values({
        teamId,
        domainId: null,
        origin: "external",
        address: "ops-only-external@example.invalid",
        label: "ops-only-external",
        kind: "person",
        ownerUserId: OWNER,
        ownerMembershipId: ownerMembership!.id,
      })
      .returning();
    await expect(
      operationsInvitationTargets(db, teamId, invitation([external!.id])),
    ).rejects.toThrow("invalid_operations_mailbox_scope");
    await db
      .update(schema.mailboxes)
      .set({ status: "suspended" })
      .where(eq(schema.mailboxes.id, supportMailboxId));
    await expect(
      operationsInvitationTargets(db, teamId, invitation([supportMailboxId])),
    ).rejects.toThrow("invalid_operations_mailbox_scope");
  });
});
