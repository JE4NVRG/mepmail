import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { simpleParser } from "mailparser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvKeyring, type Keyring } from "../../../packages/core/src/crypto/keyring.js";
import {
  createMailboxAgentKey,
  revokeMailboxAgentKey,
} from "../../../packages/core/src/mailbox-agent-access.js";
import { assessMailboxReceipt } from "../../../packages/core/src/mailbox-inbound-safety.js";
import {
  countMailboxThreads,
  listMailboxThread,
  readMailboxItem,
  saveMailboxDraft,
  setMailboxDeliveryFolder,
  setMailboxItemTrash,
} from "../../../packages/core/src/mailbox-private-store.js";
import {
  createMailboxRegistry,
  grantMailboxRegistry,
  updateMailboxRegistry,
} from "../../../packages/core/src/mailbox-registry.js";
import { mailboxIdKey } from "../../../packages/core/src/mailbox-thread.js";
import {
  acceptMailboxOutbox,
  failQueuedMailboxOutbox,
  type MailboxOutboxSender,
  MailboxSendDeferredError,
  MailboxSendRejectedError,
  type MailboxTransportMimeAdapter,
  queueMailboxAgentDraft,
  queueMailboxDraft,
  receiveMailboxMime,
  reconcileMailboxOutbox,
  sendMailboxOutbox,
} from "../../../packages/core/src/mailbox-transport.js";
import { mailboxOutbox } from "../../../packages/db/src/schema/mailbox-transport.js";

let client: PGlite,
  db: Db,
  teamId: string,
  foreignTeamId: string,
  mailboxId: string,
  agentId: string,
  foreignId: string,
  keys: Keyring;
