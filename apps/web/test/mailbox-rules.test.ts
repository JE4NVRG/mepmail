import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createMailboxRegistry, EnvKeyring, type Keyring } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { simpleParser } from "mailparser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKeyring } from "@/server/keyring";
import { mailboxSenderHmacKey } from "@/server/mailbox-sender-key";
import { mailboxRulesRouter } from "@/server/routers/mailbox-rules";
import { type Context, createCallerFactory, createContext, router } from "@/server/trpc";
import {
  archiveMailboxFolder,
  createMailboxFolder,
} from "../../../packages/core/src/mailbox-organization";
import {
  grantMailboxRegistry,
  updateMailboxRegistry,
} from "../../../packages/core/src/mailbox-registry";
import {
  MAILBOX_RULES_MAX,
  mailboxRuleCandidates,
  normalizeMailboxRuleMatch,
} from "../../../packages/core/src/mailbox-rules";
import { decideMailboxSender } from "../../../packages/core/src/mailbox-senders";
import {
  type MailboxTransportMimeAdapter,
  receiveMailboxMime,
} from "../../../packages/core/src/mailbox-transport";
import { mailboxRules } from "../../../packages/db/src/schema/mailbox-rules";
import { seedMailboxTestService } from "./mailbox-service-fixture";

vi.mock("@/server/keyring", () => ({ getKeyring: vi.fn() }));
vi.mock("@/server/mailbox-sender-key", () => ({ mailboxSenderHmacKey: vi.fn() }));
vi.mock("@/server/trpc", async (original) => ({
  ...(await original<typeof import("@/server/trpc")>()),
  createContext: vi.fn(),
}));

let client: PGlite, db: Db, keys: Keyring, teamId: string, domainId: string;
let inbox: string, alerts: string, colleague: string;
const folder = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const caller = createCallerFactory(router({ rules: mailboxRulesRouter }));
const HMAC = randomBytes(32);
function ctx(userId = "owner"): Context {
  return {
    db,
    teamId,
    role: userId === "owner" ? "owner" : "member",
    session: { user: { id: userId, name: userId, email: `${userId}@example.invalid` } },
  };
}
const as = (userId = "owner") => caller(ctx(userId)).rules;
const owner = () => ({ teamId, userId: "owner" });
const mime: MailboxTransportMimeAdapter = {
  async parse(raw) {
    const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
    return {
      from: parsed.from?.value[0]?.address ?? "",
      to: [],
      cc: [],
      bcc: [],
      attachmentBytes: parsed.attachments.map((a) => a.content.length),
    };
  },
};
let sequence = 0;
async function deliver(from: string, to = "jean@rules.invalid", options: { key?: boolean } = {}) {
  sequence++;
  const raw = Buffer.from(
    `From: ${from}\r\nTo: ${to}\r\nSubject: Rule fixture ${sequence}\r\nMessage-ID: <rule-${sequence}@rules.invalid>\r\n\r\nbody ${sequence}\r\n`,
  );
  const result = await receiveMailboxMime(
    db,
    keys,
    {
      sourceId: `rules:${sequence}`,
      recipients: [to],
      raw,
      ...(options.key === false ? {} : { senderKey: HMAC }),
    },
    mime,
  );
  const [item] = await db
    .select()
    .from(schema.mailboxItems)
    .where(eq(schema.mailboxItems.id, result.items[0]!.id));
  return item!;
}

