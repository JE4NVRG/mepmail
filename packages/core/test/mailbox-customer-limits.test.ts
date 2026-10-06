import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EnvKeyring } from "../src/crypto/keyring.js";
import {
  importMailboxMime,
  readMailboxItem,
  saveMailboxDraft,
} from "../src/mailbox-private-store.js";
import { createMailboxRegistry } from "../src/mailbox-registry.js";
import {
  assertMailboxStorage,
  lockMailboxService,
  mailboxServiceState,
  SYSTEM_MAILBOX_STORAGE_BYTES,
} from "../src/mailbox-service.js";
import {
  type MailboxOutboxSender,
  type MailboxTransportMimeAdapter,
  queueMailboxDraft,
  sendMailboxOutbox,
} from "../src/mailbox-transport.js";

let client: PGlite;
let db: Db;
const keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
const operatorId = randomUUID();
const GIB = 1024 ** 3;
const PLANS = [
  { name: "1 GiB / 500 recipients", storageBytes: GIB, outbound: 500 },
  { name: "10 GiB / 2,000 recipients", storageBytes: 10 * GIB, outbound: 2000 },
] as const;
type Plan = (typeof PLANS)[number];
type Box = typeof schema.mailboxes.$inferSelect;

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture row");
  return value;
}

// Only MIME parsing and the provider are synthetic. Encryption, authorization,
// reservations, recipient normalization and all DDL use the real Core contract.
const mime: MailboxTransportMimeAdapter = {
  async parse(raw) {
    const headers = required(raw.toString("utf8").split("\r\n\r\n")[0]);
    const addresses = (header: string) =>
      new RegExp(`^${header}: (.+)$`, "m").exec(headers)?.[1]?.trim().split(", ") ?? [];
    return {
      from: addresses("From")[0] ?? "",
      to: addresses("To"),
      cc: addresses("Cc"),
      bcc: addresses("Bcc"),
      attachmentBytes: [],
    };
  },
};

beforeAll(async () => {
  client = new PGlite();
  for (const folder of ["../../db/drizzle/", "../../db/mailbox-drizzle/"]) {
    const path = fileURLToPath(new URL(folder, import.meta.url));
    for (const name of readdirSync(path)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await client.transaction(async (tx) => {
        for (const statement of readFileSync(path + name, "utf8").split("--> statement-breakpoint"))
          if (statement.trim()) await tx.exec(statement);
      });
  }
  db = drizzle(client, { schema }) as unknown as Db;
  await db.insert(schema.user).values({
    id: operatorId,
    name: "Platform operator fixture",
    email: `${operatorId}@example.invalid`,
    emailVerified: true,
    createdAt: new Date("2000-01-01T00:00:00Z"),
  });
});

afterAll(async () => {
  await client.close();
});

async function fixture(plan: Plan = PLANS[0], system = false) {
  const id = randomUUID();
  const userId = system ? operatorId : id;
  if (!system)
    await db.insert(schema.user).values({
      id: userId,
      name: "Customer fixture",
      email: `${userId}@example.invalid`,
      emailVerified: true,
    });
  const [team] = await db
    .insert(schema.teams)
    .values({ name: "Finite resources fixture", slug: id, plan: system ? "system" : "free" })
    .returning();
  const teamId = required(team).id;
  await db.insert(schema.teamMembers).values({ teamId, userId, role: "owner" });
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: `${id}.example.invalid`, status: "verified", region: "us-east-1" })
    .returning();
  const domainId = required(domain).id;
  const now = Date.now();
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "active",
    seats: 2,
    storageBytesPerMailbox: plan.storageBytes,
    includedOutboundPerMailbox: plan.outbound,
    periodStart: new Date(now - 3600000),
    periodEnd: new Date(now + 3600000),
  });
  const actor = { teamId, userId };
  const create = (localPart: string, kind: "person" | "agent" = "person") =>
    createMailboxRegistry(db, actor, {
      domainId,
      localPart,
      label: localPart,
      kind,
      ownerUserId: userId,
    });
  const person = await create("person");
  const agent = await create("agent", "agent");
  return { actor, teamId, person, agent, plan, create };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function rawFor(box: Box, count: number) {
  const to = Array.from({ length: count }, (_, i) => `recipient${i}@example.invalid`);
  return Buffer.from(
    `From: ${box.address}\r\nTo: ${to.join(", ")}\r\nSubject: Fixture\r\n\r\nPrivate fixture body`,
  );
}

