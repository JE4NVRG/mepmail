import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvKeyring, type Keyring } from "../../../packages/core/src/crypto/keyring.js";
import { readMailboxItem } from "../../../packages/core/src/mailbox-private-store.js";
import { createMailboxRegistry } from "../../../packages/core/src/mailbox-registry.js";
import { createMailboxPrivateObjectReader } from "../../../packages/ses/src/mailbox-storage.js";
import {
  createMailboxReceiver,
  type TrustedMailboxNotification,
} from "../../worker/src/mailbox-receiver.js";
import { mailboxWorkerMime } from "../../worker/src/mailbox-sender.js";

const topicArn = "arn:aws:sns:us-east-1:123456789012:private-receipts";
const location = {
  bucket: "private-mailbox-fixture",
  prefix: "receipts/",
  ownerAccountId: "123456789012",
};
type StorageFactory = NonNullable<
  Parameters<typeof createMailboxPrivateObjectReader>[0]["clientFactory"]
>;
type StorageCommand = Parameters<ReturnType<StorageFactory>["send"]>[0];
type StorageConfig = Parameters<StorageFactory>[0];
const raw = Buffer.from(
  "From: outside@example.invalid\r\nTo: deliberately-wrong@example.invalid\r\nSubject: Private fixture\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=test\r\n\r\n--test\r\nContent-Type: text/plain\r\n\r\nprivate received body\r\n--test\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=private.bin\r\nContent-Transfer-Encoding: base64\r\n\r\ncHJpdmF0ZS1hdHRhY2htZW50\r\n--test--\r\n",
);
const event = (recipients = ["person@receiver.invalid", "other@foreign.invalid"]) => ({
  notificationType: "Received",
  mail: {
    messageId: "stable-provider-receipt-1",
    destination: ["deliberately-wrong@example.invalid"],
  },
  receipt: {
    recipients,
    virusVerdict: { status: "PASS" },
    spamVerdict: { status: "PASS" },
    spfVerdict: { status: "PASS" },
    dkimVerdict: { status: "PASS" },
    dmarcVerdict: { status: "PASS" },
    dmarcPolicy: "none",
    action: {
      type: "S3",
      bucketName: location.bucket,
      objectKey: "receipts/stable-provider-receipt-1",
      topicArn,
    },
  },
});
const notification = (value: unknown = event()): TrustedMailboxNotification => ({
  topicArn,
  snsMessageId: randomUUID(),
  event: value,
});

