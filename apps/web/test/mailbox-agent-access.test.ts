import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMailboxAgentKey,
  listMailboxAgentKeys,
  revokeMailboxAgentKey,
  withMailboxAgentAccess,
} from "../../../packages/core/src/mailbox-agent-access.js";
import { EnvKeyring } from "../../../packages/core/src/crypto/keyring.js";
import {
  listMailboxItems,
  readMailboxItem,
  saveMailboxDraft,
} from "../../../packages/core/src/mailbox-private-store.js";
import {
  createMailboxRegistry,
  grantMailboxRegistry,
  updateMailboxRegistry,
} from "../../../packages/core/src/mailbox-registry.js";
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
  // Mailbox migrations remain independent from the production Send migration journal.
  for (const folder of [base, mail]) {
    const files = readdirSync(folder)
      .filter((name) => name.endsWith(".sql") && (folder === mail || name.slice(0, 4) <= "0042"))
      .sort();
    for (const name of files)
      for (const statement of readFileSync(folder + name, "utf8")
        .split("--> statement-breakpoint")
        .filter((part) => part.trim()))
        await client.exec(statement);
  }
  db = drizzle(client, { schema }) as unknown as Db;
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
    ]);
    expect(first).not.toHaveProperty("keyHash");
    expect(await bridge(first.token)).toEqual({ actor: owner(), mailboxId });
    expect(
      await withMailboxAgentAccess(db, first.token, "read", async (context) => ({
        keyId: context.keyId,
        ownerMembershipId: context.ownerMembershipId,
        expiresAt: context.expiresAt,
      })),
    ).toEqual({ keyId: first.id, ownerMembershipId: stored!.ownerMembershipId, expiresAt: null });
    expect(await bridge(second.token)).toEqual({ actor: owner(), mailboxId: personId });
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
    expect((await bridge(current.token)).actor).toEqual({ teamId, userId: "delegate" });
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
