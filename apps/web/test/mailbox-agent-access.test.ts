import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvKeyring } from "../../../packages/core/src/crypto/keyring.js";
import {
  createMailboxAgentKey,
  createMailboxTeamAgentKey,
  listExpiringMailboxAgentCredentials,
  listMailboxAgentAccounts,
  listMailboxAgentKeys,
  listMailboxTeamAgentKeys,
  parseMailboxSelector,
  revokeMailboxAgentKey,
  revokeMailboxTeamAgentKey,
  withMailboxAgentAccess,
} from "../../../packages/core/src/mailbox-agent-access.js";
import { assessMailboxReceipt } from "../../../packages/core/src/mailbox-inbound-safety.js";
import {
  listMailboxItems,
  readMailboxItem,
  saveMailboxDraft,
  setMailboxDeliveryFolder,
} from "../../../packages/core/src/mailbox-private-store.js";
import {
  createMailboxRegistry,
  grantMailboxRegistry,
  updateMailboxRegistry,
} from "../../../packages/core/src/mailbox-registry.js";
import { receiveMailboxMime } from "../../../packages/core/src/mailbox-transport.js";
import { seedMailboxTestService } from "./mailbox-service-fixture";

const base = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const mail = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
let client: PGlite,
  db: Db,
  teamId: string,
  foreignTeamId: string,
  mailboxId: string,
  personId: string,
  foreignMailboxId: string;
let keyring: EnvKeyring;
const owner = () => ({ teamId, userId: "owner" });
const mime = Buffer.from(
  "From: agent@local.invalid\r\nTo: recipient@example.invalid\r\nSubject: Private agent fixture\r\n\r\nPrivate body",
);
const mint = (input: Partial<Parameters<typeof createMailboxAgentKey>[2]> = {}) =>
  createMailboxAgentKey(db, owner(), { mailboxId, label: "Local runtime", ...input });
const bridge = (token: string, scope: "read" | "draft" | "send" = "read") =>
  withMailboxAgentAccess(db, token, scope, async ({ actor, mailboxId: box }) => ({
    actor,
    mailboxId: box,
  }));