beforeEach(async () => {
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  client = new PGlite();
  for (const name of readdirSync(folder)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await client.transaction(async (tx) => {
      for (const statement of readFileSync(folder + name, "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => s.trim()))
        await tx.exec(statement);
    });
  const database = drizzle(client, { schema });
  db = database as unknown as Db;
  await migrate(database, { migrationsFolder: extension, migrationsTable: "__mailbox_migrations" });
  const [team] = await db.insert(schema.teams).values({ name: "Rules", slug: "rules" }).returning();
  teamId = team!.id;
  await seedMailboxTestService(db, [teamId]);
  for (const id of ["owner", "member"])
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.invalid`, emailVerified: true });
  await db.insert(schema.teamMembers).values([
    { teamId, userId: "owner", role: "owner" },
    { teamId, userId: "member", role: "member" },
  ]);
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "rules.invalid", region: "us-east-1", status: "verified" })
    .returning();
  domainId = domain!.id;
  const box = async (localPart: string, ownerUserId = "owner") =>
    (
      await createMailboxRegistry(db, owner(), {
        domainId,
        localPart,
        label: localPart,
        kind: "person",
        ownerUserId,
      })
    ).id;
  inbox = await box("jean");
  alerts = await box("alertas");
  colleague = await box("julia", "member");
  keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
  vi.mocked(getKeyring).mockReturnValue(keys);
  vi.mocked(mailboxSenderHmacKey).mockReturnValue(HMAC);
  vi.mocked(createContext).mockImplementation(async () => ctx());
});
afterEach(async () => {
  await client.close();
  vi.unstubAllEnvs();
});

describe("rule matches", () => {
  it("normalizes senders and domains and lists the matches most specific first", () => {
    expect(normalizeMailboxRuleMatch("sender", " Alerts@HealthChecks.IO ")).toBe(
      "alerts@healthchecks.io",
    );
    expect(normalizeMailboxRuleMatch("domain", "@Mail.Google.com.")).toBe("mail.google.com");
    expect(normalizeMailboxRuleMatch("domain", "exemplo.com.br")).toBe("exemplo.com.br");
    expect(normalizeMailboxRuleMatch("domain", "bücher.example")).toBe("xn--bcher-kva.example");
    for (const bad of ["com", "a..b", "-x.com", "x-.com", "has space.com", "a@b.com", ""])
      expect(normalizeMailboxRuleMatch("domain", bad)).toBeNull();
    expect(normalizeMailboxRuleMatch("sender", "not an address")).toBeNull();
    expect(mailboxRuleCandidates("noreply@mail.google.com")).toEqual([
      { kind: "sender", value: "noreply@mail.google.com" },
      { kind: "domain", value: "mail.google.com" },
      { kind: "domain", value: "google.com" },
    ]);
  });
});

describe("mailboxRules router", () => {
  it("keeps one rule per match, never the value in the clear, and lists them opened", async () => {
    const created = await as().save({
      mailboxId: inbox,
      match: { kind: "domain", value: " @HealthChecks.io " },
      archive: true,
      markRead: true,
    });
    expect(created).toMatchObject({
      match: { kind: "domain", value: "healthchecks.io" },
      archive: true,
      markRead: true,
      star: false,
      folderId: null,
      targetMailboxId: null,
      folderMissing: false,
      targetUnavailable: false,
    });
    // The same match again replaces the actions of the same rule.
    const again = await as().save({
      mailboxId: inbox,
      match: { kind: "domain", value: "healthchecks.io" },
      targetMailboxId: alerts,
    });
    expect(again.id).toBe(created.id);
    expect(again).toMatchObject({ archive: false, markRead: false, targetMailboxId: alerts });
    await as().save({
      mailboxId: inbox,
      match: { kind: "sender", value: "News@Medium.com" },
      star: true,
    });
    const rows = await db.select().from(mailboxRules);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Buffer.from(row.matchKey)).toHaveLength(32);
      const stored = `${Buffer.from(row.matchCiphertext).toString("latin1")}${Buffer.from(row.matchKey).toString("latin1")}`;
      expect(stored).not.toContain("healthchecks");
      expect(stored).not.toContain("medium");
    }
    expect((await as().list({ mailboxId: inbox })).map((rule) => rule.match)).toEqual([
      { kind: "sender", value: "news@medium.com" },
      { kind: "domain", value: "healthchecks.io" },
    ]);
    // An edit that takes another rule's match replaces that rule.
    const [newest] = await as().list({ mailboxId: inbox });
    const merged = await as().save({
      mailboxId: inbox,
      id: newest!.id,
      match: { kind: "domain", value: "healthchecks.io" },
      markRead: true,
    });
    expect(merged.id).toBe(created.id);
    expect(await db.select().from(mailboxRules)).toHaveLength(1);
    expect(await as().delete({ mailboxId: inbox, id: created.id })).toEqual({
      id: created.id,
      deleted: true,
    });
    expect(await as().delete({ mailboxId: inbox, id: created.id })).toEqual({
      id: created.id,
      deleted: false,
    });
    expect(await as().list({ mailboxId: inbox })).toEqual([]);
  });

  it("refuses other people, foreign folders and mailboxes, and rules that do nothing", async () => {
    const match = { kind: "sender" as const, value: "a@example.com" };
    await expect(as("member").save({ mailboxId: inbox, match, star: true })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await grantMailboxRegistry(db, owner(), {
      mailboxId: inbox,
      userId: "member",
      permission: "draft",
    });
    await expect(as("member").list({ mailboxId: inbox })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // Another person's mailbox is never a destination, nor the mailbox itself.
    await expect(
      as().save({ mailboxId: inbox, match, targetMailboxId: colleague }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      as().save({ mailboxId: inbox, match, targetMailboxId: inbox }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const otherFolder = await createMailboxFolder(db, owner(), {
      mailboxId: alerts,
      name: "Avisos",
    });
    await expect(
      as().save({ mailboxId: inbox, match, folderId: otherFolder.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(as().save({ mailboxId: inbox, match })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      as().save({ mailboxId: inbox, match, archive: true, targetMailboxId: alerts }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      as().save({ mailboxId: inbox, match: { kind: "domain", value: "com" }, star: true }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    vi.mocked(mailboxSenderHmacKey).mockReturnValue(null as never);
    await expect(as().save({ mailboxId: inbox, match, star: true })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("stops at the per-mailbox limit", async () => {
    const sealed = {
      ciphertext: randomBytes(32),
      iv: randomBytes(12),
      wrappedDek: randomBytes(40),
    };
    await db.insert(mailboxRules).values(
      Array.from({ length: MAILBOX_RULES_MAX }, () => ({
        teamId,
        mailboxId: inbox,
        matchKind: "sender" as const,
        matchKey: randomBytes(32),
        matchCiphertext: sealed.ciphertext,
        matchIv: sealed.iv,
        matchWrappedDek: sealed.wrappedDek,
        matchKeyVersion: 2000000,
        star: true,
        createdBy: "owner",
      })),
    );
    await expect(
      as().save({
        mailboxId: inbox,
        match: { kind: "sender", value: "b@example.com" },
        star: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("rules at receipt", () => {
  it("files mail in a folder, the Archive or read and starred, the exact sender first", async () => {
    const notices = await createMailboxFolder(db, owner(), { mailboxId: inbox, name: "Avisos" });
    await as().save({
      mailboxId: inbox,
      match: { kind: "domain", value: "google.com" },
      folderId: notices.id,
      markRead: true,
    });
    await as().save({
      mailboxId: inbox,
      match: { kind: "sender", value: "noreply-dmarc-support@google.com" },
      archive: true,
    });
    await as().save({
      mailboxId: inbox,
      match: { kind: "sender", value: "ana@example.com" },
      star: true,
    });

    const tls = await deliver("noreply-smtp-tls-reporting@mail.google.com");
    expect(tls).toMatchObject({ deliveryFolder: "inbox", folderId: notices.id, archivedAt: null });
    expect(tls.seenAt).not.toBeNull();
    const dmarc = await deliver("noreply-dmarc-support@google.com");
    expect(dmarc).toMatchObject({ folderId: null, seenAt: null });
    expect(dmarc.archivedAt).not.toBeNull();
    const ana = await deliver("Ana@Example.com");
    expect(ana).toMatchObject({ folderId: null, archivedAt: null, seenAt: null });
    expect(ana.starredAt).not.toBeNull();
    const other = await deliver("someone@else.example");
    expect(other).toMatchObject({
      folderId: null,
      archivedAt: null,
      seenAt: null,
      starredAt: null,
    });
    // Without the sender key no rule applies.
    expect(await deliver("x@google.com", undefined, { key: false })).toMatchObject({
      folderId: null,
      seenAt: null,
    });
    // An archived folder stops receiving; the message stays in the inbox, still read.
    await archiveMailboxFolder(db, owner(), {
      mailboxId: inbox,
      id: notices.id,
      expectedRevision: notices.revision,
    });
    const later = await deliver("y@google.com");
    expect(later).toMatchObject({ folderId: null, archivedAt: null });
    expect(later.seenAt).not.toBeNull();
    expect((await as().list({ mailboxId: inbox })).find((r) => r.folderId)?.folderMissing).toBe(
      true,
    );
  });

  it("delivers into another mailbox of the same owner, never across owners or for Spam", async () => {
    await as().save({
      mailboxId: inbox,
      match: { kind: "domain", value: "healthchecks.io" },
      targetMailboxId: alerts,
      markRead: true,
    });
    const moved = await deliver("alerts@healthchecks.io");
    expect(moved.mailboxId).toBe(alerts);
    expect(moved.seenAt).not.toBeNull();
    expect(
      await db.select().from(schema.mailboxItems).where(eq(schema.mailboxItems.mailboxId, inbox)),
    ).toHaveLength(0);
    // The target's own rule files it there; no second hop.
    const folderThere = await createMailboxFolder(db, owner(), {
      mailboxId: alerts,
      name: "Uptime",
    });
    await as().save({
      mailboxId: alerts,
      match: { kind: "domain", value: "healthchecks.io" },
      folderId: folderThere.id,
    });
    expect(await deliver("alerts@healthchecks.io")).toMatchObject({
      mailboxId: alerts,
      folderId: folderThere.id,
    });
    // A sender the owner blocked in the addressed mailbox stays in its Spam.
    await decideMailboxSender(db, keys, HMAC, owner(), {
      mailboxId: inbox,
      address: "spam@healthchecks.io",
      decision: "block",
    });
    expect(await deliver("spam@healthchecks.io")).toMatchObject({
      mailboxId: inbox,
      deliveryFolder: "spam",
      seenAt: null,
    });
    // After the target changes owner, mail stays where it was addressed.
    await updateMailboxRegistry(db, owner(), {
      id: alerts,
      label: "alertas",
      ownerUserId: "member",
      status: "planned",
    });
    expect((await as().list({ mailboxId: inbox }))[0]?.targetUnavailable).toBe(true);
    const kept = await deliver("alerts@healthchecks.io");
    expect(kept.mailboxId).toBe(inbox);
    expect(kept.seenAt).not.toBeNull();
  });
});