describe("trusted private SES receipt adapter with real encrypted persistence", () => {
  let client: PGlite,
    db: Db,
    keys: Keyring,
    teamId: string,
    foreignTeamId: string,
    mailboxId: string;
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
    const teams = await db
      .insert(schema.teams)
      .values([
        { name: "Receipt", slug: "receipt" },
        { name: "Foreign", slug: "receipt-foreign" },
      ])
      .returning();
    teamId = teams[0]!.id;
    foreignTeamId = teams[1]!.id;
    await db.insert(schema.user).values([
      { id: "owner", name: "Owner", email: "owner@example.invalid", emailVerified: true },
      { id: "foreign", name: "Foreign", email: "foreign@example.invalid", emailVerified: true },
    ]);
    await db.insert(schema.teamMembers).values([
      { teamId, userId: "owner", role: "owner" },
      { teamId: foreignTeamId, userId: "foreign", role: "owner" },
    ]);
    await db.insert(schema.mailboxSubscriptions).values(
      [teamId, foreignTeamId].map((id) => ({
        teamId: id,
        status: "active" as const,
        seats: 2,
        storageBytesPerMailbox: 2 * 1024 * 1024,
        includedOutboundPerMailbox: 10,
        periodStart: new Date(Date.now() - 86400000),
        periodEnd: new Date(Date.now() + 86400000),
      })),
    );
    const domains = await db
      .insert(schema.domains)
      .values([
        { teamId, name: "receiver.invalid", status: "verified", region: "us-east-1" },
        { teamId: foreignTeamId, name: "foreign.invalid", status: "verified", region: "us-east-1" },
      ])
      .returning();
    mailboxId = (
      await createMailboxRegistry(
        db,
        { teamId, userId: "owner" },
        {
          domainId: domains[0]!.id,
          localPart: "person",
          label: "Person",
          kind: "person",
          ownerUserId: "owner",
        },
      )
    ).id;
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
    );
  });
  afterEach(async () => {
    await client.close();
  });
  const reader = (bytes = raw) => {
    const send = vi.fn(async (_command: StorageCommand) => ({
      Body: Readable.from([bytes.subarray(0, 40), bytes.subarray(40)]),
      ContentLength: bytes.length,
    }));
    return {
      send,
      objectReader: createMailboxPrivateObjectReader({
        region: "us-east-1",
        locations: [location],
        clientFactory: () => ({ send }),
      }),
    };
  };

  it("receives a 3 MiB message with a 2 MiB attachment, which the 1 MiB pilot cap refused", async () => {
    const attachment = Buffer.alloc(2 * 1024 * 1024, 0x61)
      .toString("base64")
      .replace(/.{76}/g, "$&\r\n");
    const large = Buffer.from(
      `From: outside@example.invalid\r\nTo: person@receiver.invalid\r\nSubject: Large fixture\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=big\r\n\r\n--big\r\nContent-Type: text/plain\r\n\r\nsee the attached report\r\n--big\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=report.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n${attachment}\r\n--big--\r\n`,
    );
    expect(large.length).toBeGreaterThan(2 * 1024 * 1024);
    // The fixture plan is tiny; a real one has gigabytes.
    await db.update(schema.mailboxSubscriptions).set({ storageBytesPerMailbox: 1024 ** 3 });
    const handle = createMailboxReceiver({
      db,
      keys,
      mime: mailboxWorkerMime,
      reader: reader(large).objectReader,
      enabled: true,
      topics: [topicArn],
      locations: [location],
    });
    expect(await handle(notification(event(["person@receiver.invalid"])))).toBe(true);
    const [item] = await db.select().from(schema.mailboxItems);
    expect(item?.rawBytes).toBe(large.length);
    expect(item?.ciphertext.includes(Buffer.from("see the attached report"))).toBe(false);
  });

  it("arms the mailbox.received drain after commit and never fails the receipt over it", async () => {
    const agent = await createMailboxRegistry(
      db,
      { teamId, userId: "owner" },
      {
        domainId: (
          await db.select().from(schema.domains).where(eq(schema.domains.teamId, teamId))
        )[0]!.id,
        localPart: "agent",
        label: "Agent",
        kind: "agent",
        ownerUserId: "owner",
      },
    );
    const [hook] = await db
      .insert(schema.webhookEndpoints)
      .values({
        teamId,
        url: "https://hooks.example.invalid/correio",
        secretCiphertext: Buffer.alloc(1),
        secretIv: Buffer.alloc(1),
        secretWrappedDek: Buffer.alloc(1),
        secretKeyVersion: 1,
        secretLast4: "abcd",
        events: ["mailbox.received"],
      })
      .returning({ id: schema.webhookEndpoints.id });
    const enqueueWebhook = vi.fn(async () => {});
    const handle = createMailboxReceiver({
      db,
      keys,
      mime: mailboxWorkerMime,
      reader: reader().objectReader,
      enabled: true,
      topics: [topicArn],
      locations: [location],
      enqueueWebhook,
    });
    expect(await handle(notification(event(["agent@receiver.invalid"])))).toBe(true);
    expect(enqueueWebhook).toHaveBeenCalledTimes(1);
    expect(enqueueWebhook.mock.calls[0]).toEqual([
      [{ id: expect.any(String), endpointId: hook!.id }],
    ]);
    const [delivery] = await db.select().from(schema.webhookDeliveries);
    expect(delivery?.payload).toMatchObject({
      type: "mailbox.received",
      data: { mailbox_id: agent.id, mailbox: "agent@receiver.invalid" },
    });
    // The SNS retry is a duplicate: nothing new to arm.
    expect(await handle(notification(event(["agent@receiver.invalid"])))).toBe(true);
    expect(enqueueWebhook).toHaveBeenCalledTimes(1);
    // A person mailbox never produces the event; a queue failure leaves the row for reconcile.
    const failing = vi.fn(async () => {
      throw new Error("queue down");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const second = createMailboxReceiver({
      db,
      keys,
      mime: mailboxWorkerMime,
      reader: reader().objectReader,
      enabled: true,
      topics: [topicArn],
      locations: [location],
      enqueueWebhook: failing,
    });
    expect(await second(notification(event(["person@receiver.invalid"])))).toBe(true);
    expect(failing).not.toHaveBeenCalled();
    const next = event(["agent@receiver.invalid"]);
    next.mail.messageId = "stable-provider-receipt-2";
    next.receipt.action.objectKey = "receipts/stable-provider-receipt-2";
    expect(await second(notification(next))).toBe(true);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.webhookDeliveries)).toHaveLength(2);
    warn.mockRestore();
  });

  it("routes receipt RCPT across teams, preserves private attachment and deduplicates SNS retries", async () => {
    const captured = reader();
    const handle = createMailboxReceiver({
      db,
      keys,
      mime: mailboxWorkerMime,
      reader: captured.objectReader,
      enabled: true,
      topics: [topicArn],
      locations: [location],
    });
    expect(await handle(notification())).toBe(true);
    expect(
      await handle(notification(event(["other@foreign.invalid", "person@receiver.invalid"]))),
    ).toBe(true);
    const items = await db.select().from(schema.mailboxItems);
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.deliveryFolder === "inbox")).toBe(true);
    expect(items.every((item) => item.inboundAssessment?.decision === "inbox")).toBe(true);
    const item = items.find((i) => i.mailboxId === mailboxId)!;
    expect(item.ciphertext.includes(Buffer.from("private received body"))).toBe(false);
    expect(
      (
        await readMailboxItem(db, keys, { teamId, userId: "owner" }, { mailboxId, id: item.id })
      ).raw.equals(raw),
    ).toBe(true);
    expect(captured.send.mock.calls[0]![0].input).toMatchObject({
      Bucket: location.bucket,
      Key: "receipts/stable-provider-receipt-1",
      ExpectedBucketOwner: location.ownerAccountId,
      Range: "bytes=0-26214400",
    });
    expect(await db.select().from(schema.emails)).toHaveLength(0);
  });

  it("retains malformed/foreign/disabled receipts before S3 access and ignores unrelated Send", async () => {
    const captured = reader();
    const config = {
      db,
      keys,
      mime: mailboxWorkerMime,
      reader: captured.objectReader,
      enabled: true,
      topics: [topicArn],
      locations: [location],
    };
    const handle = createMailboxReceiver(config);
    expect(await handle(notification({ eventType: "Send" }))).toBe(false);
    await expect(
      createMailboxReceiver({ ...config, enabled: false })(notification()),
    ).rejects.toThrow("disabled");
    await expect(
      handle({ ...notification(), topicArn: "arn:aws:sns:us-east-1:123456789012:untrusted" }),
    ).rejects.toThrow("topic");
    await expect(handle({ event: event() } as TrustedMailboxNotification)).rejects.toThrow("topic");
    for (const action of [
      { ...event().receipt.action, bucketName: "public-assets" },
      { ...event().receipt.action, objectKey: "receipts-other/stable-provider-receipt-1" },
      { ...event().receipt.action, objectKey: "receipts/../stable-provider-receipt-1" },
      { ...event().receipt.action, objectKey: "receipts/different-message" },
      { ...event().receipt.action, type: "SNS" },
    ])
      await expect(
        handle(notification({ ...event(), receipt: { ...event().receipt, action } })),
      ).rejects.toThrow();
    expect(captured.send).not.toHaveBeenCalled();
    expect(await db.select().from(schema.mailboxItems)).toHaveLength(0);
  });

  it("stores unsafe virus results in private quarantine without parsing the MIME", async () => {
    const forgedRaw = Buffer.concat([Buffer.from("X-SES-Virus-Verdict: PASS\r\n"), raw]);
    const captured = reader(forgedRaw);
    const parse = vi.fn(mailboxWorkerMime.parse);
    const handle = createMailboxReceiver({
      db,
      keys,
      mime: { ...mailboxWorkerMime, parse },
      reader: captured.objectReader,
      enabled: true,
      topics: [topicArn],
      locations: [location],
    });
    for (const [index, status] of ["FAIL", "GRAY", "PROCESSING_FAILED", undefined].entries()) {
      const received = event(["person@receiver.invalid"]);
      const messageId = `virus-fixture-${index}`;
      const value = {
        ...received,
        mail: { ...received.mail, messageId },
        receipt: {
          ...received.receipt,
          virusVerdict: { status },
          action: { ...received.receipt.action, objectKey: `${location.prefix}${messageId}` },
        },
      };
      expect(await handle(notification(value))).toBe(true);
      expect(await handle(notification(value))).toBe(true);
    }
    expect(parse).not.toHaveBeenCalled();
    const items = await db.select().from(schema.mailboxItems);
    expect(items).toHaveLength(4);
    for (const item of items) {
      expect(item).toMatchObject({ mailboxId, deliveryFolder: "quarantine" });
      expect(item.inboundAssessment?.decision).toBe("quarantine");
      expect(item.ciphertext.includes(Buffer.from("private received body"))).toBe(false);
      await expect(
        readMailboxItem(db, keys, { teamId, userId: "owner" }, { mailboxId, id: item.id }),
      ).rejects.toThrow();
    }
  });

  it("classifies trusted spam findings per RCPT mailbox despite forged clean MIME headers", async () => {
    const forgedRaw = Buffer.concat([Buffer.from("X-SES-Spam-Verdict: PASS\r\n"), raw]);
    const captured = reader(forgedRaw);
    const handle = createMailboxReceiver({
      db,
      keys,
      mime: mailboxWorkerMime,
      reader: captured.objectReader,
      enabled: true,
      topics: [topicArn],
      locations: [location],
    });
    const statuses = ["FAIL", "GRAY", "PROCESSING_FAILED", undefined];
    for (const [index, status] of statuses.entries()) {
      const received = event();
      const messageId = `spam-fixture-${index}`;
      const value = {
        ...received,
        mail: { ...received.mail, messageId },
        receipt: {
          ...received.receipt,
          spamVerdict: { status },
          action: { ...received.receipt.action, objectKey: `${location.prefix}${messageId}` },
        },
      };
      expect(await handle(notification(value))).toBe(true);
      expect(await handle(notification(value))).toBe(true);
    }
    const items = await db.select().from(schema.mailboxItems);
    expect(items).toHaveLength(8);
    expect(items.filter((item) => item.teamId === teamId)).toHaveLength(4);
    expect(items.filter((item) => item.teamId === foreignTeamId)).toHaveLength(4);
    for (const item of items) {
      expect(item.deliveryFolder).toBe("spam");
      expect(item.inboundAssessment?.decision).toBe("spam");
    }
    const ownItems = items.filter((item) => item.mailboxId === mailboxId);
    expect(ownItems.map((item) => item.inboundAssessment?.verdicts.spam).sort()).toEqual(
      ["FAIL", "GRAY", "PROCESSING_FAILED", "UNKNOWN"].sort(),
    );
    const item = ownItems[0];
    if (!item) throw new Error("missing own spam fixture");
    expect(
      (await readMailboxItem(db, keys, { teamId, userId: "owner" }, { mailboxId, id: item.id }))
        .raw,
    ).toEqual(forgedRaw);
  });

  it("does not acknowledge S3 read or encryption failure, including a quarantined receipt", async () => {
    const received = event(["person@receiver.invalid"]);
    const unsafe = {
      ...received,
      receipt: { ...received.receipt, virusVerdict: { status: "FAIL" } },
    };
    const captured = reader();
    const config = {
      db,
      keys,
      mime: mailboxWorkerMime,
      reader: captured.objectReader,
      enabled: true,
      topics: [topicArn],
      locations: [location],
    };
    await expect(
      createMailboxReceiver({
        ...config,
        reader: {
          read: vi.fn(async () => {
            throw new Error("fixture_s3_failure");
          }),
        },
      })(notification(unsafe)),
    ).rejects.toThrow("fixture_s3_failure");
    const unavailableKeys: Keyring = {
      async wrapDek() {
        throw new Error("fixture_key_failure");
      },
      async unwrapDek() {
        throw new Error("fixture_key_failure");
      },
    };
    await expect(
      createMailboxReceiver({ ...config, keys: unavailableKeys })(notification(unsafe)),
    ).rejects.toThrow("fixture_key_failure");
    expect(await db.select().from(schema.mailboxItems)).toHaveLength(0);
  });

  it("captures receipt identity and assessment before asynchronous storage access", async () => {
    const received = event(["person@receiver.invalid"]);
    const handle = createMailboxReceiver({
      db,
      keys,
      mime: mailboxWorkerMime,
      reader: {
        async read() {
          received.mail.messageId = "changed-after-read";
          received.receipt.action.objectKey = "receipts/changed-after-read";
          received.receipt.virusVerdict.status = "FAIL";
          return raw;
        },
      },
      enabled: true,
      topics: [topicArn],
      locations: [location],
    });
    expect(await handle(notification(received))).toBe(true);
    expect(await handle(notification(event(["person@receiver.invalid"])))).toBe(true);
    const items = await db.select().from(schema.mailboxItems);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      deliveryFolder: "inbox",
      inboundAssessment: { decision: "inbox" },
    });
  });

  it("does not acknowledge quota/routing failures or partial cross-team fanout", async () => {
    const captured = reader();
    const handle = createMailboxReceiver({
      db,
      keys,
      mime: mailboxWorkerMime,
      reader: captured.objectReader,
      enabled: true,
      topics: [topicArn],
      locations: [location],
    });
    await expect(
      handle(notification(event(["person@receiver.invalid", "missing@foreign.invalid"]))),
    ).rejects.toThrow();
    expect(await db.select().from(schema.mailboxItems)).toHaveLength(0);
    await db
      .update(schema.mailboxSubscriptions)
      .set({ storageBytesPerMailbox: raw.length - 1 })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    await expect(handle(notification())).rejects.toThrow();
    expect(await db.select().from(schema.mailboxItems)).toHaveLength(0);
  });
});

