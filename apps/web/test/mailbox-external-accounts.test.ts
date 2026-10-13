import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { simpleParser } from "mailparser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvKeyring, type Keyring } from "../../../packages/core/src/crypto/keyring.js";
import {
  createMailboxExternalAccount,
  MailboxExternalError,
  mailboxExternalSourceId,
  openMailboxExternalAccount,
  receiveExternalMailboxMime,
} from "../../../packages/core/src/mailbox-external-accounts.js";
import { saveMailboxDraft } from "../../../packages/core/src/mailbox-private-store.js";
import {
  createMailboxRegistry,
  listMailboxRegistry,
} from "../../../packages/core/src/mailbox-registry.js";
import {
  decideMailboxSender,
  deriveMailboxSenderKey,
} from "../../../packages/core/src/mailbox-senders.js";
import {
  MailboxServiceError,
  mailboxServiceState,
} from "../../../packages/core/src/mailbox-service.js";
import {
  type MailboxOutboxSender,
  type MailboxTransportMimeAdapter,
  queueMailboxDraft,
  sendMailboxOutbox,
} from "../../../packages/core/src/mailbox-transport.js";
import { mailboxOutbox } from "../../../packages/db/src/schema/mailbox-transport.js";

let client: PGlite, db: Db, keys: Keyring;
let paidTeam: string, freeTeam: string, paidDomain: string;
const base = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const senderKey = deriveMailboxSenderKey(Buffer.alloc(32, 5));
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
      cc: list(parsed.cc),
      bcc: list(parsed.bcc),
      attachmentBytes: parsed.attachments.map((a) => a.content.length),
    };
  },
};
const message = (from: string, to: string, subject = "Hello") =>
  Buffer.from(
    `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replace(/\W/g, "")}@external.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nbody of ${subject}\r\n`,
  );
const servers = {
  provider: "gmail" as const,
  imapHost: "imap.gmail.com",
  smtpHost: "smtp.gmail.com",
  smtpPort: 465 as const,
  smtpSecurity: "tls" as const,
  username: "ana@gmail.com",
};
const connect = (teamId: string, userId: string, address = "ana@gmail.com") =>
  createMailboxExternalAccount(
    db,
    keys,
    { teamId, userId },
    {
      address,
      label: address,
      servers: { ...servers, username: address },
      secret: "abcd efgh ijkl mnop",
    },
  );

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

