import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  createMailboxRegistry,
  grantMailboxRegistry,
  revokeMailboxRegistry,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getMailboxUsage } from "@/server/mailbox-usage";
import { seedMailboxTestService } from "./mailbox-service-fixture";

const mainMigrations = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const mailMigrations = fileURLToPath(
  new URL("../../../packages/db/mailbox-drizzle/", import.meta.url),
);
let client: PGlite;
let db: Db;
let teamId: string;
let otherTeamId: string;
let personId: string;
let agentId: string;
let otherBoxId: string;
let ownerMembershipId: string;
let periodStart: Date;
let periodEnd: Date;
const actor = (userId = "owner", activeTeamId = teamId) => ({ teamId: activeTeamId, userId });
const usage = (mailboxId: string | null = null, userId = "owner") =>
  getMailboxUsage(db, actor(userId), { mailboxId });
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing usage fixture row");
  return value;
}

beforeAll(async () => {
  client = new PGlite();
  await client.transaction(async (tx) => {
    for (const file of readdirSync(mainMigrations)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      for (const statement of readFileSync(mainMigrations + file, "utf8")
        .split("--> statement-breakpoint")
        .filter((value) => value.trim())) {
        await tx.exec(statement);
      }
    }
  });
  const database = drizzle(client, { schema });
  db = database as unknown as Db;
  await migrate(database, {
    migrationsFolder: mailMigrations,
    migrationsTable: "__mailbox_migrations",
  });
  await db.insert(schema.user).values(
    ["owner", "admin", "member", "outsider"].map((id, index) => ({
      id,
      name: id,
      email: `${id}@usage.example.invalid`,
      emailVerified: true,
      createdAt: new Date(Date.UTC(2020 + index, 0, 1)),
    })),
  );
});

beforeEach(async () => {
  const unique = randomUUID();
  const teams = await db
    .insert(schema.teams)
    .values([
      { name: "Usage", slug: `usage-${unique}` },
      { name: "Other usage", slug: `usage-other-${unique}` },
    ])
    .returning();
  teamId = required(teams[0]).id;
  otherTeamId = required(teams[1]).id;
  await seedMailboxTestService(db, [teamId, otherTeamId]);
  const memberships = await db
    .insert(schema.teamMembers)
    .values([
      { teamId, userId: "owner", role: "owner" },
      { teamId, userId: "admin", role: "admin" },
      { teamId, userId: "member", role: "member" },
      { teamId: otherTeamId, userId: "outsider", role: "owner" },
    ])
    .returning();
  ownerMembershipId = required(memberships[0]).id;
  const domains = await db
    .insert(schema.domains)
    .values([
      { teamId, name: `usage-${unique}.invalid`, region: "us-east-1" },
      { teamId: otherTeamId, name: `other-${unique}.invalid`, region: "us-east-1" },
    ])
    .returning();
  personId = (
    await createMailboxRegistry(db, actor(), {
      domainId: required(domains[0]).id,
      localPart: "person",
      label: "Person",
      kind: "person",
      ownerUserId: "owner",
    })
  ).id;
  agentId = (
    await createMailboxRegistry(db, actor(), {
      domainId: required(domains[0]).id,
      localPart: "agent",
      label: "Agent",
      kind: "agent",
      ownerUserId: "owner",
    })
  ).id;
  otherBoxId = (
    await createMailboxRegistry(db, actor("outsider", otherTeamId), {
      domainId: required(domains[1]).id,
      localPart: "private",
      label: "Other tenant",
      kind: "person",
      ownerUserId: "outsider",
    })
  ).id;
  const [plan] = await db
    .select()
    .from(schema.mailboxSubscriptions)
    .where(eq(schema.mailboxSubscriptions.teamId, teamId));
  periodStart = required(plan).periodStart;
  periodEnd = required(plan).periodEnd;
});

afterAll(async () => {
  await client?.close();
});

