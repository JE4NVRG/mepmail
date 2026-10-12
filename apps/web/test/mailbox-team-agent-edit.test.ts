import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { simpleParser } from "mailparser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvKeyring } from "../../../packages/core/src/crypto/keyring.js";
import { saveMailboxDraft } from "../../../packages/core/src/mailbox-private-store.js";
import { createMailboxRegistry } from "../../../packages/core/src/mailbox-registry.js";
import {
  type MailboxTransportMimeAdapter,
  queueMailboxAgentDraft,
  sendMailboxOutbox,
} from "../../../packages/core/src/mailbox-transport.js";
import { seedMailboxTestService } from "./mailbox-service-fixture";

// Real database (PGlite), real routers and real public agent routes: only the process
// singletons (db, keyring, request context) point at the test fixtures.
const h = vi.hoisted(() => ({ db: null as unknown, keys: null as unknown }));
vi.mock("@millionsend/db", async (original) => ({
  ...(await original<typeof import("@millionsend/db")>()),
  getDb: () => h.db,
}));
vi.mock("@/server/keyring", () => ({ getKeyring: () => h.keys }));
vi.mock("@/server/trpc", async (original) => ({
  ...(await original<typeof import("@/server/trpc")>()),
  createContext: vi.fn(),
}));

const { mailboxesRouter } = await import("@/server/routers/mailboxes");
const { createCallerFactory, router } = await import("@/server/trpc");
const { GET: accountsGet } = await import("@/app/api/mailbox-agent/mailboxes/route");
const { GET: itemsGet } = await import("@/app/api/mailbox-agent/items/route");
type Context = import("@/server/trpc").Context;

const base = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const mail = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
let client: PGlite, db: Db, teamId: string, foreignTeamId: string;
let boxA: string, boxB: string, boxC: string, colleagueBox: string, foreignBox: string;
const caller = createCallerFactory(router({ mailboxes: mailboxesRouter }));
function ctx(userId = "owner", team = () => teamId): Context {
  return {
    db,
    teamId: team(),
    role: userId === "member" ? "member" : "owner",
    session: { user: { id: userId, name: userId, email: `${userId}@example.invalid` } },
  };
}
const as = (userId = "owner", team?: () => string) => caller(ctx(userId, team)).mailboxes;
const mime: MailboxTransportMimeAdapter = {
  async parse(raw) {
    const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
    const list = (v: typeof parsed.to) =>
      (Array.isArray(v) ? v : v ? [v] : [])
        .flatMap((entry) => entry.value)
        .map((entry) => entry.address!)
        .filter(Boolean);
    return {
      from: parsed.from?.value[0]?.address ?? "",
      to: list(parsed.to),
      cc: [],
      bcc: [],
      attachmentBytes: parsed.attachments.map((a) => a.content.length),
    };
  },
};

