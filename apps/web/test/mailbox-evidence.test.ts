import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvKeyring, type Keyring } from "../../../packages/core/src/crypto/keyring.js";
import {
  readMailboxItem,
  saveMailboxDraft,
} from "../../../packages/core/src/mailbox-private-store.js";
import { createMailboxRegistry } from "../../../packages/core/src/mailbox-registry.js";
import {
  type MailboxOutboxSender,
  queueMailboxDraft,
  sendMailboxOutbox,
} from "../../../packages/core/src/mailbox-transport.js";
import {
  createMailboxEvidenceHandler,
  isPrivateMailboxEvent,
} from "../../worker/src/mailbox-evidence.js";
import { type TrustedMailboxNotification } from "../../worker/src/mailbox-receiver.js";
import { mailboxWorkerMime } from "../../worker/src/mailbox-sender.js";

const topicArn = "arn:aws:sns:us-east-1:123456789012:private-ses-events";
const westTopic = "arn:aws:sns:us-west-2:123456789012:private-ses-events";
const raw = Buffer.from(
  "From: person@evidence.invalid\r\nTo: recipient@example.invalid\r\nCc: copy@example.invalid\r\nSubject: Private evidence\r\nMessage-ID: <submitted@evidence.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nprivate submitted revision\r\n",
);