/** Deliberately opaque, syntactically valid envelopes: usage must never decrypt message content. */
async function storedItem(
  mailboxId: string,
  rawBytes: number,
  extra: Partial<typeof schema.mailboxItems.$inferInsert> = {},
) {
  const [row] = await db
    .insert(schema.mailboxItems)
    .values({
      teamId: mailboxId === otherBoxId ? otherTeamId : teamId,
      mailboxId,
      kind: "inbox",
      sourceId: `usage:${randomUUID()}`,
      rawBytes,
      ciphertext: Buffer.alloc(17),
      iv: Buffer.alloc(12),
      wrappedDek: Buffer.alloc(32),
      keyVersion: 2_000_001,
      ...extra,
    })
    .returning();
  return required(row);
}

async function outbox(
  mailboxId: string,
  status: typeof schema.mailboxOutbox.$inferSelect.status,
  recipientCount: number,
  options: { rawBytes?: number; draftBytes?: number; periodStart?: Date; periodEnd?: Date } = {},
) {
  const draft = await storedItem(mailboxId, options.draftBytes ?? 50, {
    kind: "draft",
    sourceId: null,
  });
  const id = randomUUID();
  const accepted = status === "accepted";
  const attempted = status !== "queued" && status !== "failed";
  const rawBytes = options.rawBytes ?? 300;
  await db.insert(schema.mailboxOutbox).values({
    id,
    teamId,
    mailboxId,
    draftId: draft.id,
    draftRevision: draft.revision,
    approvedBy: "owner",
    approvedMembershipId: ownerMembershipId,
    recipientCount,
    periodStart: options.periodStart ?? periodStart,
    periodEnd: options.periodEnd ?? periodEnd,
    rawBytes,
    rawSha256: "a".repeat(64),
    ciphertext: accepted ? null : Buffer.alloc(17),
    iv: accepted ? null : Buffer.alloc(12),
    wrappedDek: accepted ? null : Buffer.alloc(32),
    keyVersion: accepted ? null : 2_000_001,
    status,
    attemptId: attempted ? randomUUID() : null,
    attemptedAt: attempted ? new Date() : null,
    acceptedAt: accepted ? new Date() : null,
    providerMessageId: accepted ? `synthetic-${id}` : null,
  });
  // Acceptance materializes the encrypted sent item and clears the outbox's duplicate payload.
  if (accepted) {
    await storedItem(mailboxId, rawBytes, { id, kind: "sent", sourceId: `outbox:${id}` });
  }
  return id;
}