const base = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const owner = () => ({ teamId, userId: "owner" });
const delegate = () => ({ teamId, userId: "delegate" });
const mimeAdapter: MailboxTransportMimeAdapter = {
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
function fixture(
  from = "person@transport.invalid",
  to = "recipient@example.invalid",
  body = "private original body",
) {
  return Buffer.from(
    `From: ${from}\r\nTo: ${to}\r\nSubject: Private attachment fixture\r\nMessage-ID: <synthetic@transport.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=local\r\n\r\n--local\r\nContent-Type: text/plain\r\n\r\n${body}\r\n--local\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=private.bin\r\nContent-Transfer-Encoding: base64\r\n\r\ncHJpdmF0ZS1iaW5hcnktYXR0YWNobWVudA==\r\n--local--\r\n`,
  );
}
const receive = (
  sourceId = "provider:receipt:1",
  recipients = ["person@transport.invalid"],
  raw = fixture("external@example.invalid", "visible-wrong@example.invalid"),
) => receiveMailboxMime(db, keys, { sourceId, recipients, raw }, mimeAdapter);
const draft = (raw = fixture(), box = mailboxId, actor = owner()) =>
  saveMailboxDraft(db, keys, actor, { mailboxId: box, expectedRevision: 0, raw });
const queue = (id: string, revision = 1, box = mailboxId, actor = owner()) =>
  queueMailboxDraft(
    db,
    keys,
    actor,
    { mailboxId: box, id, expectedRevision: revision },
    mimeAdapter,
  );
const send = (id: string, sender: MailboxOutboxSender) =>
  sendMailboxOutbox(db, keys, id, sender, mimeAdapter);
const outbox = async (id: string) =>
  (await db.select().from(mailboxOutbox).where(eq(mailboxOutbox.id, id)))[0]!;
const agentKey = (box = mailboxId) =>
  createMailboxAgentKey(db, owner(), {
    mailboxId: box,
    label: "Synthetic sender",
    scopes: ["send"],
  });
const queueAgent = (token: string, id: string, revision = 1) =>
  queueMailboxAgentDraft(db, keys, token, { id, expectedRevision: revision }, mimeAdapter);

beforeEach(async () => {
  client = new PGlite();
  // Match the production migrator: each main migration's locks and DDL share one transaction.
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
  const teams = await db
    .insert(schema.teams)
    .values([
      { name: "Transport", slug: "transport" },
      { name: "Other", slug: "transport-other" },
    ])
    .returning();
  teamId = teams[0]!.id;
  foreignTeamId = teams[1]!.id;
  for (const id of ["owner", "delegate", "admin", "foreign"])
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.invalid`, emailVerified: true });
  await db.insert(schema.teamMembers).values([
    { teamId, userId: "owner", role: "owner" },
    { teamId, userId: "delegate", role: "member" },
    { teamId, userId: "admin", role: "admin" },
    { teamId: foreignTeamId, userId: "foreign", role: "owner" },
  ]);
  const now = Date.now();
  await db.insert(schema.mailboxSubscriptions).values(
    [teamId, foreignTeamId].map((id) => ({
      teamId: id,
      status: "active" as const,
      seats: 5,
      storageBytesPerMailbox: 8 * 1024 * 1024,
      includedOutboundPerMailbox: 10,
      periodStart: new Date(now - 86400000),
      periodEnd: new Date(now + 86400000),
    })),
  );
  const domains = await db
    .insert(schema.domains)
    .values([
      { teamId, name: "transport.invalid", status: "verified", region: "us-east-1" },
      { teamId: foreignTeamId, name: "foreign.invalid", status: "verified", region: "us-east-1" },
    ])
    .returning();
  mailboxId = (
    await createMailboxRegistry(db, owner(), {
      domainId: domains[0]!.id,
      localPart: "person",
      label: "Person",
      kind: "person",
      ownerUserId: "owner",
    })
  ).id;
  agentId = (
    await createMailboxRegistry(db, owner(), {
      domainId: domains[0]!.id,
      localPart: "agent",
      label: "Agent",
      kind: "agent",
      ownerUserId: "owner",
    })
  ).id;
  foreignId = (
    await createMailboxRegistry(
      db,
      { teamId: foreignTeamId, userId: "foreign" },
      {
        domainId: domains[1]!.id,
        localPart: "other",
        label: "Other",
        kind: "person",
        ownerUserId: "foreign",
      },
    )
  ).id;
  keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
});
afterEach(async () => {
  await client.close();
});

describe("durable private Correio transport contracts with captured provider", () => {
  it("rejects changed receipt assessments without overwriting the sealed MIME or a human folder review", async () => {
    const raw = fixture("external@example.invalid", "visible-wrong@example.invalid");
    const input = {
      sourceId: "assessment:stable-receipt",
      recipients: ["person@transport.invalid"],
      raw,
      assessment: assessMailboxReceipt({
        virusVerdict: { status: "PASS" },
        spamVerdict: { status: "FAIL" },
      }),
    };
    const first = await receiveMailboxMime(db, keys, input, mimeAdapter);
    const id = first.items[0]!.id;
    await setMailboxDeliveryFolder(db, owner(), {
      mailboxId,
      id,
      expectedRevision: 1,
      folder: "inbox",
    });
    const [before] = await db
      .select()
      .from(schema.mailboxItems)
      .where(eq(schema.mailboxItems.id, id));
    expect(before).toMatchObject({
      deliveryFolder: "inbox",
      revision: 2,
      inboundAssessment: input.assessment,
    });
    expect((await receiveMailboxMime(db, keys, input, mimeAdapter)).items).toEqual([
      { id, mailboxId, duplicate: true },
    ]);
    for (const assessment of [
      assessMailboxReceipt({
        virusVerdict: { status: "PASS" },
        spamVerdict: { status: "PASS" },
      }),
      assessMailboxReceipt({
        virusVerdict: { status: "PASS" },
        spamVerdict: { status: "FAIL" },
        dmarcVerdict: { status: "FAIL" },
        dmarcPolicy: "reject",
      }),
      assessMailboxReceipt({
        virusVerdict: { status: "FAIL" },
        spamVerdict: { status: "FAIL" },
      }),
    ])
      await expect(
        receiveMailboxMime(db, keys, { ...input, assessment }, mimeAdapter),
      ).rejects.toMatchObject({ code: "conflict" });
    expect(await db.select().from(schema.mailboxItems)).toEqual([before]);
    expect((await readMailboxItem(db, keys, owner(), { mailboxId, id })).raw.equals(raw)).toBe(
      true,
    );
  });

  it("persists quarantine without MIME parsing, counts storage and keeps every content read blocked", async () => {
    const raw = Buffer.from("unparsed unsafe fixture bytes");
    const parse = vi.fn(async () => {
      throw new Error("must not parse quarantine");
    });
    const assessment = assessMailboxReceipt({
      virusVerdict: { status: "FAIL" },
      spamVerdict: { status: "PASS" },
    });
    const input = {
      sourceId: "unsafe:1",
      recipients: ["person@transport.invalid"],
      raw,
      assessment,
    };
    const first = await receiveMailboxMime(db, keys, input, { parse });
    const repeat = await receiveMailboxMime(db, keys, input, { parse });
    expect(repeat.items[0]).toMatchObject({ id: first.items[0]!.id, duplicate: true });
    expect(parse).not.toHaveBeenCalled();
    const [stored] = await db.select().from(schema.mailboxItems);
    expect(stored).toMatchObject({
      rawBytes: raw.length,
      deliveryFolder: "quarantine",
      inboundAssessment: assessment,
    });
    expect(stored!.ciphertext.includes(raw)).toBe(false);
    await expect(
      readMailboxItem(db, keys, owner(), { mailboxId, id: first.items[0]!.id }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await db
      .update(schema.mailboxSubscriptions)
      .set({ storageBytesPerMailbox: raw.length })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    await expect(
      receiveMailboxMime(db, keys, { ...input, sourceId: "unsafe:2" }, { parse }),
    ).rejects.toMatchObject({ code: "quota" });
    expect(await db.select().from(schema.mailboxItems)).toHaveLength(1);
  });
  it("routes trusted RCPT across teams, encrypts fanout and deduplicates provider receipts rather than MIME Message-ID", async () => {
    const raw = fixture("external@example.invalid", "visible-wrong@example.invalid");
    const recipients = ["person@transport.invalid", "other@foreign.invalid"];
    const result = await receive("provider:receipt:1", recipients, raw);
    expect(result.items).toHaveLength(2);
    expect(
      (await receive("provider:receipt:1", [...recipients].reverse(), raw)).items.every(
        (i) => i.duplicate,
      ),
    ).toBe(true);
    expect((await receive("provider:receipt:2", [recipients[0]!], raw)).items[0]!.duplicate).toBe(
      false,
    );
    const personal = result.items.find((i) => i.mailboxId === mailboxId)!;
    expect(
      (await readMailboxItem(db, keys, owner(), { mailboxId, id: personal.id })).raw.equals(raw),
    ).toBe(true);
    const foreign = result.items.find((i) => i.mailboxId === foreignId)!;
    await expect(
      readMailboxItem(db, keys, owner(), { mailboxId: foreignId, id: foreign.id }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const stored = await db.select().from(schema.mailboxItems);
    expect(stored).toHaveLength(3);
    expect(stored.every((i) => !i.ciphertext.includes(Buffer.from("private original body")))).toBe(
      true,
    );
    await expect(
      receive(
        "provider:receipt:1",
        recipients,
        fixture("external@example.invalid", "visible-wrong@example.invalid", "changed"),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("rolls the whole fanout back for an unknown recipient, unverified domain or insufficient storage", async () => {
    await expect(
      receive("unknown", ["person@transport.invalid", "absent@transport.invalid"]),
    ).rejects.toMatchObject({ code: "not_found" });
    await db
      .update(schema.mailboxSubscriptions)
      .set({ storageBytesPerMailbox: 1 })
      .where(eq(schema.mailboxSubscriptions.teamId, foreignTeamId));
    await expect(
      receive("quota", ["person@transport.invalid", "other@foreign.invalid"]),
    ).rejects.toMatchObject({ code: "quota" });
    expect(await db.select().from(schema.mailboxItems)).toHaveLength(0);
    await db
      .update(schema.domains)
      .set({ status: "pending" })
      .where(eq(schema.domains.teamId, teamId));
    await expect(receive()).rejects.toMatchObject({ code: "forbidden" });
    expect(await db.select().from(schema.mailboxItems)).toHaveLength(0);
  });
  it("requires the current owner approval and exact draft revision for person or agent boxes", async () => {
    await grantMailboxRegistry(db, owner(), {
      mailboxId: agentId,
      userId: "delegate",
      permission: "draft",
    });
    const item = await draft(fixture("agent@transport.invalid"), agentId, delegate());
    await expect(queue(item.id, 1, agentId, delegate())).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(queue(item.id, 1, agentId, { teamId, userId: "admin" })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(queue(item.id, 2, agentId)).rejects.toMatchObject({ code: "conflict" });
    await expect(queue(item.id, 1, mailboxId)).rejects.toMatchObject({ code: "not_found" });
    expect((await queue(item.id, 1, agentId)).status).toBe("queued");
    const forged = await draft(fixture("forged@example.invalid"));
    await expect(queue(forged.id)).rejects.toMatchObject({ code: "invalid" });
  });
  it("freezes MIME and attachments independently of later edits, and moves Sent atomically on acceptance", async () => {
    const original = fixture();
    const item = await draft(original);
    const accepted = await queue(item.id);
    const second = await queue(item.id);
    expect(second.id).toBe(accepted.id);
    expect(second.duplicate).toBe(true);
    await saveMailboxDraft(db, keys, owner(), {
      mailboxId,
      id: item.id,
      expectedRevision: 1,
      raw: fixture(undefined, undefined, "later edit"),
    });
    const capture = vi.fn<MailboxOutboxSender["send"]>(async (input) => {
      expect((await outbox(input.outboxId)).status).toBe("sending");
      expect(input.raw.equals(original)).toBe(true);
      expect(input.to).toEqual(["recipient@example.invalid"]);
      const parsed = await simpleParser(input.raw);
      expect(parsed.attachments[0]!.content.toString()).toBe("private-binary-attachment");
      return { messageId: "provider-accepted-1" };
    });
    expect((await send(accepted.id, { send: capture })).status).toBe("accepted");
    expect((await send(accepted.id, { send: capture })).duplicate).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    const row = await outbox(accepted.id);
    expect(row.ciphertext).toBeNull();
    expect(row.wrappedDek).toBeNull();
    const sent = await readMailboxItem(db, keys, owner(), { mailboxId, id: accepted.id });
    expect(sent.kind).toBe("sent");
    expect(sent.raw.equals(original)).toBe(true);
    expect(await db.select().from(schema.emails)).toHaveLength(0);
    expect(await db.select().from(schema.usageCounters)).toHaveLength(0);
  });
  it("groups a received message and its sent reply into one conversation", async () => {
    const received = (await receive("provider:receipt:thread")).items[0]!;
    const reply = Buffer.from(
      "From: person@transport.invalid\r\nTo: external@example.invalid\r\nSubject: Re: Private attachment fixture\r\nMessage-ID: <reply@transport.invalid>\r\nIn-Reply-To: <synthetic@transport.invalid>\r\nReferences: <synthetic@transport.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nObrigado!\r\n",
    );
    const saved = await draft(reply);
    const admitted = await queue(saved.id);
    await send(admitted.id, { send: async () => ({ messageId: "api-id-thread" }) });
    const rows = await db
      .select({
        id: schema.mailboxItems.id,
        kind: schema.mailboxItems.kind,
        threadKey: schema.mailboxItems.threadKey,
      })
      .from(schema.mailboxItems)
      .where(eq(schema.mailboxItems.mailboxId, mailboxId));
    const key = mailboxIdKey("<synthetic@transport.invalid>");
    expect(rows.find((row) => row.id === received.id)?.threadKey).toBe(key);
    expect(rows.find((row) => row.id === admitted.id)).toMatchObject({
      kind: "sent",
      threadKey: key,
    });
    // The draft shares the key but is not a conversation message.
    expect((await countMailboxThreads(db, owner(), mailboxId, [key, "not-a-key"])).get(key)).toBe(
      2,
    );
    expect(
      (await listMailboxThread(db, owner(), { mailboxId, id: admitted.id })).map((m) => m.kind),
    ).toEqual(["inbox", "sent"]);
    const inbox = (
      await db.select().from(schema.mailboxItems).where(eq(schema.mailboxItems.id, received.id))
    )[0]!;
    await setMailboxItemTrash(db, owner(), {
      mailboxId,
      id: received.id,
      expectedRevision: inbox.revision,
      trashed: true,
    });
    expect((await countMailboxThreads(db, owner(), mailboxId, [key])).get(key)).toBe(1);
  });

  it("enriches an accepted snapshot with an observed RFC alias without replay, mutation or ambiguous same-box matches", async () => {
    const raw = fixture();
    const admitted = await queue((await draft(raw)).id);
    const captured = vi.fn<MailboxOutboxSender["send"]>(async () => ({ messageId: "api-id-1" }));
    await send(admitted.id, { send: captured });
    const accepted = await outbox(admitted.id);
    expect(accepted.providerRfcMessageId).toBeNull();
    const sentBefore = (
      await db.select().from(schema.mailboxItems).where(eq(schema.mailboxItems.id, admitted.id))
    )[0]!;
    for (const rfcMessageId of [
      "api-id-1",
      "<api-id-1>",
      "<id@example.invalid>\r\nInjected: yes",
    ]) {
      await expect(
        acceptMailboxOutbox(db, admitted.id, {
          attemptId: accepted.attemptId!,
          messageId: "api-id-1",
          rfcMessageId,
        }),
      ).rejects.toMatchObject({ code: "invalid" });
    }
    const alias = "<observed-id@email.amazonses.com>";
    const evidence = { attemptId: accepted.attemptId!, messageId: "api-id-1", rfcMessageId: alias };
    expect((await acceptMailboxOutbox(db, admitted.id, evidence)).duplicate).toBe(true);
    expect((await acceptMailboxOutbox(db, admitted.id, evidence)).duplicate).toBe(true);
    expect(await outbox(admitted.id)).toMatchObject({
      status: "accepted",
      providerMessageId: "api-id-1",
      providerRfcMessageId: alias,
      acceptedAt: accepted.acceptedAt,
      ciphertext: null,
    });
    // Only the conversation keys follow the provider's ID (replies quote it);
    // the sent copy's content, revision and timestamps stay as they were.
    const sentAfter = (
      await db.select().from(schema.mailboxItems).where(eq(schema.mailboxItems.id, admitted.id))
    )[0]!;
    const aliasKey = mailboxIdKey(alias);
    expect(sentAfter).toEqual({ ...sentBefore, messageKey: aliasKey, threadKey: aliasKey });
    expect(sentBefore.threadKey).toBe(sentBefore.messageKey);
    expect((await readMailboxItem(db, keys, owner(), { mailboxId, id: admitted.id })).raw).toEqual(
      raw,
    );
    await expect(
      acceptMailboxOutbox(db, admitted.id, {
        ...evidence,
        rfcMessageId: "<conflicting@email.amazonses.com>",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await send(admitted.id, { send: captured });
    expect(captured).toHaveBeenCalledTimes(1);

    const collision = await queue((await draft()).id);
    await send(collision.id, {
      send: async () => {
        throw new Error("lost acknowledgement");
      },
    });
    const ambiguous = await outbox(collision.id);
    await expect(
      acceptMailboxOutbox(db, collision.id, {
        attemptId: ambiguous.attemptId!,
        messageId: "api-id-2",
        rfcMessageId: alias,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await outbox(collision.id)).status).toBe("unknown");
    expect((await outbox(collision.id)).ciphertext).not.toBeNull();
    expect(
      await db.select().from(schema.mailboxItems).where(eq(schema.mailboxItems.id, collision.id)),
    ).toHaveLength(0);

    const otherBox = await queue(
      (await draft(fixture("agent@transport.invalid"), agentId)).id,
      1,
      agentId,
    );
    await send(otherBox.id, { send: async () => ({ messageId: "other-box-api" }) });
    await acceptMailboxOutbox(db, otherBox.id, {
      attemptId: (await outbox(otherBox.id)).attemptId!,
      messageId: "other-box-api",
      rfcMessageId: alias,
    });
    expect((await outbox(otherBox.id)).providerRfcMessageId).toBe(alias);
  });
  it("charges distinct recipients by box/period and keeps Envio quotas untouched", async () => {
    await db
      .update(schema.mailboxSubscriptions)
      .set({ includedOutboundPerMailbox: 2 })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    const item = await draft(
      fixture(undefined, "a@example.invalid, a@example.invalid, b@example.invalid"),
    );
    const admitted = await queue(item.id);
    expect(admitted.recipientCount).toBe(2);
    expect((await queue(item.id)).duplicate).toBe(true);
    const another = await draft();
    await expect(queue(another.id)).rejects.toMatchObject({ code: "quota" });
    expect(await db.select().from(mailboxOutbox)).toHaveLength(1);
    const plan = (
      await db
        .select()
        .from(schema.mailboxSubscriptions)
        .where(eq(schema.mailboxSubscriptions.teamId, teamId))
    )[0]!;
    await db
      .update(schema.mailboxSubscriptions)
      .set({ periodStart: new Date(plan.periodStart.getTime() + 1000) })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    expect((await queue(another.id)).recipientCount).toBe(1);
    expect(await db.select().from(schema.emails)).toHaveLength(0);
  });
  it("counts pending encrypted snapshots toward storage and does not double-charge a repeated approval", async () => {
    const raw = fixture();
    const item = await draft(raw);
    await db
      .update(schema.mailboxSubscriptions)
      .set({ storageBytesPerMailbox: raw.length * 2 })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    await queue(item.id);
    expect((await queue(item.id)).duplicate).toBe(true);
    await expect(receive()).rejects.toMatchObject({ code: "quota" });
    await expect(
      saveMailboxDraft(db, keys, owner(), {
        mailboxId,
        id: item.id,
        expectedRevision: 1,
        raw: fixture(
          undefined,
          undefined,
          "a much longer replacement body that exceeds the complete reserved space",
        ),
      }),
    ).rejects.toMatchObject({ code: "quota" });
  });
  it("refuses a prior-period reservation after renewal without sending or silently re-reserving", async () => {
    const admitted = await queue((await draft()).id);
    const plan = (
      await db
        .select()
        .from(schema.mailboxSubscriptions)
        .where(eq(schema.mailboxSubscriptions.teamId, teamId))
    )[0]!;
    await db
      .update(schema.mailboxSubscriptions)
      .set({ periodStart: new Date(plan.periodStart.getTime() + 1000) })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    const capture = vi.fn(async () => ({ messageId: "must-not-send" }));
    const result = await send(admitted.id, { send: capture });
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("reservation_expired");
    expect(capture).not.toHaveBeenCalled();
    const row = await outbox(admitted.id);
    expect(row.periodStart.getTime()).toBe(plan.periodStart.getTime());
    expect(row.ciphertext).not.toBeNull();
  });
  it("keeps an ambiguous provider acknowledgement unknown after restart and resolves only matching evidence", async () => {
    const item = await draft();
    const admitted = await queue(item.id);
    const capture = vi.fn<MailboxOutboxSender["send"]>(async () => {
      throw new Error("synthetic timeout after provider acceptance");
    });
    expect((await send(admitted.id, { send: capture })).status).toBe("unknown");
    db = drizzle(client, { schema: { ...schema, mailboxOutbox } }) as unknown as Db;
    expect((await send(admitted.id, { send: capture })).status).toBe("unknown");
    expect(capture).toHaveBeenCalledTimes(1);
    const row = await outbox(admitted.id);
    expect(row.ciphertext).not.toBeNull();
    expect(
      await db.select().from(schema.mailboxItems).where(eq(schema.mailboxItems.kind, "sent")),
    ).toHaveLength(0);
    await expect(
      acceptMailboxOutbox(db, row.id, { attemptId: randomUUID(), messageId: "accepted-later" }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      (
        await acceptMailboxOutbox(db, row.id, {
          attemptId: row.attemptId!,
          messageId: "accepted-later",
        })
      ).status,
    ).toBe("accepted");
    expect(
      (
        await acceptMailboxOutbox(db, row.id, {
          attemptId: row.attemptId!,
          messageId: "accepted-later",
        })
      ).duplicate,
    ).toBe(true);
    await expect(
      acceptMailboxOutbox(db, row.id, {
        attemptId: row.attemptId!,
        messageId: "different-evidence",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("defers a trusted preflight before provider invocation while preserving the reservation and immutable snapshot", async () => {
    const admitted = await queue((await draft()).id);
    const original = await outbox(admitted.id);
    const provider = vi.fn(async () => ({ messageId: "accepted-after-quota-window" }));
    let callbacks = 0;
    let deferredAttempt: string | null = null;
    const sender: MailboxOutboxSender = {
      send: async (input) => {
        callbacks += 1;
        if (callbacks === 1) {
          deferredAttempt = input.attemptId;
          throw new MailboxSendDeferredError();
        }
        expect(input.attemptId).not.toBe(deferredAttempt);
        return provider();
      },
    };
    expect((await send(admitted.id, sender)).status).toBe("queued");
    expect(provider).not.toHaveBeenCalled();
    const waiting = await outbox(admitted.id);
    expect(waiting.attemptId).toBeNull();
    expect(waiting.attemptedAt).toBeNull();
    expect(waiting.recipientCount).toBe(original.recipientCount);
    expect(waiting.periodStart).toEqual(original.periodStart);
    expect(Buffer.from(waiting.ciphertext!).equals(Buffer.from(original.ciphertext!))).toBe(true);
    expect((await queue(admitted.draftId)).duplicate).toBe(true);
    expect((await send(admitted.id, sender)).status).toBe("accepted");
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await db.select().from(mailboxOutbox)).toHaveLength(1);
  });
  it("preserves unknown quota reservations while confirmed rejections release recipient capacity", async () => {
    await db
      .update(schema.mailboxSubscriptions)
      .set({ includedOutboundPerMailbox: 1 })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    const admitted = await queue((await draft()).id);
    expect(
      (
        await send(admitted.id, {
          send: async () => {
            throw new MailboxSendRejectedError();
          },
        })
      ).status,
    ).toBe("failed");
    expect((await outbox(admitted.id)).ciphertext).not.toBeNull();
    const next = await queue((await draft()).id);
    await send(next.id, {
      send: async () => {
        throw new Error("ambiguous");
      },
    });
    await expect(queue((await draft()).id)).rejects.toMatchObject({ code: "quota" });
  });
  it("recovers committed queued rows but never resends an interrupted durable claim", async () => {
    const pending = await queue((await draft()).id);
    const interrupted = await queue((await draft()).id);
    await db
      .update(mailboxOutbox)
      .set({
        status: "sending",
        attemptId: randomUUID(),
        attemptedAt: new Date(Date.now() - 3600000),
      })
      .where(eq(mailboxOutbox.id, interrupted.id));
    const enqueue = vi.fn(async (_id: string) => {});
    expect(await reconcileMailboxOutbox(db, { enqueue })).toEqual({ requeued: 1, unknown: 1 });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(pending.id);
    expect((await outbox(interrupted.id)).status).toBe("unknown");
    const capture = vi.fn(async () => ({ messageId: "must-not-send" }));
    await send(interrupted.id, { send: capture });
    expect(capture).not.toHaveBeenCalled();
    expect(await failQueuedMailboxOutbox(db, interrupted.id)).toBe(false);
    expect(await failQueuedMailboxOutbox(db, pending.id)).toBe(true);
    expect(await failQueuedMailboxOutbox(db, pending.id)).toBe(false);
  });
  it("rechecks ownership and suspension before send, yet records an established acceptance after plan expiry", async () => {
    const refused = await queue((await draft()).id);
    await updateMailboxRegistry(db, owner(), {
      id: mailboxId,
      label: "Person",
      ownerUserId: "owner",
      status: "suspended",
    });
    const capture = vi.fn(async () => ({ messageId: "must-not-send" }));
    expect((await send(refused.id, { send: capture })).status).toBe("failed");
    expect(capture).not.toHaveBeenCalled();
    await updateMailboxRegistry(db, owner(), {
      id: mailboxId,
      label: "Person",
      ownerUserId: "owner",
      status: "planned",
    });
    const admitted = await queue((await draft()).id);
    expect(
      (
        await send(admitted.id, {
          send: async () => {
            await db
              .update(schema.mailboxSubscriptions)
              .set({ status: "canceled" })
              .where(eq(schema.mailboxSubscriptions.teamId, teamId));
            return { messageId: "accepted-despite-expiry" };
          },
        })
      ).status,
    ).toBe("accepted");
    expect((await readMailboxItem(db, keys, owner(), { mailboxId, id: admitted.id })).kind).toBe(
      "sent",
    );
  });
  it("rejects forged cross-box draft references in the database and invalid MIME before side effects", async () => {
    const admitted = await queue((await draft()).id);
    const row = await outbox(admitted.id);
    await expect(
      db.insert(mailboxOutbox).values({ ...row, id: randomUUID(), mailboxId: agentId }),
    ).rejects.toThrow();
    await expect(receive("large", undefined, Buffer.alloc(1024 * 1024 + 1))).rejects.toMatchObject({
      code: "invalid",
    });
    const item = await draft();
    await expect(
      queueMailboxDraft(
        db,
        keys,
        owner(),
        { mailboxId, id: item.id, expectedRevision: 1 },
        {
          parse: async () => ({
            from: "person@transport.invalid",
            to: ["recipient@example.invalid"],
            attachmentBytes: [256 * 1024 + 1],
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(
      await db
        .select()
        .from(mailboxOutbox)
        .where(and(eq(mailboxOutbox.mailboxId, mailboxId), eq(mailboxOutbox.draftId, item.id))),
    ).toHaveLength(0);
  });
  it("captures immutable agent provenance and allows idempotency only for that authorization", async () => {
    const first = await agentKey();
    const second = await agentKey();
    const item = await draft();
    const admitted = await queueAgent(first.token, item.id);
    const stored = await outbox(admitted.id);
    expect(stored).toMatchObject({
      approvalKind: "agent",
      agentKeyId: first.id,
      approvedBy: "owner",
    });
    expect(JSON.stringify(stored)).not.toContain(first.token);
    expect(stored).not.toHaveProperty("keyHash");
    expect((await queueAgent(first.token, item.id)).id).toBe(admitted.id);
    await expect(queueAgent(second.token, item.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(queue(item.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(
      db
        .update(mailboxOutbox)
        .set({ approvalKind: "human", agentKeyId: null })
        .where(eq(mailboxOutbox.id, admitted.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(mailboxOutbox)
        .set({ agentKeyId: second.id })
        .where(eq(mailboxOutbox.id, admitted.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(mailboxOutbox)
        .set({ approvedBy: "delegate" })
        .where(eq(mailboxOutbox.id, admitted.id)),
    ).rejects.toThrow();
    expect((await outbox(admitted.id)).agentKeyId).toBe(first.id);
    const capture = vi.fn(async () => ({ messageId: "agent-provider-accepted" }));
    expect((await send(admitted.id, { send: capture })).status).toBe("accepted");
    await send(admitted.id, { send: capture });
    expect(capture).toHaveBeenCalledTimes(1);
    const human = await queue((await draft()).id);
    expect(await outbox(human.id)).toMatchObject({ approvalKind: "human", agentKeyId: null });
  });
  it("requires send consent and derives the draft mailbox from the bearer", async () => {
    const defaultKey = await createMailboxAgentKey(db, owner(), { mailboxId, label: "Draft only" });
    const item = await draft();
    await expect(queueAgent(defaultKey.token, item.id)).rejects.toMatchObject({
      code: "forbidden",
    });
    const sender = await agentKey();
    const other = await draft(fixture("agent@transport.invalid"), agentId);
    await expect(queueAgent(sender.token, other.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(queueAgent("ms_" + "a".repeat(32), item.id)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await db.select().from(mailboxOutbox)).toHaveLength(0);
  });
  it("refuses revoked, expired, deleted or narrowed queued credentials without invoking the provider", async () => {
    const capture = vi.fn(async () => ({ messageId: "must-not-send" }));
    for (const invalidation of ["revoked", "expired", "deleted", "scope", "pin"] as const) {
      const key = await agentKey();
      const admitted = await queueAgent(key.token, (await draft()).id);
      if (invalidation === "revoked")
        await revokeMailboxAgentKey(db, owner(), { mailboxId, id: key.id });
      if (invalidation === "expired")
        await db
          .update(schema.mailboxAgentKeys)
          .set({
            createdAt: new Date(Date.now() - 172800000),
            expiresAt: new Date(Date.now() - 86400000),
          })
          .where(eq(schema.mailboxAgentKeys.id, key.id));
      if (invalidation === "deleted")
        await db.delete(schema.mailboxAgentKeys).where(eq(schema.mailboxAgentKeys.id, key.id));
      if (invalidation === "scope")
        await db
          .update(schema.mailboxAgentKeys)
          .set({ scopes: ["read"] })
          .where(eq(schema.mailboxAgentKeys.id, key.id));
      if (invalidation === "pin") {
        const [member] = await db
          .select({ id: schema.teamMembers.id })
          .from(schema.teamMembers)
          .where(
            and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, "delegate")),
          );
        await db
          .update(schema.mailboxAgentKeys)
          .set({ ownerMembershipId: member!.id })
          .where(eq(schema.mailboxAgentKeys.id, key.id));
      }
      expect(await send(admitted.id, { send: capture })).toMatchObject({
        status: "failed",
        errorCode: "agent_authorization_refused",
      });
      expect(await outbox(admitted.id)).toMatchObject({
        approvalKind: "agent",
        agentKeyId: key.id,
        attemptId: null,
        attemptedAt: null,
      });
    }
    expect(capture).not.toHaveBeenCalled();
  });
  it("checks expiration again after parsing and before claiming queued agent mail", async () => {
    const expiresAt = new Date(Date.now() + 60000);
    const key = await createMailboxAgentKey(db, owner(), {
      mailboxId,
      label: "Expires in parsing",
      scopes: ["send"],
      expiresAt,
    });
    const admitted = await queueAgent(key.token, (await draft()).id);
    const capture = vi.fn(async () => ({ messageId: "must-not-send" }));
    const date = vi.spyOn(Date, "now");
    try {
      expect(
        (
          await sendMailboxOutbox(
            db,
            keys,
            admitted.id,
            { send: capture },
            {
              async parse(raw) {
                const parsed = await mimeAdapter.parse(raw);
                date.mockReturnValue(expiresAt.getTime() + 1);
                return parsed;
              },
            },
          )
        ).status,
      ).toBe("failed");
    } finally {
      date.mockRestore();
    }
    expect(capture).not.toHaveBeenCalled();
    expect((await outbox(admitted.id)).attemptId).toBeNull();
  });
  it("never restores queued agent approval after reassignment, reentry or team suspension", async () => {
    const key = await agentKey();
    const reassigned = await queueAgent(key.token, (await draft()).id);
    await updateMailboxRegistry(db, owner(), {
      id: mailboxId,
      label: "Delegate",
      ownerUserId: "delegate",
      status: "planned",
    });
    await updateMailboxRegistry(db, owner(), {
      id: mailboxId,
      label: "Owner again",
      ownerUserId: "owner",
      status: "planned",
    });
    const reentry = await queueAgent((await agentKey()).token, (await draft()).id);
    await db
      .delete(schema.teamMembers)
      .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, "owner")));
    await db.insert(schema.teamMembers).values({ teamId, userId: "owner", role: "owner" });
    await updateMailboxRegistry(db, owner(), {
      id: mailboxId,
      label: "Fresh membership",
      ownerUserId: "owner",
      status: "planned",
    });
    const suspended = await queueAgent((await agentKey()).token, (await draft()).id);
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.teams.id, teamId));
    const capture = vi.fn(async () => ({ messageId: "must-not-send" }));
    for (const queued of [reassigned, reentry, suspended])
      expect((await send(queued.id, { send: capture })).status).toBe("failed");
    expect(capture).not.toHaveBeenCalled();
  });
  it("keeps agent authorization across preflight deferral and refuses a revoked retry", async () => {
    const key = await agentKey();
    const admitted = await queueAgent(key.token, (await draft()).id);
    const original = await outbox(admitted.id);
    const provider = vi.fn(async () => ({ messageId: "must-not-send" }));
    const preflight = vi.fn(async () => {
      throw new MailboxSendDeferredError();
    });
    expect((await send(admitted.id, { send: preflight })).status).toBe("queued");
    const deferred = await outbox(admitted.id);
    expect(deferred).toMatchObject({
      approvalKind: "agent",
      agentKeyId: key.id,
      attemptId: null,
      attemptedAt: null,
    });
    expect(Buffer.from(deferred.ciphertext!).equals(Buffer.from(original.ciphertext!))).toBe(true);
    expect(deferred.recipientCount).toBe(original.recipientCount);
    await revokeMailboxAgentKey(db, owner(), { mailboxId, id: key.id });
    expect((await send(admitted.id, { send: provider })).status).toBe("failed");
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(provider).not.toHaveBeenCalled();
  });
  it("records a committed claim's acceptance after revocation and never invokes it again", async () => {
    const key = await agentKey();
    const admitted = await queueAgent(key.token, (await draft()).id);
    const capture = vi.fn(async () => {
      expect((await outbox(admitted.id)).status).toBe("sending");
      await revokeMailboxAgentKey(db, owner(), { mailboxId, id: key.id });
      return { messageId: "already-authorized-claim" };
    });
    expect((await send(admitted.id, { send: capture })).status).toBe("accepted");
    await send(admitted.id, { send: capture });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(await outbox(admitted.id)).toMatchObject({
      approvalKind: "agent",
      agentKeyId: key.id,
      status: "accepted",
    });
  });
});