function draft(f: Fixture, box: Box, count = 1, raw = rawFor(box, count)) {
  return saveMailboxDraft(db, keys, f.actor, { mailboxId: box.id, expectedRevision: 0, raw });
}

async function reserve(f: Fixture, box: Box, count: number) {
  const item = await draft(f, box, count);
  return queueMailboxDraft(
    db,
    keys,
    f.actor,
    {
      mailboxId: box.id,
      id: item.id,
      expectedRevision: item.revision,
    },
    mime,
  );
}

async function fill(f: Fixture, box: Box, recipients: number) {
  for (let remaining = recipients; remaining > 0; ) {
    const count = Math.min(20, remaining);
    expect((await reserve(f, box, count)).recipientCount).toBe(count);
    remaining -= count;
  }
}

async function usage(f: Fixture, box: Box) {
  const rows = await db
    .select()
    .from(schema.mailboxOutbox)
    .where(
      and(eq(schema.mailboxOutbox.teamId, f.teamId), eq(schema.mailboxOutbox.mailboxId, box.id)),
    );
  return {
    rows,
    charged: rows
      .filter((row) => row.status !== "failed")
      .reduce((sum, row) => sum + row.recipientCount, 0),
  };
}

describe("finite Correio customer outbound allowances", () => {
  it.each(PLANS)(
    "admits exactly $name, refuses +1 and keeps the other box independent",
    async (plan) => {
      const f = await fixture(plan);
      const state = await mailboxServiceState(db, f.teamId);
      expect(state.storageBytesPerMailbox).toBe(plan.storageBytes);
      expect(state.includedOutboundPerMailbox).toBe(plan.outbound);
      expect(state.unlimitedSeats).toBe(false);
      expect(state.unlimitedOutbound).toBe(false);
      await fill(f, f.person, plan.outbound);
      const before = await usage(f, f.person);
      expect(before.charged).toBe(plan.outbound);
      expect(before.rows).toHaveLength(plan.outbound / 20);
      await expect(reserve(f, f.person, 1)).rejects.toMatchObject({ code: "quota" });
      expect((await usage(f, f.person)).charged).toBe(plan.outbound);
      expect((await usage(f, f.person)).rows).toHaveLength(before.rows.length);
      expect((await reserve(f, f.agent, 20)).recipientCount).toBe(20);
      expect((await usage(f, f.agent)).charged).toBe(20);
    },
  );

  it.each(PLANS)(
    "concurrent approvals cannot reserve the last recipient twice: $name",
    async (plan) => {
      const f = await fixture(plan);
      await fill(f, f.person, plan.outbound - 1);
      const a = await draft(f, f.person);
      const b = await draft(f, f.person);
      const approve = (item: typeof a) =>
        queueMailboxDraft(
          db,
          keys,
          f.actor,
          {
            mailboxId: f.person.id,
            id: item.id,
            expectedRevision: item.revision,
          },
          mime,
        );
      // These are concurrent real admissions. PGlite schedules a single connection;
      // this is not a claim of a multi-connection PostgreSQL race exercise.
      const results = await Promise.allSettled([approve(a), approve(b)]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const denied = results.find((result) => result.status === "rejected");
      expect(denied?.status === "rejected" ? denied.reason : null).toMatchObject({ code: "quota" });
      expect((await usage(f, f.person)).charged).toBe(plan.outbound);
    },
  );

  it("charges the authority's canonical distinct To/Cc recipients and preserves a replay's reservation", async () => {
    const f = await fixture();
    await fill(f, f.person, f.plan.outbound - 2);
    const raw = Buffer.from(
      `From: ${f.person.address}\r\nTo: First@Example.invalid, first@example.invalid\r\nCc: FIRST@example.invalid, second@example.invalid, SECOND@example.invalid\r\n\r\nFixture`,
    );
    const item = await draft(f, f.person, 1, raw);
    const approve = () =>
      queueMailboxDraft(
        db,
        keys,
        f.actor,
        {
          mailboxId: f.person.id,
          id: item.id,
          expectedRevision: item.revision,
        },
        mime,
      );
    const queued = await approve();
    expect(queued.recipientCount).toBe(2);
    expect(await approve()).toMatchObject({ id: queued.id, duplicate: true, recipientCount: 2 });
    expect((await usage(f, f.person)).charged).toBe(f.plan.outbound);
    const send = vi.fn(async (_input: Parameters<MailboxOutboxSender["send"]>[0]) => ({
      messageId: "synthetic-provider-acceptance",
    }));
    expect(await sendMailboxOutbox(db, keys, queued.id, { send }, mime)).toMatchObject({
      status: "accepted",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      to: ["first@example.invalid"],
      cc: ["second@example.invalid"],
      bcc: [],
    });
    expect((await usage(f, f.person)).charged).toBe(f.plan.outbound);
    await expect(reserve(f, f.person, 1)).rejects.toMatchObject({ code: "quota" });
  });

  const invalidPolicies = [
    { name: "inactive", change: { status: "inactive" as const } },
    { name: "past due", change: { status: "past_due" as const } },
    { name: "canceled", change: { status: "canceled" as const } },
    { name: "no licensed seats", change: { seats: 0 } },
    {
      name: "expired period",
      change: {
        periodStart: new Date(Date.now() - 7200000),
        periodEnd: new Date(Date.now() - 3600000),
      },
    },
    {
      name: "future period",
      change: {
        periodStart: new Date(Date.now() + 3600000),
        periodEnd: new Date(Date.now() + 7200000),
      },
    },
  ];
  it.each(invalidPolicies)(
    "$name refuses write/approval/worker send, but preserves an authorized private read",
    async ({ change }) => {
      const f = await fixture();
      const raw = rawFor(f.person, 1);
      const existing = await importMailboxMime(db, keys, f.actor, {
        mailboxId: f.person.id,
        sourceId: `fixture:${randomUUID()}`,
        raw,
      });
      const unapproved = await draft(f, f.person);
      const queued = await reserve(f, f.person, 1);
      await db
        .update(schema.mailboxSubscriptions)
        .set(change)
        .where(eq(schema.mailboxSubscriptions.teamId, f.teamId));
      await expect(draft(f, f.person)).rejects.toMatchObject({ code: "not_entitled" });
      await expect(
        queueMailboxDraft(
          db,
          keys,
          f.actor,
          {
            mailboxId: f.person.id,
            id: unapproved.id,
            expectedRevision: unapproved.revision,
          },
          mime,
        ),
      ).rejects.toMatchObject({ code: "not_entitled" });
      const send = vi.fn(async () => ({ messageId: "must-never-be-called" }));
      expect(await sendMailboxOutbox(db, keys, queued.id, { send }, mime)).toMatchObject({
        status: "failed",
        errorCode: "admission_refused",
      });
      expect(send).not.toHaveBeenCalled();
      expect(
        (
          await readMailboxItem(db, keys, f.actor, { mailboxId: f.person.id, id: existing.id })
        ).raw.equals(raw),
      ).toBe(true);
    },
  );

  it("System has 50 GiB per box and no commercial outbound cap without changing its audited terms", async () => {
    const f = await fixture(PLANS[0], true);
    const [before] = await db
      .select()
      .from(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, f.teamId));
    const third = await f.create("third", "agent");
    expect(await mailboxServiceState(db, f.teamId)).toMatchObject({
      licenseKind: "system",
      unlimitedSeats: true,
      unlimitedOutbound: true,
      seats: 2,
      reservedSeats: 3,
      includedOutboundPerMailbox: 500,
      storageBytesPerMailbox: 50 * GIB,
      periodStart: null,
      periodEnd: null,
    });
    await fill(f, third, 500);
    expect((await reserve(f, third, 1)).recipientCount).toBe(1);
    const submitted = await usage(f, third);
    expect(submitted.charged).toBe(501);
    // Exercise the exact capacity using real persisted MIME/outbox aggregates,
    // without allocating fifty GiB of fixture bodies in memory.
    const drafts = await db
      .select({ bytes: schema.mailboxItems.rawBytes })
      .from(schema.mailboxItems)
      .where(eq(schema.mailboxItems.mailboxId, third.id));
    const stored =
      drafts.reduce((sum, row) => sum + row.bytes, 0) +
      submitted.rows.reduce((sum, row) => sum + row.rawBytes, 0);
    const operational = await lockMailboxService(db, f.teamId);
    expect(operational.storageBytesPerMailbox).toBe(SYSTEM_MAILBOX_STORAGE_BYTES);
    await expect(
      assertMailboxStorage(db, f.teamId, third.id, 50 * GIB - stored, operational),
    ).resolves.toBeUndefined();
    await expect(
      assertMailboxStorage(db, f.teamId, third.id, 50 * GIB - stored + 1, operational),
    ).rejects.toMatchObject({ code: "quota" });
    const fourth = await f.create("fourth");
    const fourthDraft = await draft(f, fourth);
    expect((await reserve(f, fourth, 1)).recipientCount).toBe(1);
    expect(
      (await readMailboxItem(db, keys, f.actor, { mailboxId: fourth.id, id: fourthDraft.id })).raw
        .length,
    ).toBeGreaterThan(1);
    expect(await mailboxServiceState(db, f.teamId)).toMatchObject({
      active: true,
      unlimitedSeats: true,
      unlimitedOutbound: true,
      seats: 2,
      reservedSeats: 4,
      storageBytesPerMailbox: 50 * GIB,
    });
    const [after] = await db
      .select()
      .from(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, f.teamId));
    expect(after).toEqual(before);
  });

  it("System ignores the pilot's commercial expiration and retains pending sends without changing the grant", async () => {
    const f = await fixture(PLANS[0], true);
    const existing = await draft(f, f.agent);
    const queued = await reserve(f, f.agent, 1);
    await db
      .update(schema.mailboxSubscriptions)
      .set({
        periodStart: new Date(Date.now() - 7200000),
        periodEnd: new Date(Date.now() - 3600000),
      })
      .where(eq(schema.mailboxSubscriptions.teamId, f.teamId));
    expect(await mailboxServiceState(db, f.teamId)).toMatchObject({
      active: true,
      licenseKind: "system",
      unlimitedSeats: true,
      unlimitedOutbound: true,
      resourcePolicyActive: true,
      periodStart: null,
      periodEnd: null,
    });
    await expect(draft(f, f.agent)).resolves.toBeDefined();
    const send = vi.fn(async () => ({ messageId: "synthetic-system-acceptance" }));
    expect(await sendMailboxOutbox(db, keys, queued.id, { send }, mime)).toMatchObject({
      status: "accepted",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (
        await readMailboxItem(db, keys, f.actor, { mailboxId: f.agent.id, id: existing.id })
      ).raw.equals(rawFor(f.agent, 1)),
    ).toBe(true);
  });

  it("System's internal policy is independent of canceled commercial terms, but a missing snapshot still refuses writes", async () => {
    const f = await fixture(PLANS[0], true);
    await db
      .update(schema.mailboxSubscriptions)
      .set({
        status: "canceled",
        seats: 0,
        storageBytesPerMailbox: 1,
        includedOutboundPerMailbox: 0,
      })
      .where(eq(schema.mailboxSubscriptions.teamId, f.teamId));
    expect((await reserve(f, f.person, 1)).recipientCount).toBe(1);
    await db
      .delete(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, f.teamId));
    expect(await mailboxServiceState(db, f.teamId)).toMatchObject({
      licenseKind: "system",
      unlimitedOutbound: true,
      resourcePolicyActive: false,
    });
    await expect(draft(f, f.person)).rejects.toMatchObject({ code: "not_entitled" });
  });

  it("losing the operator owner or suspending System retains authorization and paid-limit enforcement", async () => {
    const f = await fixture(PLANS[0], true);
    await fill(f, f.person, f.plan.outbound);
    await db
      .update(schema.teamMembers)
      .set({ role: "admin" })
      .where(
        and(eq(schema.teamMembers.teamId, f.teamId), eq(schema.teamMembers.userId, operatorId)),
      );
    expect(await mailboxServiceState(db, f.teamId)).toMatchObject({
      unlimitedSeats: false,
      unlimitedOutbound: false,
      storageBytesPerMailbox: GIB,
    });
    await expect(reserve(f, f.person, 1)).rejects.toMatchObject({ code: "quota" });
    const suspended = await fixture(PLANS[0], true);
    const queued = await reserve(suspended, suspended.person, 1);
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.teams.id, suspended.teamId));
    await expect(draft(suspended, suspended.person)).rejects.toMatchObject({
      code: "not_entitled",
    });
    const send = vi.fn(async () => ({ messageId: "must-never-be-called" }));
    expect(await sendMailboxOutbox(db, keys, queued.id, { send }, mime)).toMatchObject({
      status: "failed",
    });
    expect(send).not.toHaveBeenCalled();
  });
});
