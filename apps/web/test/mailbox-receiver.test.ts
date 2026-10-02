import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvKeyring, type Keyring } from "../../../packages/core/src/crypto/keyring.js";
import { readMailboxItem } from "../../../packages/core/src/mailbox-private-store.js";
import { createMailboxRegistry } from "../../../packages/core/src/mailbox-registry.js";
import { createMailboxPrivateObjectReader } from "../../../packages/ses/src/mailbox-storage.js";
import { mailboxWorkerMime } from "../../worker/src/mailbox-sender.js";
import {
  createMailboxReceiver,
  type TrustedMailboxNotification,
} from "../../worker/src/mailbox-receiver.js";

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
    for (const path of [base, extension])
      for (const name of readdirSync(path)
        .filter((n) => n.endsWith(".sql") && (path !== base || n.slice(0, 4) <= "0042"))
        .sort())
        for (const statement of readFileSync(path + name, "utf8")
          .split("--> statement-breakpoint")
          .filter((s) => s.trim()))
          await client.exec(statement);
    db = drizzle(client, { schema }) as unknown as Db;
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
  const reader = () => {
    const send = vi.fn(async (_command: StorageCommand) => ({
      Body: Readable.from([raw.subarray(0, 40), raw.subarray(40)]),
      ContentLength: raw.length,
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
      Range: "bytes=0-1048576",
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
    for (const status of ["FAIL", "GRAY", "PROCESSING_FAILED", undefined])
      await expect(
        handle(
          notification({ ...event(), receipt: { ...event().receipt, virusVerdict: { status } } }),
        ),
      ).rejects.toThrow("receipt");
    expect(captured.send).not.toHaveBeenCalled();
    expect(await db.select().from(schema.mailboxItems)).toHaveLength(0);
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