/** The public agent API, exactly as an MCP client calls it. */
async function accounts(token: string) {
  const response = await accountsGet(
    new Request("http://localhost/api/mailbox-agent/mailboxes", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
async function list(token: string, mailbox: string) {
  const response = await itemsGet(
    new Request("http://localhost/api/mailbox-agent/items?folder=inbox", {
      headers: { authorization: `Bearer ${token}`, "mepmail-mailbox": mailbox },
    }),
  );
  return response.status;
}
const addresses = (body: Record<string, unknown>) =>
  ((body.mailboxes ?? []) as { address: string; default: boolean; scopes: string[] }[]).map(
    (box) => `${box.address}${box.default ? "*" : ""}:${[...box.scopes].sort().join("+")}`,
  );
async function current(id: string, userId = "owner") {
  const listed = await as(userId).teamAgentKeys();
  return listed.find((key) => key.id === id)!;
}

beforeEach(async () => {
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  client = new PGlite();
  for (const name of readdirSync(base)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await client.transaction(async (tx) => {
      for (const statement of readFileSync(base + name, "utf8")
        .split("--> statement-breakpoint")
        .filter((part) => part.trim()))
        await tx.exec(statement);
    });
  const database = drizzle(client, { schema });
  db = database as unknown as Db;
  h.db = db;
  await migrate(database, { migrationsFolder: mail, migrationsTable: "__mailbox_migrations" });
  const teams = await db
    .insert(schema.teams)
    .values([
      { name: "Agents", slug: "agents-edit" },
      { name: "Other", slug: "other-edit" },
    ])
    .returning();
  teamId = teams[0]!.id;
  foreignTeamId = teams[1]!.id;
  await seedMailboxTestService(db, [teamId, foreignTeamId]);
  for (const id of ["owner", "member", "foreign"])
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.invalid`, emailVerified: true });
  await db.insert(schema.teamMembers).values([
    { teamId, userId: "owner", role: "owner" },
    { teamId, userId: "member", role: "member" },
    { teamId: foreignTeamId, userId: "foreign", role: "owner" },
  ]);
  const domains = await db
    .insert(schema.domains)
    .values([
      { teamId, name: "edit.invalid", region: "us-east-1", status: "verified" },
      { teamId: foreignTeamId, name: "foreign-edit.invalid", region: "us-east-1" },
    ])
    .returning();
  const box = async (team: string, userId: string, domainId: string, localPart: string) =>
    (
      await createMailboxRegistry(
        db,
        { teamId: team, userId: team === teamId ? "owner" : userId },
        { domainId, localPart, label: localPart, kind: "person", ownerUserId: userId },
      )
    ).id;
  boxA = await box(teamId, "owner", domains[0]!.id, "a");
  boxB = await box(teamId, "owner", domains[0]!.id, "b");
  boxC = await box(teamId, "owner", domains[0]!.id, "c");
  colleagueBox = await box(teamId, "member", domains[0]!.id, "colleague");
  foreignBox = await box(foreignTeamId, "foreign", domains[1]!.id, "foreign");
  h.keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
});
afterEach(async () => {
  await client.close();
  vi.unstubAllEnvs();
});

describe("editing a team agent credential in place", () => {
  it("keeps the same secret while adding and removing mailboxes, scopes and the default", async () => {
    const minted = await as().createTeamAgentKey({
      label: "Sage",
      mailboxIds: [boxA, boxB],
      scopes: ["read", "draft"],
      defaultMailboxId: boxB,
    });
    const token = minted.token;
    // Another agent's credential must come out of every edit untouched.
    const other = await as().createTeamAgentKey({ label: "Leo", mailboxIds: [boxA, boxB] });
    const otherRows = async () =>
      db
        .select()
        .from(schema.mailboxAgentKeys)
        .where(eq(schema.mailboxAgentKeys.groupId, other.id));
    const otherBefore = JSON.stringify(await otherRows());

    expect(addresses((await accounts(token)).body)).toEqual([
      "a@edit.invalid:draft+read",
      "b@edit.invalid*:draft+read",
    ]);
    expect(await list(token, "c@edit.invalid")).toBe(403);

    const before = await current(minted.id);
    const edited = await as().updateTeamAgentKey({
      id: minted.id,
      expectedVersion: before.version,
      label: "Sage (todas)",
      mailboxIds: [boxA, boxC],
      scopes: ["read", "draft", "send"],
      defaultMailboxId: boxC,
    });
    expect(edited).toMatchObject({
      id: minted.id,
      label: "Sage (todas)",
      scopes: ["read", "draft", "send"],
      defaultMailboxId: boxC,
      change: {
        added: [boxC],
        removed: [boxB],
        label: true,
        scopes: { before: ["read", "draft"], after: ["read", "draft", "send"] },
        defaultMailboxId: { before: boxB, after: boxC },
        expiresAt: null,
      },
    });
    expect(JSON.stringify(edited)).not.toContain(token);
    expect(edited).not.toHaveProperty("token");

    // Same bearer, new access: C opens, B is closed, A keeps working with send now.
    expect(addresses((await accounts(token)).body)).toEqual([
      "a@edit.invalid:draft+read+send",
      "c@edit.invalid*:draft+read+send",
    ]);
    expect(await list(token, "c@edit.invalid")).toBe(200);
    expect(await list(token, "a@edit.invalid")).toBe(200);
    expect(await list(token, "b@edit.invalid")).toBe(403);

    // Re-adding a mailbox it held reuses that mailbox's row; still one secret.
    const again = await as().updateTeamAgentKey({
      id: minted.id,
      expectedVersion: edited.version,
      mailboxIds: [boxA, boxB, boxC],
    });
    expect(again.change.added).toEqual([boxB]);
    expect(await list(token, "b@edit.invalid")).toBe(200);
    const rows = await db
      .select()
      .from(schema.mailboxAgentKeys)
      .where(eq(schema.mailboxAgentKeys.groupId, minted.id));
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.keyHash)).size).toBe(1);

    expect(JSON.stringify(await otherRows())).toBe(otherBefore);

    // Audited with the actor and the change, never the secret.
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "mailbox.team_agent_key_updated"));
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ target: `mailbox_team_agent_key:${minted.id}` });
    expect(JSON.stringify(audit)).toContain(boxC);
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(JSON.stringify(audit)).not.toContain(minted.token.split(".")[1]!);
  });

  it("clears a default whose mailbox is removed and refuses a default outside the set", async () => {
    const minted = await as().createTeamAgentKey({
      label: "Sage",
      mailboxIds: [boxA, boxB],
      defaultMailboxId: boxB,
    });
    const v = (await current(minted.id)).version;
    await expect(
      as().updateTeamAgentKey({ id: minted.id, expectedVersion: v, defaultMailboxId: boxC }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const edited = await as().updateTeamAgentKey({
      id: minted.id,
      expectedVersion: v,
      mailboxIds: [boxA],
    });
    expect(edited.defaultMailboxId).toBeNull();
    expect(edited.change.defaultMailboxId).toEqual({ before: boxB, after: null });
    const defaults = await db
      .select()
      .from(schema.mailboxAgentKeys)
      .where(
        and(
          eq(schema.mailboxAgentKeys.groupId, minted.id),
          eq(schema.mailboxAgentKeys.isDefault, true),
        ),
      );
    expect(defaults).toHaveLength(0);
    // Without a default, a call that names no mailbox must name one (one live mailbox left).
    expect(addresses((await accounts(minted.token)).body)).toEqual(["a@edit.invalid:draft+read"]);
    // Expiry edits apply to every live row; a past date is refused.
    const v2 = (await current(minted.id)).version;
    const later = new Date(Date.now() + 7 * 86400000);
    const expiring = await as().updateTeamAgentKey({
      id: minted.id,
      expectedVersion: v2,
      expiresAt: later,
    });
    expect(expiring.change.expiresAt).toEqual({ before: null, after: later.toISOString() });
    await expect(
      as().updateTeamAgentKey({
        id: minted.id,
        expectedVersion: expiring.version,
        expiresAt: new Date(Date.now() - 1000),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("lists the live name, scopes and expiry even when a removed mailbox sorts first", async () => {
    const minted = await as().createTeamAgentKey({
      label: "Antigo",
      mailboxIds: [boxA, boxC],
      scopes: ["read"],
    });
    const later = new Date(Date.now() + 3 * 86400000);
    await as().updateTeamAgentKey({
      id: minted.id,
      expectedVersion: (await current(minted.id)).version,
      label: "Novo",
      mailboxIds: [boxC],
      scopes: ["read", "draft"],
      expiresAt: later,
    });
    // a@ (revoked, with the old values) comes first by address in the listing.
    const listed = await current(minted.id);
    expect(listed).toMatchObject({ label: "Novo", scopes: ["read", "draft"], revokedAt: null });
    expect(listed.expiresAt?.toISOString()).toBe(later.toISOString());
    expect(listed.mailboxes.map((box) => [box.address, box.revoked])).toEqual([
      ["a@edit.invalid", true],
      ["c@edit.invalid", false],
    ]);
  });

  it("refuses stale and concurrent revisions: exactly one of two edits from the same version wins", async () => {
    const minted = await as().createTeamAgentKey({ label: "Sage", mailboxIds: [boxA] });
    const v = (await current(minted.id)).version;
    const results = await Promise.allSettled([
      as().updateTeamAgentKey({ id: minted.id, expectedVersion: v, mailboxIds: [boxA, boxB] }),
      as().updateTeamAgentKey({ id: minted.id, expectedVersion: v, mailboxIds: [boxA, boxC] }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: "CONFLICT" });
    // The loser's version is stale for good.
    await expect(
      as().updateTeamAgentKey({ id: minted.id, expectedVersion: v, label: "late" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(
      (
        await db
          .select()
          .from(schema.mailboxAgentKeys)
          .where(eq(schema.mailboxAgentKeys.groupId, minted.id))
      ).length,
    ).toBe(2);
  });

  it("lets no one else edit or widen the grant: other people, other teams, other owners' mailboxes", async () => {
    const minted = await as().createTeamAgentKey({ label: "Sage", mailboxIds: [boxA] });
    const v = (await current(minted.id)).version;
    // Another member of the team does not see or edit it.
    await expect(
      as("member").updateTeamAgentKey({
        id: minted.id,
        expectedVersion: v,
        mailboxIds: [colleagueBox],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Another team never reaches it, even naming the id.
    await expect(
      as("foreign", () => foreignTeamId).updateTeamAgentKey({
        id: minted.id,
        expectedVersion: v,
        mailboxIds: [foreignBox],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // The owner cannot add a colleague's mailbox or another team's.
    for (const outside of [colleagueBox, foreignBox])
      await expect(
        as().updateTeamAgentKey({ id: minted.id, expectedVersion: v, mailboxIds: [boxA, outside] }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Nothing changed after the refusals.
    expect((await current(minted.id)).version).toBe(v);
    expect(addresses((await accounts(minted.token)).body)).toEqual(["a@edit.invalid:draft+read"]);
    // A revoked credential is not edited back to life.
    await as().revokeTeamAgentKey({ id: minted.id });
    await expect(
      as().updateTeamAgentKey({ id: minted.id, expectedVersion: v, mailboxIds: [boxA] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await accounts(minted.token)).status).toBe(403);
  });

  it("fails a send it already queued once send or the mailbox is taken away, before the provider", async () => {
    const minted = await as().createTeamAgentKey({
      label: "Sage",
      mailboxIds: [boxA, boxB],
      scopes: ["read", "draft", "send"],
    });
    const keys = h.keys as EnvKeyring;
    const queue = async (mailbox: string) => {
      const draft = await saveMailboxDraft(
        db,
        keys,
        { teamId, userId: "owner" },
        {
          mailboxId: mailbox,
          expectedRevision: 0,
          raw: Buffer.from(
            `From: ${mailbox === boxA ? "a" : "b"}@edit.invalid\r\nTo: someone@example.invalid\r\nSubject: queued\r\n\r\nbody`,
          ),
        },
      );
      return queueMailboxAgentDraft(
        db,
        keys,
        minted.token,
        { id: draft.id, expectedRevision: 1 },
        mime,
        undefined,
        { address: `${mailbox === boxA ? "a" : "b"}@edit.invalid` },
      );
    };
    const viaA = await queue(boxA);
    const viaB = await queue(boxB);
    const v = (await current(minted.id)).version;
    // Send goes away for the credential, and mailbox B leaves it.
    await as().updateTeamAgentKey({
      id: minted.id,
      expectedVersion: v,
      mailboxIds: [boxA],
      scopes: ["read", "draft"],
    });
    const provider = vi.fn(async () => ({ messageId: "must-not-send" }));
    for (const queued of [viaA, viaB])
      expect(await sendMailboxOutbox(db, keys, queued.id, { send: provider }, mime)).toMatchObject({
        status: "failed",
        errorCode: "agent_authorization_refused",
      });
    expect(provider).not.toHaveBeenCalled();
  });
});