beforeEach(async () => {
  client = new PGlite();
  // Match the production migrator: each main migration's locks and DDL share one transaction.
  for (const name of readdirSync(base)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    await client.transaction(async (tx) => {
      for (const statement of readFileSync(base + name, "utf8")
        .split("--> statement-breakpoint")
        .filter((part) => part.trim()))
        await tx.exec(statement);
    });
  const database = drizzle(client, { schema });
  db = database as unknown as Db;
  // Mailbox migrations remain independent from the production Send migration journal.
  await migrate(database, { migrationsFolder: mail, migrationsTable: "__mailbox_migrations" });
  const teams = await db
    .insert(schema.teams)
    .values([
      { name: "Agents", slug: "agents" },
      { name: "Other", slug: "other" },
    ])
    .returning();
  teamId = teams[0]!.id;
  foreignTeamId = teams[1]!.id;
  await seedMailboxTestService(db, [teamId, foreignTeamId]);
  await db.insert(schema.user).values(
    ["owner", "admin", "delegate", "foreign"].map((id) => ({
      id,
      name: id,
      email: id + "@example.invalid",
      emailVerified: true,
    })),
  );
  await db.insert(schema.teamMembers).values([
    { teamId, userId: "owner", role: "owner" },
    { teamId, userId: "admin", role: "admin" },
    { teamId, userId: "delegate", role: "member" },
    { teamId: foreignTeamId, userId: "foreign", role: "owner" },
  ]);
  const domains = await db
    .insert(schema.domains)
    .values([
      { teamId, name: "local.invalid", region: "us-east-1" },
      { teamId: foreignTeamId, name: "foreign.invalid", region: "us-east-1" },
    ])
    .returning();
  mailboxId = (
    await createMailboxRegistry(db, owner(), {
      domainId: domains[0]!.id,
      localPart: "agent",
      label: "Agent",
      kind: "agent",
      ownerUserId: "owner",
    })
  ).id;
  personId = (
    await createMailboxRegistry(db, owner(), {
      domainId: domains[0]!.id,
      localPart: "person",
      label: "Person",
      kind: "person",
      ownerUserId: "owner",
    })
  ).id;
  foreignMailboxId = (
    await createMailboxRegistry(
      db,
      { teamId: foreignTeamId, userId: "foreign" },
      {
        domainId: domains[1]!.id,
        localPart: "other",
        label: "Other",
        kind: "agent",
        ownerUserId: "foreign",
      },
    )
  ).id;
  keyring = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
});
afterEach(async () => {
  await client.close();
});

describe("mailbox agent credentials", () => {
  it("keeps unsafe receipts inaccessible to a real bearer until the human owner reviews Spam", async () => {
    await db
      .update(schema.domains)
      .set({ status: "verified" })
      .where(eq(schema.domains.teamId, teamId));
    const key = await mint();
    const adapter = {
      parse: vi.fn(async () => ({
        from: "agent@local.invalid",
        to: ["recipient@example.invalid"],
        cc: [],
        bcc: [],
        attachmentBytes: [],
      })),
    };
    const receive = (sourceId: string, virus: "PASS" | "FAIL") =>
      receiveMailboxMime(
        db,
        keyring,
        {
          sourceId,
          recipients: ["agent@local.invalid"],
          raw: mime,
          assessment: assessMailboxReceipt({
            virusVerdict: { status: virus },
            spamVerdict: { status: "FAIL" },
          }),
        },
        adapter,
      );
    const spam = (await receive("bearer:spam", "PASS")).items[0]!;
    const quarantine = (await receive("bearer:quarantine", "FAIL")).items[0]!;
    const read = (id: string) =>
      withMailboxAgentAccess(db, key.token, "read", ({ db: tx, actor, mailboxId: box }) =>
        readMailboxItem(tx, keyring, actor, { mailboxId: box, id }),
      );
    const list = () =>
      withMailboxAgentAccess(db, key.token, "read", ({ db: tx, actor, mailboxId: box }) =>
        listMailboxItems(tx, actor, box),
      );
    expect(adapter.parse).toHaveBeenCalledTimes(1);
    expect(await list()).toHaveLength(0);
    for (const item of [spam, quarantine]) {
      await expect(read(item.id)).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        withMailboxAgentAccess(db, key.token, "read", ({ db: tx, actor, mailboxId: box }) =>
          setMailboxDeliveryFolder(tx, actor, {
            mailboxId: box,
            id: item.id,
            expectedRevision: 1,
            folder: "inbox",
          }),
        ),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    await expect(
      setMailboxDeliveryFolder(db, owner(), {
        mailboxId,
        id: quarantine.id,
        expectedRevision: 1,
        folder: "inbox",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await setMailboxDeliveryFolder(db, owner(), {
      mailboxId,
      id: spam.id,
      expectedRevision: 1,
      folder: "inbox",
    });
    expect((await read(spam.id)).raw.equals(mime)).toBe(true);
    expect(await list()).toEqual([
      expect.objectContaining({
        id: spam.id,
        deliveryFolder: "inbox",
        revision: 2,
        inboundAssessment: expect.objectContaining({ decision: "spam" }),
      }),
    ]);
    await expect(read(quarantine.id)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("reveals a strong one-time token, persists only its hash and returns bounded metadata", async () => {
    const first = await mint();
    const second = await mint({ mailboxId: personId });
    expect(first.token).toMatch(/^mmb_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(first.token).not.toBe(second.token);
    expect(first.scopes).toEqual(["read", "draft"]);
    const [stored] = await db
      .select()
      .from(schema.mailboxAgentKeys)
      .where(eq(schema.mailboxAgentKeys.id, first.id));
    expect(stored!.keyHash).toBe(createHash("sha256").update(first.token).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(first.token);
    const listed = await listMailboxAgentKeys(db, owner(), mailboxId);
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0]!)).toEqual([
      "id",
      "mailboxId",
      "label",
      "scopes",
      "createdAt",
      "expiresAt",
      "revokedAt",
      "lastUsedAt",
      "lastSentAt",
    ]);
    expect(first).not.toHaveProperty("keyHash");
    expect(await bridge(first.token)).toEqual({
      actor: { ...owner(), agentAccess: true },
      mailboxId,
    });
    expect(
      await withMailboxAgentAccess(db, first.token, "read", async (context) => ({
        keyId: context.keyId,
        ownerMembershipId: context.ownerMembershipId,
        expiresAt: context.expiresAt,
      })),
    ).toEqual({ keyId: first.id, ownerMembershipId: stored!.ownerMembershipId, expiresAt: null });
    expect(await bridge(second.token)).toEqual({
      actor: { ...owner(), agentAccess: true },
      mailboxId: personId,
    });
    await expect(
      db
        .update(schema.mailboxAgentKeys)
        .set({ teamId: foreignTeamId })
        .where(eq(schema.mailboxAgentKeys.id, first.id)),
    ).rejects.toThrow();
  });

  it("requires the exact scope and secret; Send credentials and forged secrets cannot open a mailbox", async () => {
    const key = await mint({ scopes: ["read"] });
    const invoked = vi.fn(async () => true);
    for (const scope of ["draft", "send"] as const)
      await expect(withMailboxAgentAccess(db, key.token, scope, invoked)).rejects.toMatchObject({
        code: "forbidden",
      });
    const secret = key.token.slice(key.token.indexOf(".") + 1);
    const forged =
      key.token.slice(0, key.token.indexOf(".") + 1) +
      (secret[0] === "A" ? "B" : "A") +
      secret.slice(1);
    for (const token of [forged, "ms_" + "a".repeat(32), key.token + " ", "mmb_bad.secret"])
      await expect(withMailboxAgentAccess(db, token, "read", invoked)).rejects.toMatchObject({
        code: "forbidden",
      });
    expect(invoked).not.toHaveBeenCalled();
    expect((await bridge(key.token)).mailboxId).toBe(mailboxId);
    const consented = await mint({ scopes: ["send"] });
    expect((await bridge(consented.token, "send")).mailboxId).toBe(mailboxId);
    await expect(bridge(consented.token, "read")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("lets only the current mailbox owner manage credentials, including a member who owns a box", async () => {
    const key = await mint();
    await grantMailboxRegistry(db, owner(), { mailboxId, userId: "delegate", permission: "draft" });
    for (const actor of [
      { teamId, userId: "admin" },
      { teamId, userId: "delegate" },
      { ...owner(), supportView: true },
    ]) {
      await expect(
        createMailboxAgentKey(db, actor, { mailboxId, label: "No consent", scopes: ["send"] }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(listMailboxAgentKeys(db, actor, mailboxId)).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(
        revokeMailboxAgentKey(db, actor, { mailboxId, id: key.id }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
    await expect(mint({ mailboxId: foreignMailboxId })).rejects.toMatchObject({
      code: "forbidden",
    });
    await updateMailboxRegistry(db, owner(), {
      id: mailboxId,
      label: "Delegated owner",
      ownerUserId: "delegate",
      status: "planned",
    });
    await expect(mint()).rejects.toMatchObject({ code: "forbidden" });
    const current = await createMailboxAgentKey(
      db,
      { teamId, userId: "delegate" },
      { mailboxId, label: "Authorized" },
    );
    expect((await bridge(current.token)).actor).toEqual({
      teamId,
      userId: "delegate",
      agentAccess: true,
    });
    await revokeMailboxAgentKey(db, { teamId, userId: "delegate" }, { mailboxId, id: key.id });
  });

  it("writes and reads encrypted drafts in the locked transaction, rolling back failed operations", async () => {
    const key = await mint();
    const draft = await withMailboxAgentAccess(
      db,
      key.token,
      "draft",
      ({ db: tx, actor, mailboxId: box }) =>
        saveMailboxDraft(tx, keyring, actor, { mailboxId: box, expectedRevision: 0, raw: mime }),
    );
    const opened = await withMailboxAgentAccess(
      db,
      key.token,
      "read",
      ({ db: tx, actor, mailboxId: box }) =>
        readMailboxItem(tx, keyring, actor, { mailboxId: box, id: draft.id }),
    );
    expect(opened.raw.equals(mime)).toBe(true);
    await expect(
      withMailboxAgentAccess(db, key.token, "draft", async ({ db: tx, actor, mailboxId: box }) => {
        await saveMailboxDraft(tx, keyring, actor, {
          mailboxId: box,
          expectedRevision: 0,
          raw: mime,
        });
        throw new Error("fixture rollback");
      }),
    ).rejects.toThrow("fixture rollback");
    expect(await listMailboxItems(db, owner(), mailboxId)).toHaveLength(1);
    await db
      .update(schema.mailboxSubscriptions)
      .set({ storageBytesPerMailbox: mime.length })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    await expect(
      withMailboxAgentAccess(db, key.token, "draft", ({ db: tx, actor, mailboxId: box }) =>
        saveMailboxDraft(tx, keyring, actor, { mailboxId: box, expectedRevision: 0, raw: mime }),
      ),
    ).rejects.toMatchObject({ code: "quota" });
  });

  it("blocks revoked, expired, suspended and altered-pin credentials before invoking the callback", async () => {
    const revoked = await mint();
    await revokeMailboxAgentKey(db, owner(), { mailboxId, id: revoked.id });
    await revokeMailboxAgentKey(db, owner(), { mailboxId, id: revoked.id });
    const expired = await mint();
    await db
      .update(schema.mailboxAgentKeys)
      .set({
        createdAt: new Date(Date.now() - 172800000),
        expiresAt: new Date(Date.now() - 86400000),
      })
      .where(eq(schema.mailboxAgentKeys.id, expired.id));
    const pin = await mint();
    const [delegate] = await db
      .select({ id: schema.teamMembers.id })
      .from(schema.teamMembers)
      .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, "delegate")));
    await db
      .update(schema.mailboxAgentKeys)
      .set({ ownerMembershipId: delegate!.id })
      .where(eq(schema.mailboxAgentKeys.id, pin.id));
    const suspended = await mint();
    await updateMailboxRegistry(db, owner(), {
      id: mailboxId,
      label: "Agent",
      ownerUserId: "owner",
      status: "suspended",
    });
    const invoked = vi.fn(async () => true);
    for (const key of [revoked, expired, pin, suspended])
      await expect(withMailboxAgentAccess(db, key.token, "read", invoked)).rejects.toMatchObject({
        code: "forbidden",
      });
    expect(invoked).not.toHaveBeenCalled();
    // Revocation and metadata remain accessible to the current owner on a suspended box.
    await revokeMailboxAgentKey(db, owner(), { mailboxId, id: suspended.id });
    expect(await listMailboxAgentKeys(db, owner(), mailboxId)).toHaveLength(4);
  });

  it("keeps reassignment revocation permanent and membership reentry never restores old authorization", async () => {
    const key = await mint();
    await updateMailboxRegistry(db, owner(), {
      id: mailboxId,
      label: "Other owner",
      ownerUserId: "delegate",
      status: "planned",
    });
    await expect(bridge(key.token)).rejects.toMatchObject({ code: "forbidden" });
    await updateMailboxRegistry(db, owner(), {
      id: mailboxId,
      label: "Original owner",
      ownerUserId: "owner",
      status: "planned",
    });
    await expect(bridge(key.token)).rejects.toMatchObject({ code: "forbidden" });
    const current = await mint();
    await db
      .delete(schema.teamMembers)
      .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, "owner")));
    await db.insert(schema.teamMembers).values({ teamId, userId: "owner", role: "owner" });
    await expect(bridge(current.token)).rejects.toMatchObject({ code: "forbidden" });
    await expect(mint()).rejects.toMatchObject({ code: "forbidden" });
    await updateMailboxRegistry(db, owner(), {
      id: mailboxId,
      label: "Reauthorized",
      ownerUserId: "owner",
      status: "planned",
    });
    await expect(bridge(current.token)).rejects.toMatchObject({ code: "forbidden" });
    expect((await bridge((await mint()).token)).mailboxId).toBe(mailboxId);
  });

  it("preserves read and revocation after subscription expiry while blocking draft and send", async () => {
    const key = await mint({ scopes: ["read", "draft", "send"] });
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.teams.id, teamId));
    expect((await bridge(key.token)).mailboxId).toBe(mailboxId);
    for (const scope of ["draft", "send"] as const)
      await expect(bridge(key.token, scope)).rejects.toMatchObject({ code: "forbidden" });
    await expect(mint()).rejects.toMatchObject({ code: "forbidden" });
    await revokeMailboxAgentKey(db, owner(), { mailboxId, id: key.id });
    await db.update(schema.teams).set({ suspendedAt: null }).where(eq(schema.teams.id, teamId));
    const expired = await mint({ scopes: ["read", "draft", "send"] });
    await db
      .update(schema.mailboxSubscriptions)
      .set({
        periodStart: new Date(Date.now() - 172800000),
        periodEnd: new Date(Date.now() - 86400000),
      })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    expect((await bridge(expired.token)).mailboxId).toBe(mailboxId);
    for (const scope of ["draft", "send"] as const)
      await expect(bridge(expired.token, scope)).rejects.toMatchObject({ code: "not_entitled" });
    await revokeMailboxAgentKey(db, owner(), { mailboxId, id: expired.id });
    await expect(bridge(expired.token)).rejects.toMatchObject({ code: "forbidden" });
    const fresh = await mint();
    await db
      .update(schema.mailboxSubscriptions)
      .set({
        periodStart: new Date(Date.now() - 86400000),
        periodEnd: new Date(Date.now() + 86400000),
        seats: 0,
      })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    expect((await bridge(fresh.token)).mailboxId).toBe(mailboxId);
    await expect(bridge(fresh.token, "draft")).rejects.toMatchObject({ code: "not_entitled" });
  });

  it("rejects invalid consent metadata and does not create partial credentials", async () => {
    for (const input of [
      { label: "\r\n" },
      { label: "a".repeat(81) },
      { scopes: [] },
      { scopes: ["read", "read"] },
      { scopes: ["all"] },
      { expiresAt: new Date(0) },
      { expiresAt: new Date(Number.NaN) },
    ])
      await expect(mint(input as Parameters<typeof mint>[0])).rejects.toMatchObject({
        code: "invalid",
      });
    expect(
      await db.select({ id: schema.mailboxAgentKeys.id }).from(schema.mailboxAgentKeys),
    ).toHaveLength(0);
  });
});

describe("agent credential health", () => {
  it("stamps last use only after a successful call, and the listings carry it", async () => {
    const key = await mint();
    const unused = await mint({ label: "Unused" });
    expect((await listMailboxAgentKeys(db, owner(), mailboxId)).map((k) => k.lastUsedAt)).toEqual([
      null,
      null,
    ]);
    // A wrong secret for a real key id authenticates nothing and stamps nothing.
    const wrong = `${key.token.slice(0, key.token.indexOf(".") + 1)}${"A".repeat(43)}`;
    await expect(bridge(wrong)).rejects.toMatchObject({ code: "forbidden" });
    expect((await listMailboxAgentKeys(db, owner(), mailboxId)).every((k) => !k.lastUsedAt)).toBe(
      true,
    );
    await bridge(key.token);
    const listed = await listMailboxAgentKeys(db, owner(), mailboxId);
    expect(listed.find((k) => k.id === key.id)?.lastUsedAt).toBeInstanceOf(Date);
    expect(listed.find((k) => k.id === unused.id)?.lastUsedAt).toBeNull();
    expect(listed.find((k) => k.id === key.id)?.lastSentAt).toBeNull();
    // Within the resolution window a second call does not write again.
    const first = listed.find((k) => k.id === key.id)?.lastUsedAt;
    await bridge(key.token);
    expect(
      (await listMailboxAgentKeys(db, owner(), mailboxId)).find((k) => k.id === key.id)?.lastUsedAt,
    ).toEqual(first);

    const team = await createMailboxTeamAgentKey(db, owner(), {
      label: "Sage",
      mailboxIds: [mailboxId, personId],
    });
    expect((await listMailboxTeamAgentKeys(db, owner()))[0]?.lastUsedAt).toBeNull();
    await listMailboxAgentAccounts(db, team.token);
    expect((await listMailboxTeamAgentKeys(db, owner()))[0]?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("lists live credentials expiring within the window, one entry per credential", async () => {
    const day = 24 * 3600_000;
    const now = new Date(Date.now() + 2 * day);
    const soon = await mint({ label: "Soon", expiresAt: new Date(Date.now() + 4 * day) });
    await mint({ label: "Later", expiresAt: new Date(Date.now() + 30 * day) });
    await mint({ label: "Never" });
    const revoked = await mint({ label: "Revoked", expiresAt: new Date(Date.now() + 4 * day) });
    await revokeMailboxAgentKey(db, owner(), { mailboxId, id: revoked.id });
    const team = await createMailboxTeamAgentKey(db, owner(), {
      label: "Sage",
      mailboxIds: [mailboxId, personId],
      expiresAt: new Date(Date.now() + 6 * day),
    });
    const expiring = await listExpiringMailboxAgentCredentials(db, { now, within: 7 * day });
    expect(expiring.map((c) => [c.credentialId, c.label, c.addresses.sort()])).toEqual([
      [soon.id, "Soon", ["agent@local.invalid"]],
      [team.id, "Sage", ["agent@local.invalid", "person@local.invalid"]],
    ]);
    expect(expiring[0]).toMatchObject({
      teamId,
      ownerUserId: "owner",
      email: "owner@example.invalid",
    });
    // A key minted less than a day before the sweep is not "forgotten" yet.
    expect(
      await listExpiringMailboxAgentCredentials(db, { now: new Date(), within: 7 * day }),
    ).toEqual([]);
  });
});

describe("team agent credentials (mmt_)", () => {
  const teamMint = (input: Partial<Parameters<typeof createMailboxTeamAgentKey>[2]> = {}) =>
    createMailboxTeamAgentKey(db, owner(), {
      label: "Sage",
      mailboxIds: [mailboxId, personId],
      ...input,
    });
  const at = (token: string, mailbox: string | null, scope: "read" | "draft" = "read") =>
    withMailboxAgentAccess(
      db,
      token,
      scope,
      async (context) => ({ mailboxId: context.mailboxId, keyId: context.keyId }),
      parseMailboxSelector(mailbox),
    );

  it("covers several owned mailboxes with one secret, named by address or id, else the default", async () => {
    const team = await teamMint({ defaultMailboxId: mailboxId });
    expect(team.token).toMatch(/^mmt_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(team.mailboxes.map((box) => [box.address, box.isDefault]).sort()).toEqual([
      ["agent@local.invalid", true],
      ["person@local.invalid", false],
    ]);
    // One row per mailbox, each a full agent key with the same hash and its own id.
    const rows = await db
      .select()
      .from(schema.mailboxAgentKeys)
      .where(eq(schema.mailboxAgentKeys.groupId, team.id));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.keyHash)).size).toBe(1);
    expect(JSON.stringify(rows)).not.toContain(team.token);
    const person = await at(team.token, "PERSON@local.invalid");
    const agent = await at(team.token, mailboxId);
    expect(person.mailboxId).toBe(personId);
    expect(agent.mailboxId).toBe(mailboxId);
    expect(person.keyId).not.toBe(agent.keyId);
    expect((await at(team.token, null)).mailboxId).toBe(mailboxId);
    const accounts = await listMailboxAgentAccounts(db, team.token);
    expect(accounts.credential).toBe("team");
    expect(accounts.mailboxes.map((box) => [box.address, box.default, box.available])).toEqual([
      ["agent@local.invalid", true, true],
      ["person@local.invalid", false, true],
    ]);
    const listed = await listMailboxTeamAgentKeys(db, owner());
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: team.id, label: "Sage", revokedAt: null });
    expect(JSON.stringify(listed)).not.toContain(team.token);
  });

  it("isolates: no mailbox outside the credential, no fallback for a mismatched key, a mailbox to name without a default", async () => {
    const team = await teamMint({ mailboxIds: [personId] });
    const invoked = vi.fn(async () => true);
    for (const outside of [
      "agent@local.invalid",
      mailboxId,
      foreignMailboxId,
      "other@foreign.invalid",
    ])
      await expect(
        withMailboxAgentAccess(db, team.token, "read", invoked, parseMailboxSelector(outside)),
      ).rejects.toMatchObject({ code: "forbidden" });
    expect(invoked).not.toHaveBeenCalled();
    // A single mailbox needs no name.
    expect((await at(team.token, null)).mailboxId).toBe(personId);
    const both = await teamMint();
    await expect(at(both.token, null)).rejects.toMatchObject({ code: "mailbox_required" });
    // A forged secret learns nothing, not even that a mailbox is required.
    const forged = both.token.replace(/\.[^.]+$/, `.${"A".repeat(43)}`);
    await expect(at(forged, null)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listMailboxAgentAccounts(db, forged)).rejects.toMatchObject({ code: "forbidden" });
    // A single-mailbox key named for another mailbox is refused, not served from its own.
    const single = await mint();
    await expect(at(single.token, personId)).rejects.toMatchObject({ code: "forbidden" });
    expect((await at(single.token, "agent@local.invalid")).mailboxId).toBe(mailboxId);
    expect(() => parseMailboxSelector("not a mailbox")).toThrow();
  });

  it("only includes the minting owner's active mailboxes and keeps each mailbox's scope", async () => {
    await expect(teamMint({ mailboxIds: [mailboxId, foreignMailboxId] })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      createMailboxTeamAgentKey(
        db,
        { teamId, userId: "admin" },
        { label: "x", mailboxIds: [personId] },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(teamMint({ mailboxIds: [personId, personId] })).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(teamMint({ defaultMailboxId: foreignMailboxId })).rejects.toMatchObject({
      code: "invalid",
    });
    await updateMailboxRegistry(db, owner(), {
      id: mailboxId,
      label: "Agent",
      ownerUserId: "owner",
      status: "suspended",
    });
    await expect(teamMint()).rejects.toMatchObject({ code: "forbidden" });
    // Nothing partial was written.
    expect(
      await db.select({ id: schema.mailboxAgentKeys.id }).from(schema.mailboxAgentKeys),
    ).toHaveLength(0);
    const reader = await teamMint({ mailboxIds: [personId], scopes: ["read"] });
    await expect(at(reader.token, personId, "draft")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("revokes every mailbox at once, and a suspended mailbox leaves the others working", async () => {
    const team = await teamMint({ defaultMailboxId: personId });
    await updateMailboxRegistry(db, owner(), {
      id: mailboxId,
      label: "Agent",
      ownerUserId: "owner",
      status: "suspended",
    });
    await expect(at(team.token, mailboxId)).rejects.toMatchObject({ code: "forbidden" });
    expect((await at(team.token, personId)).mailboxId).toBe(personId);
    const accounts = await listMailboxAgentAccounts(db, team.token);
    expect(accounts.mailboxes.find((box) => box.id === mailboxId)?.available).toBe(false);
    await revokeMailboxTeamAgentKey(db, owner(), { id: team.id });
    for (const box of [mailboxId, personId, null])
      await expect(at(team.token, box)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listMailboxAgentAccounts(db, team.token)).rejects.toMatchObject({
      code: "forbidden",
    });
    const [listed] = await listMailboxTeamAgentKeys(db, owner());
    expect(listed?.revokedAt).not.toBeNull();
    await expect(
      revokeMailboxTeamAgentKey(db, { teamId, userId: "admin" }, { id: team.id }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
