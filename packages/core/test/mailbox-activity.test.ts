import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EnvKeyring } from "../src/crypto/keyring.js";
import {
  appendMailboxActivity,
  listMailboxActivity,
  MAILBOX_ACTIVITY_ACTIONS,
  type MailboxActivityContext,
  type MailboxActivityCursor,
  type MailboxActivityEvent,
} from "../src/mailbox-activity.js";
import { createMailboxAgentKey } from "../src/mailbox-agent-access.js";
import { saveMailboxDraft } from "../src/mailbox-private-store.js";
import {
  type MailboxTransportMimeAdapter,
  queueMailboxAgentDraft,
  queueMailboxDraft,
} from "../src/mailbox-transport.js";

let client: PGlite;
let db: Db;
const keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
const mime: MailboxTransportMimeAdapter = {
  async parse(raw) {
    const headers = raw.toString("utf8").split("\r\n\r\n")[0]!;
    return {
      from: /^From: (.+)$/m.exec(headers)?.[1]?.trim() ?? "",
      to: /^To: (.+)$/m.exec(headers)?.[1]?.trim().split(", ") ?? [],
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
      .sort()) {
      await client.transaction(async (tx) => {
        for (const statement of readFileSync(path + name, "utf8").split("--> statement-breakpoint"))
          if (statement.trim()) await tx.exec(statement);
      });
    }
  }
  db = drizzle(client, { schema }) as unknown as Db;
});
afterAll(async () => {
  await client.close();
});

async function setup() {
  const userId = randomUUID();
  const [team] = await db
    .insert(schema.teams)
    .values({ name: "Private activity", slug: userId })
    .returning();
  const teamId = team!.id;
  await db.insert(schema.user).values({
    id: userId,
    name: "Current owner",
    email: `${userId}@example.invalid`,
    emailVerified: true,
  });
  const [member] = await db
    .insert(schema.teamMembers)
    .values({ teamId, userId, role: "owner" })
    .returning();
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: `${userId}.invalid`, status: "verified", region: "us-east-1" })
    .returning();
  const [box] = await db
    .insert(schema.mailboxes)
    .values({
      teamId,
      domainId: domain!.id,
      address: `agent@${domain!.name}`,
      label: "Private box",
      kind: "agent",
      ownerUserId: userId,
      ownerMembershipId: member!.id,
    })
    .returning();
  const now = Date.now();
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "active",
    seats: 2,
    storageBytesPerMailbox: 1048576,
    includedOutboundPerMailbox: 100,
    periodStart: new Date(now - 86400000),
    periodEnd: new Date(now + 86400000),
  });
  const actor = { teamId, userId };
  const key = await createMailboxAgentKey(db, actor, {
    mailboxId: box!.id,
    label: "Current agent",
    scopes: ["read", "draft", "send"],
  });
  const human: MailboxActivityContext = {
    teamId,
    mailboxId: box!.id,
    actor: { kind: "user", userId },
  };
  const agent: MailboxActivityContext = {
    teamId,
    mailboxId: box!.id,
    actor: { kind: "mailbox_agent", keyId: key.id },
  };
  const raw = Buffer.from(
    `From: ${box!.address}\r\nTo: recipient@example.invalid\r\nSubject: PRIVATE-SUBJECT\r\n\r\nPRIVATE-BODY`,
  );
  const draft = () =>
    saveMailboxDraft(db, keys, actor, { mailboxId: box!.id, expectedRevision: 0, raw });
  const append = (context: MailboxActivityContext, event: MailboxActivityEvent) =>
    db.transaction((tx) => appendMailboxActivity(tx as unknown as Db, context, event));
  const rows = () =>
    db
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.teamId, teamId), eq(schema.auditLog.target, `mailbox:${box!.id}`)),
      );
  return { actor, human, agent, append, rows, box: box!, member: member!, key, draft };
}

