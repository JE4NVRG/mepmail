import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { simpleParser } from "mailparser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvKeyring, type Keyring } from "../../../packages/core/src/crypto/keyring.js";
import { createMailboxAgentKey } from "../../../packages/core/src/mailbox-agent-access.js";
import { saveMailboxDraft } from "../../../packages/core/src/mailbox-private-store.js";
import { createMailboxRegistry } from "../../../packages/core/src/mailbox-registry.js";
import {
  acceptMailboxOutbox,
  type MailboxOutboxSender,
  MailboxSendRejectedError,
  type MailboxTransportMimeAdapter,
  queueMailboxAgentDraft,
  queueMailboxDraft,
  reconcileMailboxOutbox,
  sendMailboxOutbox,
} from "../../../packages/core/src/mailbox-transport.js";
import { mailboxOutbox } from "../../../packages/db/src/schema/mailbox-transport.js";

/*
 * Interrupted and resumed sends in Mail, scenario by scenario (4 to 8 of the send
 * confidence matrix; 1 to 3 live in src/lib/mailbox-undo-send.test.ts, before any
 * request). The provider is a local capture: it records every call it receives, so
 * "at most one email" is counted where the email would leave.
 */

let client: PGlite, db: Db, teamId: string, mailboxId: string, keys: Keyring;
const base = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const owner = () => ({ teamId, userId: "owner" });
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
const message = (body = "first version") =>
  Buffer.from(
    `From: person@interrupt.invalid\r\nTo: customer@example.invalid\r\nSubject: Interrupted send\r\nMessage-ID: <synthetic@interrupt.invalid>\r\n\r\n${body}\r\n`,
  );
const draft = (body?: string) =>
  saveMailboxDraft(db, keys, owner(), { mailboxId, expectedRevision: 0, raw: message(body) });
const edit = (id: string, expectedRevision: number, body = "edited in another tab") =>
  saveMailboxDraft(db, keys, owner(), { mailboxId, id, expectedRevision, raw: message(body) });
const queue = (id: string, expectedRevision = 1, adapter = mime) =>
  queueMailboxDraft(db, keys, owner(), { mailboxId, id, expectedRevision }, adapter);
const work = (outboxId: string, sender: MailboxOutboxSender) =>
  sendMailboxOutbox(db, keys, outboxId, sender, mime);
const rows = () => db.select().from(mailboxOutbox);
const outbox = async (id: string) =>
  (await db.select().from(mailboxOutbox).where(eq(mailboxOutbox.id, id)))[0]!;
/** The provider: every call is one email that would leave. */
const provider = (outcome: "accept" | "lose-response" | "reject" = "accept") =>
  vi.fn<MailboxOutboxSender["send"]>(async (input) => {
    if (outcome === "reject") throw new MailboxSendRejectedError();
    if (outcome === "lose-response")
      throw new Error("synthetic: accepted by the provider, connection lost before the answer");
    return { messageId: `provider-${input.outboxId}` };
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
  teamId = (
    await db.insert(schema.teams).values({ name: "Interrupt", slug: "interrupt" }).returning()
  )[0]!.id;
  await db
    .insert(schema.user)
    .values({ id: "owner", name: "owner", email: "owner@example.invalid", emailVerified: true });
  await db.insert(schema.teamMembers).values({ teamId, userId: "owner", role: "owner" });
  const now = Date.now();
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "active",
    seats: 2,
    storageBytesPerMailbox: 8 * 1024 * 1024,
    includedOutboundPerMailbox: 50,
    periodStart: new Date(now - 86400000),
    periodEnd: new Date(now + 86400000),
  });
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "interrupt.invalid", status: "verified", region: "us-east-1" })
    .returning();
  mailboxId = (
    await createMailboxRegistry(db, owner(), {
      domainId: domain!.id,
      localPart: "person",
      label: "Person",
      kind: "person",
      ownerUserId: "owner",
    })
  ).id;
  keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
});
afterEach(async () => {
  await client.close();
});

