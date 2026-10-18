import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { canReadUserDirectory, type SystemMailMessage } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";
import { setConsoleInvitationMailDeps } from "@/server/routers/console/team-invitations";

let client: PGlite;
let db: Db;
let teamId: string;
let domainIds: string[];
let selectedId: string;
let privateId: string;
let thirdId: string;
let sent: SystemMailMessage[];
const mainFolder = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const mailboxFolder = fileURLToPath(
  new URL("../../../packages/db/mailbox-drizzle/", import.meta.url),
);

beforeEach(async () => {
  vi.stubEnv("IS_CLOUD", "false");
  vi.stubEnv("ALLOW_SIGNUP", "false");
  vi.stubEnv("BETTER_AUTH_SECRET", "ops-fixture-invite-secret");
  vi.stubEnv("AUTH_EMAIL_FROM", "MepMail <no-reply@ops.example.test>");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "ops-fixture-key");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ops-fixture-secret");
  client = new PGlite();
  for (const filename of readdirSync(mainFolder)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await client.transaction(async (tx) => {
      for (const statement of readFileSync(mainFolder + filename, "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => s.trim()))
        await tx.exec(statement);
    });
  }
  const database = drizzle(client, { schema });
  db = database as unknown as Db;
  await migrate(database, {
    migrationsFolder: mailboxFolder,
    migrationsTable: "__mailbox_migrations",
  });
  await db.insert(schema.user).values([
    {
      id: "ops-issuer",
      email: "issuer@ops.example.test",
      name: "Issuer",
      emailVerified: true,
      createdAt: new Date(0),
    },
    {
      id: "ops-partner",
      email: "partner@ops.example.test",
      name: "Partner",
      emailVerified: true,
      createdAt: new Date(1),
    },
    {
      id: "ops-other",
      email: "other@ops.example.test",
      name: "Other",
      emailVerified: true,
      createdAt: new Date(2),
    },
  ]);
  const [team] = await db
    .insert(schema.teams)
    .values({ name: "Ops synthetic", slug: "ops-invitation-fixture" })
    .returning();
  teamId = team!.id;
  await db.insert(schema.teamMembers).values({ teamId, userId: "ops-issuer", role: "owner" });
  const [owner] = await db.select().from(schema.teamMembers);
  const domains = await db
    .insert(schema.domains)
    .values([
      { teamId, name: "product-a.example.test", region: "us-east-1", status: "verified" },
      { teamId, name: "product-b.example.test", region: "us-east-1", status: "verified" },
      { teamId, name: "other-product.example.test", region: "us-east-1", status: "verified" },
    ])
    .returning();
  domainIds = domains.slice(0, 2).map((d) => d.id);
  const boxes = await db
    .insert(schema.mailboxes)
    .values([
      {
        teamId,
        domainId: domainIds[0]!,
        address: "support@product-a.example.test",
        label: "Support",
        kind: "person" as const,
        ownerUserId: "ops-issuer",
        ownerMembershipId: owner!.id,
      },
      {
        teamId,
        domainId: domainIds[0]!,
        address: "private@product-a.example.test",
        label: "Private",
        kind: "person" as const,
        ownerUserId: "ops-issuer",
        ownerMembershipId: owner!.id,
      },
      {
        teamId,
        domainId: domains[2]!.id,
        address: "support@other-product.example.test",
        label: "Other",
        kind: "person" as const,
        ownerUserId: "ops-issuer",
        ownerMembershipId: owner!.id,
      },
    ])
    .returning();
  [selectedId, privateId, thirdId] = boxes.map((b) => b.id) as [string, string, string];
  sent = [];
  setConsoleInvitationMailDeps({
    send: async (mail) => {
      sent.push(mail);
    },
  });
});

afterEach(async () => {
  setConsoleInvitationMailDeps(null);
  vi.unstubAllEnvs();
  await client.close();
});

function caller(id: string) {
  return createCaller({
    db,
    session: {
      user: {
        id,
        email: `${id === "ops-partner" ? "partner" : id === "ops-issuer" ? "issuer" : "other"}@ops.example.test`,
        name: id,
      },
    },
    teamId: null,
    role: null,
  });
}

async function invite() {
  return caller("ops-issuer").console.teams.invitations.createOperations({
    teamId,
    email: "partner@ops.example.test",
    domainIds,
    mailboxIds: [selectedId],
  });
}
const token = (url: string) => url.split("/invite/")[1]!;
async function partnerMember() {
  const [m] = await db
    .select()
    .from(schema.teamMembers)
    .where(
      and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, "ops-partner")),
    );
  return m;
}