describe("private mailbox activity", () => {
  it("records distinct machine/human actors and only allowlisted facts", async () => {
    const f = await setup();
    const itemId = randomUUID();
    await f.append(f.agent, { action: "mailbox.items_listed", folder: "inbox", count: 2 });
    await f.append(f.agent, { action: "mailbox.item_read", itemId, revision: 1 });
    await f.append(f.human, { action: "mailbox.draft_saved", itemId, revision: 2 });
    const rows = await f.rows();
    expect(rows.map((row) => row.actorId)).toEqual([
      `mailbox_agent:${f.key.id}`,
      `mailbox_agent:${f.key.id}`,
      `user:${f.actor.userId}`,
    ]);
    expect(rows[0]?.data).toEqual({
      mailboxId: f.box.id,
      keyId: f.key.id,
      folder: "inbox",
      count: 2,
    });
    for (const row of rows) {
      expect(row.ip).toBeNull();
      expect(row.userAgent).toBeNull();
      expect(JSON.stringify(row)).not.toContain(f.key.token);
      expect(JSON.stringify(row)).not.toContain("PRIVATE-");
      expect(JSON.stringify(row)).not.toContain("recipient@");
    }
  });

  it("rejects content, credential, request, label and unknown metadata before insertion", async () => {
    const f = await setup();
    for (const field of [
      "text",
      "body",
      "subject",
      "recipients",
      "token",
      "keyHash",
      "ip",
      "userAgent",
      "label",
      "createdAt",
    ]) {
      await expect(
        f.append(f.agent, {
          action: "mailbox.items_listed",
          folder: "inbox",
          count: 0,
          [field]: "PRIVATE",
        } as unknown as MailboxActivityEvent),
      ).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(
      f.append({ ...f.agent, token: "PRIVATE" } as MailboxActivityContext, {
        action: "mailbox.items_listed",
        folder: "inbox",
        count: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      f.append(
        {
          ...f.agent,
          actor: { kind: "api_key", keyId: f.key.id },
        } as unknown as MailboxActivityContext,
        { action: "mailbox.items_listed", folder: "inbox", count: 0 },
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(await f.rows()).toEqual([]);
  });

  it("rejects other actions, unsafe folders, invalid UUIDs/counts/revisions", async () => {
    const f = await setup();
    const invalid = [
      { action: "content.revealed", itemId: randomUUID(), revision: 1 },
      { action: "mailbox.items_listed", folder: "quarantine", count: 1 },
      { action: "mailbox.items_listed", folder: "inbox", count: 51 },
      { action: "mailbox.items_listed", folder: "sent", count: -1 },
      { action: "mailbox.item_read", itemId: "bad", revision: 1 },
      { action: "mailbox.draft_saved", itemId: randomUUID(), revision: 0 },
      { action: "mailbox.send_approved", itemId: randomUUID(), revision: 1 },
    ];
    for (const event of invalid)
      await expect(f.append(f.agent, event as MailboxActivityEvent)).rejects.toMatchObject({
        code: "invalid",
      });
    expect(await f.rows()).toEqual([]);
  });

  it("does not swallow insert errors and rolls back the surrounding operation", async () => {
    const f = await setup();
    await expect(
      db.transaction(async (transaction) => {
        const tx = transaction as unknown as Db;
        await tx
          .update(schema.mailboxes)
          .set({ label: "Must roll back" })
          .where(eq(schema.mailboxes.id, f.box.id));
        const insert = vi.spyOn(tx, "insert").mockImplementation(() => {
          throw new Error("synthetic audit failure");
        });
        try {
          await appendMailboxActivity(tx, f.agent, {
            action: "mailbox.items_listed",
            folder: "inbox",
            count: 0,
          });
        } finally {
          insert.mockRestore();
        }
      }),
    ).rejects.toThrow("synthetic audit failure");
    const [box] = await db.select().from(schema.mailboxes).where(eq(schema.mailboxes.id, f.box.id));
    expect(box?.label).toBe("Private box");
    expect(await f.rows()).toEqual([]);
  });

  it("records one durable human/agent send approval and no new event on duplicate", async () => {
    for (const agent of [false, true]) {
      const f = await setup();
      const item = await f.draft();
      const input = { id: item.id, expectedRevision: item.revision };
      const queue = () =>
        agent
          ? queueMailboxAgentDraft(db, keys, f.key.token, input, mime)
          : queueMailboxDraft(db, keys, f.actor, { ...input, mailboxId: f.box.id }, mime);
      const first = await queue();
      const second = await queue();
      expect(second).toMatchObject({ id: first.id, duplicate: true });
      const rows = await f.rows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "mailbox.send_approved",
        actorId: agent ? `mailbox_agent:${f.key.id}` : `user:${f.actor.userId}`,
        data: { itemId: item.id, revision: item.revision, outboxId: first.id },
      });
    }
  });

  it("rolls back a new outbox approval when audit insertion fails", async () => {
    const f = await setup();
    const item = await f.draft();
    await client.exec(
      `CREATE FUNCTION activity_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='mailbox.send_approved' THEN RAISE EXCEPTION 'synthetic ledger failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER activity_fixture_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION activity_fixture_fail();`,
    );
    try {
      await expect(
        queueMailboxAgentDraft(
          db,
          keys,
          f.key.token,
          { id: item.id, expectedRevision: item.revision },
          mime,
        ),
      ).rejects.toThrow();
    } finally {
      await client.exec(
        "DROP TRIGGER activity_fixture_fail ON audit_log; DROP FUNCTION activity_fixture_fail();",
      );
    }
    expect(
      await db
        .select()
        .from(schema.mailboxOutbox)
        .where(eq(schema.mailboxOutbox.mailboxId, f.box.id)),
    ).toEqual([]);
    expect(await f.rows()).toEqual([]);
    const retry = await queueMailboxAgentDraft(
      db,
      keys,
      f.key.token,
      { id: item.id, expectedRevision: item.revision },
      mime,
    );
    expect(retry.duplicate).toBe(false);
    expect(await f.rows()).toHaveLength(1);
  });

  it("resolves labels from current scoped records and returns no raw metadata", async () => {
    const f = await setup();
    const itemId = randomUUID();
    await f.append(f.agent, {
      action: "mailbox.send_approved",
      itemId,
      revision: 1,
      outboxId: randomUUID(),
    });
    await f.append(f.human, { action: "mailbox.draft_saved", itemId, revision: 2 });
    await db
      .update(schema.mailboxAgentKeys)
      .set({ label: "Renamed agent", revokedAt: new Date() })
      .where(eq(schema.mailboxAgentKeys.id, f.key.id));
    await db
      .update(schema.user)
      .set({ name: "Renamed owner" })
      .where(eq(schema.user.id, f.actor.userId));
    const page = await listMailboxActivity(db, f.actor, { mailboxId: f.box.id });
    expect(page.items.map((row) => row.actor.label).sort()).toEqual([
      "Renamed agent",
      "Renamed owner",
    ]);
    for (const row of page.items) {
      expect(Object.keys(row).sort()).toEqual([
        "action",
        "actor",
        "createdAt",
        "id",
        "itemId",
        "revision",
      ]);
      expect(Object.keys(row.actor).sort()).toEqual(["kind", "label"]);
    }
    expect(JSON.stringify(page)).not.toContain(f.key.id);
    expect(JSON.stringify(page)).not.toContain("outboxId");
  });

  it("refuses support/agent/admin/delegate/foreign views and stale owner membership", async () => {
    const f = await setup();
    await f.append(f.agent, { action: "mailbox.items_listed", folder: "inbox", count: 0 });
    const outsider = randomUUID();
    await db
      .insert(schema.user)
      .values({ id: outsider, name: "Admin", email: `${outsider}@example.invalid` });
    const [member] = await db
      .insert(schema.teamMembers)
      .values({ teamId: f.actor.teamId, userId: outsider, role: "admin" })
      .returning();
    await db.insert(schema.mailboxGrants).values({
      mailboxId: f.box.id,
      teamId: f.actor.teamId,
      userId: outsider,
      membershipId: member!.id,
      permission: "read",
    });
    for (const actor of [
      { ...f.actor, supportView: true },
      { ...f.actor, agentAccess: true },
      { ...f.actor, userId: outsider },
      { ...f.actor, teamId: randomUUID() },
    ])
      await expect(listMailboxActivity(db, actor, { mailboxId: f.box.id })).rejects.toMatchObject({
        code: "forbidden",
      });
    await db.delete(schema.teamMembers).where(eq(schema.teamMembers.id, f.member.id));
    await db
      .insert(schema.teamMembers)
      .values({ teamId: f.actor.teamId, userId: f.actor.userId, role: "owner" });
    await expect(listMailboxActivity(db, f.actor, { mailboxId: f.box.id })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("denies prior owner after reassignment and suspended boxes", async () => {
    const f = await setup();
    await f.append(f.human, { action: "mailbox.items_listed", folder: "drafts", count: 0 });
    await db
      .update(schema.mailboxes)
      .set({ status: "suspended" })
      .where(eq(schema.mailboxes.id, f.box.id));
    await expect(listMailboxActivity(db, f.actor, { mailboxId: f.box.id })).rejects.toMatchObject({
      code: "forbidden",
    });
    await db
      .update(schema.mailboxes)
      .set({ status: "planned", ownerUserId: null, ownerMembershipId: null })
      .where(eq(schema.mailboxes.id, f.box.id));
    await expect(listMailboxActivity(db, f.actor, { mailboxId: f.box.id })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("scopes rows to team/box/action and rejects poisoned metadata from the DTO", async () => {
    const f = await setup();
    await f.append(f.human, { action: "mailbox.items_listed", folder: "sent", count: 0 });
    const base = {
      teamId: f.actor.teamId,
      actorId: `user:${f.actor.userId}`,
      action: "mailbox.items_listed",
      target: `mailbox:${f.box.id}`,
      data: { mailboxId: f.box.id, folder: "inbox", count: 1 },
    };
    await db.insert(schema.auditLog).values([
      { ...base, teamId: randomUUID() },
      { ...base, target: `mailbox:${randomUUID()}` },
      { ...base, action: "domain.created" },
      { ...base, actorId: `api_key:${f.key.id}` },
      { ...base, data: { ...base.data, text: "PRIVATE-POISON" } },
      {
        ...base,
        actorId: `mailbox_agent:${f.key.id}`,
        data: { ...base.data, keyId: randomUUID() },
      },
    ]);
    const page = await listMailboxActivity(db, f.actor, { mailboxId: f.box.id });
    expect(page.items).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain("PRIVATE-POISON");
  });

  it("uses an exact microsecond keyset with tied IDs and preserves every row once", async () => {
    const f = await setup();
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const times = [
      "2026-10-05T00:00:00.123456Z",
      "2026-10-05T00:00:00.123455Z",
      "2026-10-05T00:00:00.123455Z",
      "2026-10-05T00:00:00.123454Z",
    ];
    for (let i = 0; i < ids.length; i++)
      await db.execute(
        sql`INSERT INTO audit_log(id,team_id,actor_id,action,target,data,created_at) VALUES(${ids[i]}::uuid,${f.actor.teamId}::uuid,${`user:${f.actor.userId}`},'mailbox.items_listed',${`mailbox:${f.box.id}`},${JSON.stringify({ mailboxId: f.box.id, folder: "inbox", count: 0 })}::jsonb,${times[i]}::timestamptz)`,
      );
    const found: string[] = [];
    let cursor: MailboxActivityCursor | null = null;
    do {
      const page = await listMailboxActivity(db, f.actor, {
        mailboxId: f.box.id,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      found.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor;
      if (cursor) expect(cursor.createdAt).toMatch(/\.\d{6}Z$/);
    } while (cursor);
    expect(new Set(found).size).toBe(4);
    expect(found).toEqual([ids[0], ...ids.slice(1, 3).sort().reverse(), ids[3]]);
  });

  it("records organization facts privately without accepting folder names or returning message contents", async () => {
    const f = await setup();
    const folderId = randomUUID();
    const itemId = randomUUID();
    for (const event of [
      { action: "mailbox.folder_created", folderId, revision: 1 },
      { action: "mailbox.folder_renamed", folderId, revision: 2 },
      { action: "mailbox.item_starred", itemId, revision: 2 },
      { action: "mailbox.item_folder_changed", itemId, folderId, revision: 3 },
      { action: "mailbox.item_unstarred", itemId, revision: 4 },
      { action: "mailbox.folder_archived", folderId, revision: 3 },
    ] as const)
      await f.append(f.human, event);
    await expect(
      f.append(f.human, {
        action: "mailbox.folder_created",
        folderId,
        revision: 1,
        name: "PRIVATE-FOLDER",
      } as MailboxActivityEvent),
    ).rejects.toMatchObject({ code: "invalid" });
    const page = await listMailboxActivity(db, f.actor, { mailboxId: f.box.id });
    expect(page.items).toHaveLength(6);
    expect(page.items.find((event) => event.action === "mailbox.folder_created")).toMatchObject({
      folderId,
      revision: 1,
    });
    expect(
      page.items.find((event) => event.action === "mailbox.item_folder_changed"),
    ).toMatchObject({ itemId, folderId, revision: 3 });
    expect(JSON.stringify(page)).not.toContain("PRIVATE-FOLDER");
  });
  it("bounds reader input and includes only supported private mailbox actions", async () => {
    const f = await setup();
    expect(MAILBOX_ACTIVITY_ACTIONS).toEqual([
      "mailbox.items_listed",
      "mailbox.item_read",
      "mailbox.draft_saved",
      "mailbox.send_approved",
      "mailbox.send_requested",
      "mailbox.item_trashed",
      "mailbox.item_restored",
      "mailbox.item_starred",
      "mailbox.item_unstarred",
      "mailbox.item_archived",
      "mailbox.item_unarchived",
      "mailbox.item_folder_changed",
      "mailbox.folder_created",
      "mailbox.folder_renamed",
      "mailbox.folder_archived",
    ]);
    for (const input of [
      { mailboxId: f.box.id, limit: 51 },
      { mailboxId: "bad" },
      { mailboxId: f.box.id, cursor: { createdAt: "DROP TABLE audit_log", id: randomUUID() } },
      { mailboxId: f.box.id, token: "PRIVATE" },
    ])
      await expect(
        listMailboxActivity(db, f.actor, input as Parameters<typeof listMailboxActivity>[2]),
      ).rejects.toMatchObject({ code: "invalid" });
  });
});
