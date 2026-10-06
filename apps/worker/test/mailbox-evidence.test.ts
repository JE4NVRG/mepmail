import { createHash, randomUUID } from "node:crypto";
import type { Keyring } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mailboxRecipientHash } from "../../../packages/core/src/mailbox-transport.js";
import { createMailboxEvidenceHandler, isPrivateMailboxEvent } from "../src/mailbox-evidence.js";
import type { TrustedMailboxNotification } from "../src/mailbox-receiver.js";

const mocked = vi.hoisted(() => ({ accept: vi.fn(), decrypt: vi.fn() }));
vi.mock("@millionsend/core", async () => {
  const transport = await import("../../../packages/core/src/mailbox-transport.js");
  const sender = await import("../../../packages/core/src/sender-address.js");
  return {
    acceptMailboxOutbox: mocked.accept,
    decryptPayload: mocked.decrypt,
    BOUND_ENVELOPE_VERSION_OFFSET: 2000000,
    mailboxRecipientHash: transport.mailboxRecipientHash,
    parseMailbox: sender.parseMailbox,
    receiveMailboxMime: vi.fn(),
  };
});

const topicArn = "arn:aws:sns:us-east-1:123456789012:private-fixture";
const teamId = "11111111-1111-4111-8111-111111111111";
const mailboxId = "22222222-2222-4222-8222-222222222222";
const outboxId = "33333333-3333-4333-8333-333333333333";
const attemptId = "44444444-4444-4444-8444-444444444444";
const timestamp = "2026-10-04T12:00:00.000Z";
const from = "owner@fixture.invalid";
const destinations = ["one@example.invalid", "two@example.invalid"];
const raw = Buffer.from(
  `From: ${from}\r\nTo: ${destinations.join(", ")}\r\nSubject: PRIVATE SUBJECT\r\nMessage-ID: <submitted@fixture.invalid>\r\n\r\nPRIVATE BODY`,
);

function fixture() {
  const outbox = {
    id: outboxId,
    teamId,
    mailboxId,
    attemptId,
    status: "unknown",
    recipientCount: 2,
    recipientHashes: destinations
      .map((recipient) => mailboxRecipientHash(teamId, recipient))
      .sort(),
    providerMessageId: null,
    ciphertext: Buffer.alloc(32),
    iv: Buffer.alloc(12),
    wrappedDek: Buffer.alloc(32),
    keyVersion: 2000001,
    rawBytes: raw.length,
    rawSha256: createHash("sha256").update(raw).digest("hex"),
  };
  const bound = { outbox, address: from, region: "us-east-1" };
  const chain = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(async () => [bound]),
  };
  const db = { select: vi.fn(() => chain) } as unknown as Db;
  const mime = { parse: vi.fn(async () => ({ from, to: [...destinations], attachmentBytes: [] })) };
  const handler = createMailboxEvidenceHandler({
    db,
    keys: {} as Keyring,
    mime,
    enabled: true,
    topics: [topicArn],
  });
  const notification = (
    eventType: string,
    section: Record<string, unknown> = {},
  ): TrustedMailboxNotification => ({
    topicArn,
    snsMessageId: randomUUID(),
    event: {
      eventType,
      mail: {
        source: from,
        destination: [...destinations],
        messageId: "SES-bare-id",
        sendingAccountId: "123456789012",
        timestamp,
        tags: { mepmail_outbox_id: [outboxId], mepmail_attempt_id: [attemptId] },
        headers: [{ name: "Message-ID", value: "<submitted@fixture.invalid>" }],
        commonHeaders: { messageId: "SES-bare-id" },
      },
      ...section,
    },
  });
  return { outbox, bound, db, mime, handler, notification };
}

beforeEach(() => {
  mocked.accept.mockReset();
  mocked.decrypt.mockReset().mockResolvedValue(raw);
});