describe("private mailbox usage", () => {
  it("reports empty per-box usage with its actual subscription limits and period", async () => {
    const result = await usage();
    expect(result.mailboxes).toHaveLength(2);
    expect(result.mailboxes.map((box) => box.mailboxId).sort()).toEqual([personId, agentId].sort());
    for (const box of result.mailboxes) {
      expect(box).toMatchObject({
        storageUsedBytes: 0,
        storageLimitBytes: 5 * 1024 * 1024,
        outboundUsedRecipients: 0,
        outboundLimitRecipients: 100,
        periodStart,
        periodEnd,
      });
      expect(box).not.toHaveProperty("ciphertext");
      expect(box).not.toHaveProperty("stripeCustomerId");
    }
  });

  it("charges all physically stored bytes including Trash and retained outbox payloads, without double-counting acceptance", async () => {
    await storedItem(personId, 100);
    await storedItem(personId, 200, { trashedAt: new Date() });
    await outbox(personId, "queued", 1, { rawBytes: 300, draftBytes: 50 });
    await outbox(personId, "failed", 1, { rawBytes: 400, draftBytes: 60 });
    await outbox(personId, "accepted", 1, { rawBytes: 500, draftBytes: 70 });
    const { mailboxes } = await usage(personId);
    expect(mailboxes).toHaveLength(1);
    // MIME items: 100+200+50+60+70+500; retained outbox: 300+400; accepted payload is null.
    expect(mailboxes[0]?.storageUsedBytes).toBe(1_680);
  });

  it("keeps physical usage scoped per mailbox and respects a selected mailbox", async () => {
    await storedItem(personId, 111);
    await storedItem(agentId, 222);
    await storedItem(otherBoxId, 999);
    const all = await usage();
    expect(new Map(all.mailboxes.map((box) => [box.mailboxId, box.storageUsedBytes]))).toEqual(
      new Map([
        [personId, 111],
        [agentId, 222],
      ]),
    );
    const selected = await usage(agentId);
    expect(selected.mailboxes).toHaveLength(1);
    expect(selected.mailboxes[0]).toMatchObject({ mailboxId: agentId, storageUsedBytes: 222 });
  });

  it("counts recipient reservations in the current period, preserving pending/unknown usage and excluding failed or prior-period attempts", async () => {
    await outbox(personId, "queued", 2);
    await outbox(personId, "sending", 3);
    await outbox(personId, "unknown", 4);
    await outbox(personId, "accepted", 5);
    await outbox(personId, "failed", 6);
    await outbox(personId, "accepted", 7, {
      periodStart: new Date(periodStart.getTime() - 30 * 86_400_000),
      periodEnd: new Date(periodStart.getTime()),
    });
    const { mailboxes } = await usage(personId);
    expect(mailboxes[0]).toMatchObject({
      outboundUsedRecipients: 14,
      outboundLimitRecipients: 100,
      periodStart,
      periodEnd,
    });
  });

  it("shows operator-owned System capacity of 50 GiB and all-time consumption without a commercial send limit", async () => {
    await db.update(schema.teams).set({ plan: "system" }).where(eq(schema.teams.id, teamId));
    await outbox(personId, "queued", 2);
    await outbox(personId, "unknown", 3);
    await outbox(personId, "failed", 4);
    await outbox(personId, "accepted", 7, {
      periodStart: new Date(periodStart.getTime() - 30 * 86_400_000),
      periodEnd: new Date(periodStart.getTime()),
    });
    const { mailboxes } = await usage(personId);
    expect(mailboxes[0]).toMatchObject({
      storageLimitBytes: 50 * 1024 ** 3,
      outboundUsedRecipients: 12,
      outboundLimitRecipients: null,
      periodStart: null,
      periodEnd: null,
    });
    const [audited] = await db
      .select()
      .from(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    expect(audited?.includedOutboundPerMailbox).toBe(100);
    expect(audited?.storageBytesPerMailbox).toBe(5 * 1024 * 1024);
  });

  it("does not treat team administration as private read access and only exposes explicitly delegated boxes", async () => {
    await storedItem(personId, 123);
    await storedItem(agentId, 456);
    expect(await usage(null, "admin")).toEqual({ mailboxes: [] });
    await expect(usage(personId, "admin")).rejects.toMatchObject({ code: "not_found" });
    await grantMailboxRegistry(db, actor(), {
      mailboxId: personId,
      userId: "admin",
      permission: "read",
    });
    const delegated = await usage(null, "admin");
    expect(delegated.mailboxes).toHaveLength(1);
    expect(delegated.mailboxes[0]).toMatchObject({ mailboxId: personId, storageUsedBytes: 123 });
    await expect(usage(agentId, "admin")).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects cross-tenant mailbox selections and actors without current team membership", async () => {
    await storedItem(otherBoxId, 789);
    await expect(usage(otherBoxId)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      getMailboxUsage(db, actor("outsider", otherTeamId), { mailboxId: personId }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(usage(null, "outsider")).rejects.toMatchObject({ code: "forbidden" });
    const foreign = await getMailboxUsage(db, actor("outsider", otherTeamId), {
      mailboxId: null,
    });
    expect(foreign.mailboxes).toHaveLength(1);
    expect(foreign.mailboxes[0]).toMatchObject({ mailboxId: otherBoxId, storageUsedBytes: 789 });
  });

  it("rechecks revoked grants and suspended mailboxes instead of retaining previous access", async () => {
    const grant = await grantMailboxRegistry(db, actor(), {
      mailboxId: personId,
      userId: "member",
      permission: "draft",
    });
    expect((await usage(null, "member")).mailboxes.map((box) => box.mailboxId)).toEqual([personId]);
    await revokeMailboxRegistry(db, actor(), grant.id);
    expect(await usage(null, "member")).toEqual({ mailboxes: [] });
    await expect(usage(personId, "member")).rejects.toMatchObject({ code: "not_found" });
    await db
      .update(schema.mailboxes)
      .set({ status: "suspended" })
      .where(eq(schema.mailboxes.id, personId));
    expect((await usage()).mailboxes.map((box) => box.mailboxId)).toEqual([agentId]);
    await expect(usage(personId)).rejects.toMatchObject({ code: "not_found" });
  });
});