describe("Mail send interruption and resume", () => {
  it("4a: a connection lost before the outbox commit leaves nothing sent and the draft sendable once", async () => {
    const item = await draft();
    const dropped: MailboxTransportMimeAdapter = {
      parse: async () => {
        throw new Error("synthetic: request aborted before the outbox write");
      },
    };
    await expect(queue(item.id, 1, dropped)).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
    // Resuming reads the persisted state first: nothing was captured, so the one send is new.
    const admitted = await queue(item.id);
    expect(admitted).toMatchObject({ status: "queued", duplicate: false });
    expect(await rows()).toHaveLength(1);
  });

  it("4b: a response lost after the outbox commit replays the same outbox and the email leaves once", async () => {
    const item = await draft();
    const committed = await queue(item.id);
    // The browser never saw `committed`; its retry (or a reload's Send) asks again.
    const retried = await queue(item.id);
    expect(retried).toMatchObject({ id: committed.id, duplicate: true, status: "queued" });
    expect(await rows()).toHaveLength(1);
    const capture = provider();
    // queueDraft enqueues after every call; both jobs reach the worker.
    expect((await work(committed.id, { send: capture })).status).toBe("accepted");
    expect((await work(committed.id, { send: capture })).duplicate).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect((await queue(item.id)).status).toBe("accepted");
  });

  it("5: an accepted send whose answer is lost stays unknown and is never sent again by retry, reconcile or a new job", async () => {
    const item = await draft();
    const admitted = await queue(item.id);
    const lost = provider("lose-response");
    expect((await work(admitted.id, { send: lost })).status).toBe("unknown");
    // A disconnect is not proof of failure: the snapshot and reservation stay for evidence.
    const row = await outbox(admitted.id);
    expect(row).toMatchObject({ status: "unknown", errorCode: "provider_unknown" });
    expect(row.ciphertext).not.toBeNull();
    const enqueue = vi.fn(async (_id: string) => {});
    expect(await reconcileMailboxOutbox(db, { enqueue })).toEqual({ requeued: 0, unknown: 0 });
    expect(enqueue).not.toHaveBeenCalled();
    const later = provider();
    expect((await work(admitted.id, { send: later })).status).toBe("unknown");
    expect((await queue(item.id)).status).toBe("unknown");
    expect(lost).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();
    // Only the provider's own evidence for that attempt settles it.
    const settled = await acceptMailboxOutbox(db, admitted.id, {
      attemptId: row.attemptId!,
      messageId: "provider-evidence",
    });
    expect(settled.status).toBe("accepted");
  });

  it("6: double click, two tabs and a retry of one revision make one outbox and one provider call", async () => {
    const item = await draft();
    const answers = await Promise.all([queue(item.id), queue(item.id), queue(item.id)]);
    expect(new Set(answers.map((answer) => answer.id)).size).toBe(1);
    expect(answers.filter((answer) => !answer.duplicate)).toHaveLength(1);
    const capture = provider();
    // Two workers (a redelivered job, a restarted worker) pick the same row.
    await Promise.all([
      work(answers[0]!.id, { send: capture }),
      work(answers[0]!.id, { send: capture }),
    ]);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(1);
  });

  it("6: the other tab cannot save a new revision over a submitted draft and send it again", async () => {
    for (const status of ["queued", "unknown", "accepted"] as const) {
      const item = await draft(`journey ${status}`);
      const admitted = await queue(item.id);
      if (status !== "queued")
        await work(admitted.id, {
          send: provider(status === "unknown" ? "lose-response" : "accept"),
        });
      expect((await outbox(admitted.id)).status).toBe(status);
      // Tab B still had the draft open: its save must not open a second send.
      await expect(edit(item.id, 1)).rejects.toMatchObject({ code: "conflict" });
      await expect(queue(item.id, 2)).rejects.toMatchObject({ code: "conflict" });
    }
    expect((await rows()).length).toBe(3);
  });

  it("6: a refused send can be corrected and sent as a new revision", async () => {
    const item = await draft();
    const refused = await queue(item.id);
    expect((await work(refused.id, { send: provider("reject") })).status).toBe("failed");
    const fixed = await edit(item.id, 1, "corrected after the refusal");
    expect(fixed.revision).toBe(2);
    const capture = provider();
    const retry = await queue(item.id, 2);
    expect(retry.duplicate).toBe(false);
    expect((await work(retry.id, { send: capture })).status).toBe("accepted");
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("7: an agent without the send permission captures no send; the owner's approval sends it once", async () => {
    const item = await draft();
    const draftOnly = await createMailboxAgentKey(db, owner(), { mailboxId, label: "Drafts only" });
    await expect(
      queueMailboxAgentDraft(db, keys, draftOnly.token, { id: item.id, expectedRevision: 1 }, mime),
    ).rejects.toMatchObject({ code: "forbidden" });
    // awaiting_approval is the web layer's answer to this refusal (mailbox-agent-send-approval.test.ts).
    expect(await rows()).toHaveLength(0);
    const approved = await queue(item.id);
    expect(await outbox(approved.id)).toMatchObject({ approvalKind: "human", agentKeyId: null });
    const capture = provider();
    await work(approved.id, { send: capture });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("8: an agent with the send permission sends at once, idempotently, and never resends an unknown result", async () => {
    const item = await draft();
    const sender = await createMailboxAgentKey(db, owner(), {
      mailboxId,
      label: "Sends directly",
      scopes: ["read", "draft", "send"],
    });
    const agentSend = () =>
      queueMailboxAgentDraft(db, keys, sender.token, { id: item.id, expectedRevision: 1 }, mime);
    const first = await agentSend();
    // No human undo window on this path: the outbox exists as soon as the call returns.
    expect(first).toMatchObject({ status: "queued", duplicate: false });
    const lost = provider("lose-response");
    expect((await work(first.id, { send: lost })).status).toBe("unknown");
    // The agent's retry is its status read: same outbox, no second call.
    expect(await agentSend()).toMatchObject({ id: first.id, duplicate: true, status: "unknown" });
    await work(first.id, { send: provider() });
    expect(lost).toHaveBeenCalledTimes(1);
    await expect(edit(item.id, 1, "agent rewrite after an unknown result")).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await rows()).toHaveLength(1);
  });
});