describe("private trusted SNS outcome boundary", () => {
  it.each([
    ["Send", { send: {} }, "send", destinations],
    [
      "Delivery",
      { delivery: { timestamp, recipients: [destinations[0]] } },
      "delivered",
      [destinations[0]],
    ],
    [
      "DeliveryDelay",
      {
        deliveryDelay: {
          timestamp,
          delayedRecipients: [
            { emailAddress: destinations[1], diagnosticCode: "PRIVATE DIAGNOSTIC" },
          ],
        },
      },
      "delayed",
      [destinations[1]],
    ],
    [
      "Bounce",
      {
        bounce: {
          timestamp,
          bounceType: "Permanent",
          bouncedRecipients: [{ emailAddress: destinations[0] }],
        },
      },
      "hard_bounce",
      [destinations[0]],
    ],
    [
      "Bounce",
      {
        bounce: {
          timestamp,
          bounceType: "Transient",
          bouncedRecipients: [{ emailAddress: destinations[0] }],
        },
      },
      "soft_bounce",
      [destinations[0]],
    ],
    [
      "Bounce",
      {
        bounce: {
          timestamp,
          bounceType: "Undetermined",
          bouncedRecipients: [{ emailAddress: destinations[0] }],
        },
      },
      "undetermined_bounce",
      [destinations[0]],
    ],
    [
      "Complaint",
      { complaint: { timestamp, complainedRecipients: [{ emailAddress: destinations[1] }] } },
      "complaint",
      [destinations[1]],
    ],
    ["Reject", { reject: { reason: "PRIVATE REJECTION" } }, "rejected", destinations],
    [
      "Rendering Failure",
      { failure: { errorMessage: "PRIVATE TEMPLATE" } },
      "rendering_failed",
      destinations,
    ],
  ])(
    "commits only allowlisted %s facts and hashes before ACK",
    async (eventType, section, outcome, selected) => {
      const f = fixture();
      let release!: () => void;
      mocked.accept.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      let completed = false;
      const input = f.notification(eventType, section);
      const promise = f.handler(input).then((result) => {
        completed = true;
        return result;
      });
      await vi.waitFor(() => expect(mocked.accept).toHaveBeenCalledTimes(1));
      expect(completed).toBe(false);
      const evidence = mocked.accept.mock.calls[0]![2];
      expect(evidence).toMatchObject({
        attemptId,
        messageId: "SES-bare-id",
        outboundEvidence: {
          topicArn,
          snsMessageId: input.snsMessageId,
          outcome,
          recipientHashes: selected
            .map((recipient) => mailboxRecipientHash(teamId, recipient!))
            .sort(),
          approvedRecipientHashes: destinations
            .map((recipient) => mailboxRecipientHash(teamId, recipient))
            .sort(),
          occurredAt: new Date(timestamp),
        },
      });
      const safe = JSON.stringify(evidence);
      expect(safe).not.toContain("PRIVATE");
      expect(safe).not.toContain("one@example.invalid");
      expect(safe).not.toContain("two@example.invalid");
      expect(evidence.rfcMessageId).toBeUndefined();
      release();
      expect(await promise).toBe(true);
    },
  );

  it("does not ACK a failed commit and never routes malformed private tags to Envio", async () => {
    const f = fixture();
    mocked.accept.mockRejectedValue(new Error("synthetic_commit_failure"));
    await expect(f.handler(f.notification("Send", { send: {} }))).rejects.toThrow(
      "synthetic_commit_failure",
    );
    const invalid = f.notification("Send", { send: {} });
    const event = invalid.event as { mail: { tags: Record<string, unknown> } };
    event.mail.tags.mepmail_attempt_id = ["invalid"];
    expect(isPrivateMailboxEvent(invalid.event)).toBe(true);
    await expect(f.handler(invalid)).rejects.toThrow("mailbox_provider_evidence");
    expect(mocked.accept).toHaveBeenCalledTimes(1);
    expect(
      await f.handler({ topicArn, snsMessageId: randomUUID(), event: { eventType: "Delivery" } }),
    ).toBe(false);
  });

  it.each([
    ["Delivery", { delivery: { timestamp, recipients: ["alien@example.invalid"] } }],
    [
      "Bounce",
      {
        bounce: {
          timestamp,
          bounceType: "FutureStatus",
          bouncedRecipients: [{ emailAddress: destinations[0] }],
        },
      },
    ],
    [
      "DeliveryDelay",
      {
        deliveryDelay: {
          timestamp,
          delayedRecipients: [{ emailAddress: destinations[0] }, { emailAddress: destinations[0] }],
        },
      },
    ],
    ["Delivery", { delivery: { timestamp: "invalid", recipients: destinations } }],
    ["FutureEvent", {}],
  ])(
    "refuses ambiguous/foreign %s facts without recording or replaying",
    async (eventType, section) => {
      const f = fixture();
      await expect(f.handler(f.notification(eventType, section))).rejects.toThrow(
        "mailbox_provider_evidence",
      );
      expect(mocked.accept).not.toHaveBeenCalled();
    },
  );

  it("requires the trusted topic/account/region/exact attempt and captured envelope", async () => {
    const f = fixture();
    const input = f.notification("Send", { send: {} });
    await expect(
      f.handler({ ...input, topicArn: "arn:aws:sns:us-east-1:999999999999:foreign" }),
    ).rejects.toThrow("mailbox_provider_topic");
    f.bound.region = "eu-west-1";
    await expect(f.handler(input)).rejects.toThrow("mailbox_provider_evidence");
    f.bound.region = "us-east-1";
    f.outbox.attemptId = randomUUID();
    await expect(f.handler(input)).rejects.toThrow("mailbox_provider_evidence");
    f.outbox.attemptId = attemptId;
    f.mime.parse.mockResolvedValue({ from, to: ["changed@example.invalid"], attachmentBytes: [] });
    await expect(f.handler(input)).rejects.toThrow("mailbox_provider_evidence");
    expect(mocked.accept).not.toHaveBeenCalled();
  });

  it("never derives RFC from SES ID or submitted/legacy headers; observed complete RFC stays distinct", async () => {
    const f = fixture();
    const input = f.notification("Send", { send: {} });
    const event = input.event as {
      eventType?: string;
      notificationType?: string;
      mail: { commonHeaders: { messageId: string } };
    };
    event.mail.commonHeaders.messageId = "<submitted@fixture.invalid>";
    await f.handler(input);
    expect(mocked.accept.mock.calls[0]![2].rfcMessageId).toBeUndefined();
    event.notificationType = "Send";
    delete event.eventType;
    event.mail.commonHeaders.messageId = "<final@ses-fixture.invalid>";
    await f.handler(input);
    expect(mocked.accept.mock.calls[1]![2].rfcMessageId).toBeUndefined();
    event.eventType = "Send";
    await f.handler(input);
    expect(mocked.accept.mock.calls[2]![2].rfcMessageId).toBe("<final@ses-fixture.invalid>");
  });
});