beforeEach(async () => {
  client = new PGlite();
  for (const name of readdirSync(base)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await client.transaction(async (tx) => {
      for (const statement of readFileSync(base + name, "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => s.trim()))
        await tx.exec(statement);
    });
  const database = drizzle(client, { schema: { ...schema, mailboxOutbox } });
  db = database as unknown as Db;
  await migrate(database, { migrationsFolder: extension, migrationsTable: "__mailbox_migrations" });
  keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
  const teams = await db
    .insert(schema.teams)
    .values([
      { name: "Paid", slug: "external-paid" },
      { name: "Free", slug: "external-free" },
    ])
    .returning();
  paidTeam = teams[0]!.id;
  freeTeam = teams[1]!.id;
  for (const id of ["owner", "admin", "member", "free"])
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.invalid`, emailVerified: true });
  await db.insert(schema.teamMembers).values([
    { teamId: paidTeam, userId: "owner", role: "owner" },
    { teamId: paidTeam, userId: "admin", role: "admin" },
    { teamId: paidTeam, userId: "member", role: "member" },
    { teamId: freeTeam, userId: "free", role: "owner" },
  ]);
  const now = Date.now();
  // One seat only: the external account must never need or take it.
  await db.insert(schema.mailboxSubscriptions).values({
    teamId: paidTeam,
    status: "active" as const,
    seats: 1,
    storageBytesPerMailbox: 8 * 1024 * 1024,
    includedOutboundPerMailbox: 10,
    periodStart: new Date(now - 86400000),
    periodEnd: new Date(now + 86400000),
  });
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId: paidTeam, name: "paid.invalid", status: "verified", region: "us-east-1" })
    .returning();
  paidDomain = domain!.id;
});

describe("Contas externas: free accounts", () => {
  it("connects without any Correio plan, owned and private to the person", async () => {
    const { mailboxId } = await connect(freeTeam, "free");
    const registry = await listMailboxRegistry(db, { teamId: freeTeam, userId: "free" });
    expect(registry.mailboxes).toEqual([
      expect.objectContaining({
        id: mailboxId,
        origin: "external",
        domainId: null,
        address: "ana@gmail.com",
        canRead: true,
        canDraft: true,
        canSend: true,
      }),
    ]);
  });

  it("never takes or counts as a seat: domain mailboxes keep exactly their plan", async () => {
    await createMailboxRegistry(
      db,
      { teamId: paidTeam, userId: "owner" },
      {
        domainId: paidDomain,
        localPart: "jean",
        label: "Jean",
        kind: "person",
        ownerUserId: "owner",
      },
    );
    const before = await mailboxServiceState(db, paidTeam);
    await connect(paidTeam, "owner");
    const after = await mailboxServiceState(db, paidTeam);
    expect(after).toEqual(before);
    // The only seat is still the domain mailbox's: a second Correio address is refused.
    await expect(
      createMailboxRegistry(
        db,
        { teamId: paidTeam, userId: "owner" },
        {
          domainId: paidDomain,
          localPart: "second",
          label: "Second",
          kind: "person",
          ownerUserId: "owner",
        },
      ),
    ).rejects.toMatchObject({ code: "quota" });
  });

  it("is not listed to team admins, only to its owner", async () => {
    await connect(paidTeam, "member", "member@icloud.com");
    const admin = await listMailboxRegistry(db, { teamId: paidTeam, userId: "admin" });
    expect(admin.mailboxes.map((box) => box.address)).not.toContain("member@icloud.com");
    const member = await listMailboxRegistry(db, { teamId: paidTeam, userId: "member" });
    expect(member.mailboxes.map((box) => box.address)).toContain("member@icloud.com");
  });

  it("keeps the per-person and per-team limits, and refuses an address that is a Correio mailbox", async () => {
    process.env.MAILBOX_EXTERNAL_MAX_PER_USER = "1";
    await connect(freeTeam, "free", "one@gmail.com");
    await expect(connect(freeTeam, "free", "two@gmail.com")).rejects.toMatchObject({
      code: "limit",
    });
    process.env.MAILBOX_EXTERNAL_MAX_PER_USER = "5";
    process.env.MAILBOX_EXTERNAL_MAX_PER_TEAM = "1";
    await expect(connect(freeTeam, "free", "three@gmail.com")).rejects.toMatchObject({
      code: "limit",
    });
    process.env.MAILBOX_EXTERNAL_MAX_PER_TEAM = "25";
    await createMailboxRegistry(
      db,
      { teamId: paidTeam, userId: "owner" },
      {
        domainId: paidDomain,
        localPart: "taken",
        label: "Taken",
        kind: "person",
        ownerUserId: "owner",
      },
    );
    await expect(connect(freeTeam, "free", "taken@paid.invalid")).rejects.toBeInstanceOf(
      MailboxExternalError,
    );
  });

  it("seals the app password and opens it only for the worker", async () => {
    const { mailboxId } = await connect(freeTeam, "free");
    const [row] = await db
      .select()
      .from(schema.mailboxExternalAccounts)
      .where(eq(schema.mailboxExternalAccounts.mailboxId, mailboxId));
    expect(row!.secretCiphertext.toString("utf8")).not.toContain("abcd");
    const opened = await openMailboxExternalAccount(db, keys, mailboxId);
    expect(opened?.secret).toBe("abcd efgh ijkl mnop");
  });
});

describe("Contas externas: mail from the provider", () => {
  it("stores each provider message once, read state and blocked senders applied", async () => {
    const { mailboxId } = await connect(freeTeam, "free");
    const sourceId = mailboxExternalSourceId(mailboxId, 7, 42);
    const raw = message("news@shop.example", "ana@gmail.com", "First");
    const first = await receiveExternalMailboxMime(db, keys, {
      mailboxId,
      sourceId,
      raw,
      receivedAt: new Date(),
      seen: true,
      from: "news@shop.example",
      senderKey,
    });
    expect(first.duplicate).toBe(false);
    const again = await receiveExternalMailboxMime(db, keys, {
      mailboxId,
      sourceId,
      raw,
      receivedAt: new Date(),
      seen: true,
      from: "news@shop.example",
      senderKey,
    });
    expect(again).toEqual({ id: first.id, duplicate: true });
    const [item] = await db
      .select()
      .from(schema.mailboxItems)
      .where(eq(schema.mailboxItems.id, first.id));
    expect(item).toMatchObject({ kind: "inbox", deliveryFolder: "inbox" });
    expect(item!.seenAt).not.toBeNull();
    expect(item!.sourceId!.startsWith("ext:")).toBe(true);

    await decideMailboxSender(
      db,
      keys,
      senderKey,
      { teamId: freeTeam, userId: "free" },
      {
        mailboxId,
        address: "spam@bad.example",
        decision: "block",
      },
    );
    const blocked = await receiveExternalMailboxMime(db, keys, {
      mailboxId,
      sourceId: mailboxExternalSourceId(mailboxId, 7, 43),
      raw: message("spam@bad.example", "ana@gmail.com", "Blocked"),
      receivedAt: new Date(),
      seen: false,
      from: "spam@bad.example",
      senderKey,
    });
    const [spam] = await db
      .select()
      .from(schema.mailboxItems)
      .where(eq(schema.mailboxItems.id, blocked.id));
    expect(spam!.deliveryFolder).toBe("spam");
  });

  it("stops at the account's own storage cap", async () => {
    const { mailboxId } = await connect(freeTeam, "free");
    process.env.MAILBOX_EXTERNAL_STORAGE_BYTES = "100";
    await expect(
      receiveExternalMailboxMime(db, keys, {
        mailboxId,
        sourceId: mailboxExternalSourceId(mailboxId, 1, 1),
        raw: message("a@shop.example", "ana@gmail.com", "Too big for a hundred bytes"),
        receivedAt: new Date(),
        seen: false,
        from: "a@shop.example",
      }),
    ).rejects.toMatchObject({ code: "external_storage" });
  });
});

describe("Contas externas: sending through the person's own provider", () => {
  it("sends without a plan, files it under the calendar month, and keeps a send rate", async () => {
    const { mailboxId } = await connect(freeTeam, "free");
    const actor = { teamId: freeTeam, userId: "free" };
    const draft = await saveMailboxDraft(db, keys, actor, {
      mailboxId,
      expectedRevision: 0,
      raw: message("ana@gmail.com", "maya@brightloop.example", "Reply"),
    });
    const queued = await queueMailboxDraft(
      db,
      keys,
      actor,
      { mailboxId, id: draft.id, expectedRevision: draft.revision },
      mime,
    );
    const [row] = await db.select().from(mailboxOutbox).where(eq(mailboxOutbox.id, queued.id));
    const now = new Date();
    expect(row!.periodStart.toISOString()).toBe(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    );
    const sent: string[] = [];
    const sender: MailboxOutboxSender = {
      async send(input) {
        sent.push(input.from);
        return { messageId: "provider-id" };
      },
    };
    const result = await sendMailboxOutbox(db, keys, queued.id, sender, mime);
    expect(result.status).toBe("accepted");
    expect(sent).toEqual(["ana@gmail.com"]);

    process.env.MAILBOX_EXTERNAL_RECIPIENTS_PER_HOUR = "1";
    const second = await saveMailboxDraft(db, keys, actor, {
      mailboxId,
      expectedRevision: 0,
      raw: message("ana@gmail.com", "other@brightloop.example", "Second"),
    });
    await expect(
      queueMailboxDraft(
        db,
        keys,
        actor,
        { mailboxId, id: second.id, expectedRevision: second.revision },
        mime,
      ),
    ).rejects.toBeInstanceOf(MailboxServiceError);
  });
});