describe("authenticated private SES acceptance evidence", () => {
  let client: PGlite, db: Db, keys: Keyring, teamId: string, mailboxId: string;
  beforeEach(async () => {
    client = new PGlite();
    const base = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
    const extension = fileURLToPath(
      new URL("../../../packages/db/mailbox-drizzle/", import.meta.url),
    );
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
    const database = drizzle(client, { schema });
    db = database as unknown as Db;
    await migrate(database, {
      migrationsFolder: extension,
      migrationsTable: "__mailbox_migrations",
    });
    keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
    const [team] = await db
      .insert(schema.teams)
      .values({ name: "Evidence", slug: "evidence" })
      .returning();
    teamId = team!.id;
    await db
      .insert(schema.user)
      .values({ id: "owner", name: "Owner", email: "owner@example.invalid", emailVerified: true });
    await db.insert(schema.teamMembers).values({ teamId, userId: "owner", role: "owner" });
    await db.insert(schema.mailboxSubscriptions).values({
      teamId,
      status: "active",
      seats: 2,
      storageBytesPerMailbox: 2 * 1024 * 1024,
      includedOutboundPerMailbox: 10,
      periodStart: new Date(Date.now() - 86400000),
      periodEnd: new Date(Date.now() + 86400000),
    });
    const [domain] = await db
      .insert(schema.domains)
      .values({
        teamId,
        name: "evidence.invalid",
        status: "verified",
        region: "us-east-1",
      })
      .returning();
    mailboxId = (
      await createMailboxRegistry(
        db,
        { teamId, userId: "owner" },
        {
          domainId: domain!.id,
          localPart: "person",
          label: "Person",
          kind: "person",
          ownerUserId: "owner",
        },
      )
    ).id;
  });
  afterEach(async () => {
    await client.close();
  });

  const owner = () => ({ teamId, userId: "owner" });
  const outbox = async (id: string) =>
    (await db.select().from(schema.mailboxOutbox).where(eq(schema.mailboxOutbox.id, id)))[0]!;
  const queue = async () => {
    const draft = await saveMailboxDraft(db, keys, owner(), {
      mailboxId,
      expectedRevision: 0,
      raw,
    });
    return queueMailboxDraft(
      db,
      keys,
      owner(),
      { mailboxId, id: draft.id, expectedRevision: draft.revision },
      mailboxWorkerMime,
    );
  };
  const unknown = async () => {
    const queued = await queue();
    const send = vi.fn(
      async (
        _input: Parameters<MailboxOutboxSender["send"]>[0],
      ): Promise<{ messageId: string }> => {
        throw new Error("timeout after provider acceptance");
      },
    );
    expect((await sendMailboxOutbox(db, keys, queued.id, { send }, mailboxWorkerMime)).status).toBe(
      "unknown",
    );
    return { row: await outbox(queued.id), send };
  };
  const notification = (
    id: string,
    attemptId: string,
    messageId = "ses-private-accepted-1",
  ): TrustedMailboxNotification => ({
    topicArn,
    snsMessageId: randomUUID(),
    event: {
      eventType: "Send",
      send: {},
      mail: {
        timestamp: "2026-10-04T12:00:00.000Z",
        messageId,
        source: "person@evidence.invalid",
        destination: ["recipient@example.invalid", "copy@example.invalid"],
        sendingAccountId: "123456789012",
        tags: { mepmail_outbox_id: [id], mepmail_attempt_id: [attemptId] },
      },
    },
  });
  const handler = (enabled = true) =>
    createMailboxEvidenceHandler({
      db,
      keys,
      mime: mailboxWorkerMime,
      enabled,
      topics: [topicArn, westTopic],
    });
  const headers = (input: TrustedMailboxNotification, messageId: string) => {
    const event = input.event as { eventType: string; mail: Record<string, unknown> };
    return {
      ...input,
      event: {
        ...event,
        mail: {
          ...event.mail,
          headers: [{ name: "Message-ID", value: "<submitted@evidence.invalid>" }],
          commonHeaders: { messageId },
        },
      },
    };
  };

  it("reconciles a lost acknowledgement to one private Sent item, including duplicate notifications", async () => {
    const { row, send } = await unknown();
    const handle = handler();
    const evidence = headers(
      notification(row.id, row.attemptId!),
      "<observed-final@email.amazonses.com>",
    );
    expect(await handle(evidence)).toBe(true);
    expect(await handle(evidence)).toBe(true);
    const accepted = await outbox(row.id);
    expect(accepted.status).toBe("accepted");
    expect(accepted.providerMessageId).toBe("ses-private-accepted-1");
    expect(accepted.providerRfcMessageId).toBe("<observed-final@email.amazonses.com>");
    expect(accepted.ciphertext).toBeNull();
    expect(accepted.attemptId).toBe(row.attemptId);
    const sent = (await db.select().from(schema.mailboxItems)).filter(
      (item) => item.kind === "sent",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.id).toBe(row.id);
    expect(
      (await readMailboxItem(db, keys, owner(), { mailboxId, id: row.id })).raw.equals(raw),
    ).toBe(true);
    expect((await sendMailboxOutbox(db, keys, row.id, { send }, mailboxWorkerMime)).status).toBe(
      "accepted",
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.emails)).toHaveLength(0);
  });

  it("keeps bare API IDs and original/legacy headers pending, then enriches only a complete assigned event header", async () => {
    const { row, send } = await unknown();
    const handle = handler();
    const input = notification(row.id, row.attemptId!);
    await handle(headers(input, "ses-private-accepted-1"));
    const accepted = await outbox(row.id);
    expect(accepted.providerRfcMessageId).toBeNull();
    await handle(headers(input, "<submitted@evidence.invalid>"));
    const legacy = headers(input, "<legacy-original@example.invalid>");
    await handle({
      ...legacy,
      event: { ...legacy.event, eventType: undefined, notificationType: "Send" },
    });
    expect((await outbox(row.id)).providerRfcMessageId).toBeNull();
    const alias = "<observed-final@email.amazonses.com>";
    await handle(headers(input, alias));
    await handle(headers(input, alias));
    expect(await outbox(row.id)).toMatchObject({
      providerRfcMessageId: alias,
      providerMessageId: "ses-private-accepted-1",
      acceptedAt: accepted.acceptedAt,
    });
    await expect(
      handle(headers(input, "<different-final@email.amazonses.com>")),
    ).rejects.toMatchObject({ code: "conflict" });
    const sent = (await db.select().from(schema.mailboxItems)).filter(
      (item) => item.kind === "sent",
    );
    expect(sent).toHaveLength(1);
    expect((await readMailboxItem(db, keys, owner(), { mailboxId, id: row.id })).raw).toEqual(raw);
    await sendMailboxOutbox(db, keys, row.id, { send }, mailboxWorkerMime);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("binds original Message-ID headers to the encrypted submitted revision and rejects substituted or duplicate originals", async () => {
    const { row } = await unknown();
    const valid = headers(
      notification(row.id, row.attemptId!),
      "<observed-final@email.amazonses.com>",
    );
    for (const originalHeaders of [
      [{ name: "Message-ID", value: "<substituted@example.invalid>" }],
      [
        { name: "Message-ID", value: "<submitted@evidence.invalid>" },
        { name: "message-id", value: "<submitted@evidence.invalid>" },
      ],
    ]) {
      await expect(
        handler()({
          ...valid,
          event: { ...valid.event, mail: { ...valid.event.mail, headers: originalHeaders } },
        }),
      ).rejects.toThrow("evidence");
    }
    expect((await outbox(row.id)).status).toBe("unknown");
    expect((await outbox(row.id)).providerRfcMessageId).toBeNull();
    expect((await outbox(row.id)).ciphertext).not.toBeNull();
  });

  it("rejects spoofed/out-of-attempt evidence and binds exact source, envelope, count, account and region", async () => {
    const { row, send } = await unknown();
    const handle = handler();
    const valid = notification(row.id, row.attemptId!);
    const original = valid.event as { eventType: string; mail: Record<string, unknown> };
    const badMail = [
      { ...original.mail, source: "person@foreign.invalid" },
      { ...original.mail, source: "Name <person@evidence.invalid>" },
      { ...original.mail, destination: ["recipient@example.invalid"] },
      { ...original.mail, destination: ["recipient@example.invalid", "different@example.invalid"] },
      { ...original.mail, destination: ["recipient@example.invalid", "recipient@example.invalid"] },
      { ...original.mail, sendingAccountId: "999999999999" },
      { ...original.mail, messageId: "ses-id\r\ninjected" },
      {
        ...original.mail,
        tags: { mepmail_outbox_id: [row.id], mepmail_attempt_id: [randomUUID()] },
      },
      {
        ...original.mail,
        tags: { mepmail_outbox_id: [randomUUID()], mepmail_attempt_id: [row.attemptId] },
      },
      {
        ...original.mail,
        tags: { mepmail_outbox_id: [row.id, row.id], mepmail_attempt_id: [row.attemptId] },
      },
      {
        ...original.mail,
        tags: { mepmail_outbox_id: [row.id], mepmail_attempt_id: ["not-an-uuid"] },
      },
      { ...original.mail, tags: { mepmail_outbox_id: [row.id] } },
    ];
    for (const mail of badMail) {
      const event = { ...original, mail };
      expect(isPrivateMailboxEvent(event)).toBe(true);
      await expect(handle({ ...valid, event })).rejects.toThrow("evidence");
    }
    await expect(handle({ ...valid, topicArn: westTopic })).rejects.toThrow("evidence");
    await expect(
      handle({ ...valid, topicArn: "arn:aws:sns:us-east-1:123456789012:untrusted" }),
    ).rejects.toThrow("topic");
    expect((await outbox(row.id)).status).toBe("unknown");
    expect((await outbox(row.id)).ciphertext).not.toBeNull();
    expect(
      (await db.select().from(schema.mailboxItems)).filter((item) => item.kind === "sent"),
    ).toHaveLength(0);
    expect((await sendMailboxOutbox(db, keys, row.id, { send }, mailboxWorkerMime)).status).toBe(
      "unknown",
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("holds private events when disabled, rejects unclaimed rows, and rejects a conflicting provider ID after acceptance", async () => {
    const queued = await queue();
    const input = notification(queued.id, randomUUID());
    await expect(handler()(input)).rejects.toThrow("evidence");
    await expect(handler(false)(input)).rejects.toThrow("disabled");
    expect((await outbox(queued.id)).status).toBe("queued");
    const { row } = await unknown();
    await handler()(notification(row.id, row.attemptId!));
    await expect(
      handler()(notification(row.id, row.attemptId!, "conflicting-provider-id")),
    ).rejects.toThrow("evidence");
    expect((await outbox(row.id)).providerMessageId).toBe("ses-private-accepted-1");
    expect(
      await handler()({
        topicArn,
        snsMessageId: randomUUID(),
        event: { eventType: "Send", mail: { tags: { mepmail_email_id: [randomUUID()] } } },
      }),
    ).toBe(false);
  });

  it("records provider acceptance after subscription suspension without allowing an automatic resend", async () => {
    const { row, send } = await unknown();
    await db
      .update(schema.mailboxSubscriptions)
      .set({ status: "canceled" })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    await db
      .update(schema.teams)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.teams.id, teamId));
    const input = notification(row.id, row.attemptId!);
    input.event = {
      ...(input.event as Record<string, unknown>),
      eventType: "Reject",
      reject: { reason: "synthetic rejection" },
    };
    expect(await handler()(input)).toBe(true);
    expect((await outbox(row.id)).status).toBe("accepted");
    expect(send).toHaveBeenCalledTimes(1);
  });
});