describe("operational invitation activation", () => {
  it("sends the bounded welcome once and grants nothing at issuance; signup remains closed", async () => {
    const created = await invite();
    expect(created).toMatchObject({ role: "member", emailed: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("product-a.example.test");
    expect(sent[0]?.text).toContain("support@product-a.example.test");
    expect(sent[0]?.text).not.toContain("private@product-a.example.test");
    expect(sent[0]?.text).not.toContain("other-product.example.test");
    expect(await partnerMember()).toBeUndefined();
    expect(await canReadUserDirectory(db, "ops-partner")).toBe(false);
    expect(await db.select().from(schema.account)).toEqual([]);
    expect(process.env.ALLOW_SIGNUP).toBe("false");
  });

  it("verified invitee accepts once; only reviewed domains and selected send grant activate", async () => {
    const created = await invite();
    await caller("ops-partner").settings.invitations.accept({ token: token(created.acceptUrl) });
    const membership = await partnerMember();
    expect(membership).toMatchObject({
      role: "member",
      operationsAccess: { version: 1, userDirectoryRead: true, mailboxCreateDomainIds: domainIds },
    });
    const grants = await db
      .select()
      .from(schema.mailboxGrants)
      .where(eq(schema.mailboxGrants.userId, "ops-partner"));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      mailboxId: selectedId,
      membershipId: membership!.id,
      permission: "send",
      grantedBy: "ops-issuer",
    });
    expect(grants.some((g) => g.mailboxId === privateId || g.mailboxId === thirdId)).toBe(false);
    expect(await canReadUserDirectory(db, "ops-partner")).toBe(true);
    await expect(caller("ops-partner").console.overview.summary()).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      caller("ops-partner").settings.invitations.accept({ token: token(created.acceptUrl) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(sent).toHaveLength(1);
    const [audit] = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "member.joined"));
    expect(audit?.data).toMatchObject({
      operationalProfile: true,
      sendMailboxIds: [selectedId],
      approvedBy: "ops-issuer",
    });
    expect(JSON.stringify(audit)).not.toContain(token(created.acceptUrl));
  });

  it("rejects a different verified identity even on self-host and rolls back the claim/membership", async () => {
    vi.stubEnv("IS_CLOUD", "");
    const created = await invite();
    await expect(
      caller("ops-other").settings.invitations.accept({ token: token(created.acceptUrl) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [pending] = await db
      .select()
      .from(schema.teamInvitations)
      .where(eq(schema.teamInvitations.id, created.id));
    expect(pending?.acceptedAt).toBeNull();
    expect(await db.select().from(schema.mailboxGrants)).toEqual([]);
  });

  it("requires real verification, never changes the invitee password or verifies administratively", async () => {
    const created = await invite();
    await db
      .update(schema.user)
      .set({ emailVerified: false })
      .where(eq(schema.user.id, "ops-partner"));
    await expect(
      caller("ops-partner").settings.invitations.accept({ token: token(created.acceptUrl) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await partnerMember()).toBeUndefined();
    const [person] = await db.select().from(schema.user).where(eq(schema.user.id, "ops-partner"));
    expect(person?.emailVerified).toBe(false);
    expect(await db.select().from(schema.account)).toEqual([]);
  });

  it("rejects a box outside the selected domains before sending or creating an invitation", async () => {
    await expect(
      caller("ops-issuer").console.teams.invitations.createOperations({
        teamId,
        email: "partner@ops.example.test",
        domainIds,
        mailboxIds: [thirdId],
      }),
    ).rejects.toThrow();
    expect(sent).toHaveLength(0);
    expect(await db.select().from(schema.teamInvitations)).toEqual([]);
  });

  it("refuses activation when the issuer has lost team administration", async () => {
    const created = await invite();
    await db
      .update(schema.teamMembers)
      .set({ role: "member" })
      .where(eq(schema.teamMembers.userId, "ops-issuer"));
    await expect(
      caller("ops-partner").settings.invitations.accept({ token: token(created.acceptUrl) }),
    ).rejects.toThrow();
    expect(await partnerMember()).toBeUndefined();
    const [pending] = await db
      .select()
      .from(schema.teamInvitations)
      .where(eq(schema.teamInvitations.id, created.id));
    expect(pending?.acceptedAt).toBeNull();
  });

  it("does not let an operational reader issue an operational invitation", async () => {
    await db.insert(schema.teamMembers).values({
      teamId,
      userId: "ops-partner",
      role: "member",
      operationsAccess: {
        version: 1,
        userDirectoryRead: true,
        mailboxCreateDomainIds: domainIds,
      },
    });
    await expect(
      caller("ops-partner").console.teams.invitations.createOperations({
        teamId,
        email: "other@ops.example.test",
        domainIds,
        mailboxIds: [selectedId],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(sent).toHaveLength(0);
  });

  it("refuses to describe a narrower scope over incompatible existing access", async () => {
    const [member] = await db
      .insert(schema.teamMembers)
      .values({ teamId, userId: "ops-partner", role: "member" })
      .returning();
    await db.insert(schema.mailboxGrants).values({
      teamId,
      userId: "ops-partner",
      membershipId: member!.id,
      mailboxId: privateId,
      permission: "read",
      grantedBy: "ops-issuer",
    });
    const created = await invite();
    await expect(
      caller("ops-partner").settings.invitations.accept({ token: token(created.acceptUrl) }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await partnerMember())?.operationsAccess).toBeNull();
    const [pending] = await db
      .select()
      .from(schema.teamInvitations)
      .where(eq(schema.teamInvitations.id, created.id));
    expect(pending?.acceptedAt).toBeNull();
    expect(await canReadUserDirectory(db, "ops-partner")).toBe(false);
  });
});