describe("private bounded S3 SDK adapter", () => {
  it("uses the normal AWS client, explicit owner and rejects locations before SDK creation", async () => {
    const factory = vi.fn((_config: StorageConfig) => ({
      send: vi.fn(async (_command: StorageCommand) => ({
        Body: Readable.from([Buffer.from("mime")]),
        ContentLength: 4,
      })),
    }));
    const reader = createMailboxPrivateObjectReader({
      region: "us-east-1",
      locations: [location],
      maxBytes: 8,
      clientFactory: factory,
    });
    await expect(reader.read({ bucket: "public-assets", key: "receipts/a" })).rejects.toThrow(
      "location",
    );
    await expect(reader.read({ bucket: location.bucket, key: "receipts-other/a" })).rejects.toThrow(
      "location",
    );
    await expect(reader.read({ bucket: location.bucket, key: "receipts/../a" })).rejects.toThrow(
      "location",
    );
    expect(factory).not.toHaveBeenCalled();
    expect((await reader.read({ bucket: location.bucket, key: "receipts/a" })).toString()).toBe(
      "mime",
    );
    expect(factory.mock.calls[0]![0]).toMatchObject({
      region: "us-east-1",
      maxAttempts: 1,
      ignoreConfiguredEndpointUrls: true,
    });
    expect(factory.mock.calls[0]![0]).not.toHaveProperty("endpoint");
  });

  it("checks actual streamed size, not only claimed metadata, and destroys oversize body", async () => {
    const body = Readable.from([Buffer.alloc(4), Buffer.alloc(5)]);
    const destroy = vi.spyOn(body, "destroy");
    const reader = createMailboxPrivateObjectReader({
      region: "us-east-1",
      locations: [location],
      maxBytes: 8,
      clientFactory: () => ({ send: async () => ({ Body: body, ContentLength: 4 }) }),
    });
    await expect(reader.read({ bucket: location.bucket, key: "receipts/a" })).rejects.toThrow(
      "size",
    );
    expect(destroy).toHaveBeenCalled();
  });

  it("rejects large range totals, truncated bodies and unsupported SES client-side encryption", async () => {
    for (const result of [
      { Body: Readable.from([Buffer.alloc(9)]), ContentLength: 9 },
      { Body: Readable.from([Buffer.alloc(8)]), ContentRange: "bytes 0-7/100" },
      { Body: Readable.from([Buffer.alloc(3)]), ContentLength: 4 },
      { Body: Readable.from([]) },
      {
        Body: Readable.from([Buffer.from("mime")]),
        Metadata: { "x-amz-key-v2": "unsupported-client-encryption" },
      },
    ]) {
      const reader = createMailboxPrivateObjectReader({
        region: "us-east-1",
        locations: [location],
        maxBytes: 8,
        clientFactory: () => ({ send: async () => result }),
      });
      await expect(reader.read({ bucket: location.bucket, key: "receipts/a" })).rejects.toThrow();
    }
    expect(() =>
      createMailboxPrivateObjectReader({
        region: "us-east-1",
        locations: [{ ...location, prefix: "" }],
        maxBytes: 8,
      }),
    ).toThrow("configuration");
  });
});
