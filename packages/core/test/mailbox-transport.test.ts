import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAbuseJudge, judgeForEmail } from "../../../apps/worker/src/abuse-judge/index.js";
import { createMailboxExternalAwareSender } from "../../../apps/worker/src/mailbox-external-sender.js";
import {
  createMailboxContentPolicySender,
  createMailboxSesSender,
} from "../../../apps/worker/src/mailbox-sender.js";
import { ABUSE_JUDGE_QUESTIONS } from "../src/abuse-judge/questions.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { reserveJudgeAttempt } from "../src/graduated-sending.js";
import { getGraduatedSendingContext } from "../src/graduated-sending-context.js";
import { createMailboxExternalAccount } from "../src/mailbox-external-accounts.js";
import { saveMailboxDraft } from "../src/mailbox-private-store.js";
import {
  MAILBOX_SEND_HOLD_REASONS,
  mailboxSendHold,
  mailboxSendHoldCode,
} from "../src/mailbox-send-hold.js";
import {
  acceptMailboxOutbox,
  checkMailboxRecipientBlocks,
  getMailboxOutboundSummary,
  type MailboxOutboundEvidence,
  type MailboxOutboxSender,
  MailboxSendDeferredError,
  type MailboxTransportMimeAdapter,
  mailboxBlockedRecipients,
  mailboxRecipientHash,
  queueMailboxDraft,
  sendMailboxOutbox,
} from "../src/mailbox-transport.js";
import { hashRecipient } from "../src/suppressions.js";

let client: PGlite;
let db: Db;
const keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
const topicArn = "arn:aws:sns:us-east-1:123456789012:private-fixture";
const mime: MailboxTransportMimeAdapter = {
  async parse(raw) {
    const headers = raw.toString("utf8").split("\r\n\r\n")[0]!;
    return {
      from: /^From: (.+)$/m.exec(headers)?.[1]?.trim() ?? "",
      to: /^To: (.+)$/m.exec(headers)?.[1]?.trim().split(", ") ?? [],
      attachmentBytes: [],
    };
  },
};

async function resetNativeFixtureDatabase() {
  client = new PGlite();
  const base = fileURLToPath(new URL("../../db/drizzle/", import.meta.url));
  const mail = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
  // Real main + Correio DDL, one transaction per migration (including LOCK TABLE).
  for (const path of [base, mail])
    for (const name of readdirSync(path)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await client.transaction(async (tx) => {
        for (const statement of readFileSync(path + name, "utf8")
          .split("--> statement-breakpoint")
          .filter((part) => part.trim()))
          await tx.exec(statement);
      });
  db = drizzle(client, { schema }) as unknown as Db;
}
beforeAll(resetNativeFixtureDatabase);
afterAll(async () => {
  await client.close();
});

async function setup() {
  const userId = randomUUID();
  const [team] = await db
    .insert(schema.teams)
    .values({ name: "Outcomes fixture", slug: userId })
    .returning();
  const teamId = team!.id;
  await db.insert(schema.user).values({
    id: userId,
    name: "Fixture",
    email: `${userId}@example.invalid`,
    emailVerified: true,
  });
  const [member] = await db
    .insert(schema.teamMembers)
    .values({ teamId, userId, role: "owner" })
    .returning();
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: `${userId}.invalid`, status: "verified", region: "us-east-1" })
    .returning();
  const from = `person@${domain!.name}`;
  const [box] = await db
    .insert(schema.mailboxes)
    .values({
      teamId,
      domainId: domain!.id,
      address: from,
      label: "Fixture",
      kind: "person",
      ownerUserId: userId,
      ownerMembershipId: member!.id,
    })
    .returning();
  const now = Date.now();
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "active",
    seats: 2,
    storageBytesPerMailbox: 1048576,
    includedOutboundPerMailbox: 100,
    periodStart: new Date(now - 86400000),
    periodEnd: new Date(now + 86400000),
  });
  const recipients = ["one@example.invalid", "two@example.invalid"];
  const raw = Buffer.from(
    `From: ${from}\r\nTo: ${recipients.join(", ")}\r\nSubject: PRIVATE-NOT-A-LEDGER-FIELD\r\nMessage-ID: <original@fixture.invalid>\r\n\r\nPRIVATE-CONTENT`,
  );
  const actor = { teamId, userId };
  const draft = () =>
    saveMailboxDraft(db, keys, actor, { mailboxId: box!.id, expectedRevision: 0, raw });
  const queued = async () => {
    const item = await draft();
    return queueMailboxDraft(
      db,
      keys,
      actor,
      { mailboxId: box!.id, id: item.id, expectedRevision: item.revision },
      mime,
    );
  };
  const outbox = await queued();
  await sendMailboxOutbox(
    db,
    keys,
    outbox.id,
    {
      async send() {
        throw new Error("synthetic_lost_ack");
      },
    },
    mime,
  );
  const row = (
    await db.select().from(schema.mailboxOutbox).where(eq(schema.mailboxOutbox.id, outbox.id))
  )[0]!;
  const snapshot = recipients.map((recipient) => mailboxRecipientHash(teamId, recipient)).sort();
  const evidence = (
    outcome: MailboxOutboundEvidence["outcome"],
    selected = recipients,
    snsMessageId = randomUUID(),
  ): MailboxOutboundEvidence => ({
    topicArn,
    snsMessageId,
    outcome,
    recipientHashes: selected.map((recipient) => mailboxRecipientHash(teamId, recipient)).sort(),
    approvedRecipientHashes: snapshot,
    occurredAt: new Date("2026-10-04T12:00:00Z"),
  });
  const record = (
    fact: MailboxOutboundEvidence,
    overrides: Partial<Parameters<typeof acceptMailboxOutbox>[2]> = {},
  ) =>
    acceptMailboxOutbox(db, row.id, {
      attemptId: row.attemptId!,
      messageId: `provider-${row.id}`,
      outboundEvidence: fact,
      ...overrides,
    });
  const summary = () =>
    getMailboxOutboundSummary(db, { teamId, mailboxId: box!.id, outboxId: row.id });
  return {
    teamId,
    mailboxId: box!.id,
    row,
    actor,
    raw,
    draft,
    queued,
    recipients,
    snapshot,
    evidence,
    record,
    summary,
  };
}

describe("private Correio outbound outcomes", () => {
  it("separates accepted from delivered and preserves an ambiguous attempt without resend", async () => {
    const f = await setup();
    await acceptMailboxOutbox(db, f.row.id, {
      attemptId: f.row.attemptId!,
      messageId: `provider-${f.row.id}`,
    });
    expect(await f.summary()).toMatchObject({ totalRecipients: 2, delivered: 0, unconfirmed: 2 });
    await f.record(f.evidence("send"));
    expect(await f.summary()).toMatchObject({ delivered: 0, unconfirmed: 2 });
    const send = vi.fn();
    await sendMailboxOutbox(db, keys, f.row.id, { send }, mime);
    expect(send).not.toHaveBeenCalled();
  });

  it("records one SNS event once, rejects a conflicting replay and commits the block atomically", async () => {
    const f = await setup();
    const fact = f.evidence("hard_bounce", [f.recipients[0]!]);
    await f.record(fact);
    await f.record(fact);
    await expect(f.record({ ...fact, outcome: "complaint" })).rejects.toThrow("conflict");
    const events = await db
      .select()
      .from(schema.mailboxOutboundEvents)
      .where(eq(schema.mailboxOutboundEvents.outboxId, f.row.id));
    expect(events).toHaveLength(1);
    expect(await f.summary()).toMatchObject({ hardBounce: 1, unconfirmed: 1 });
    expect(
      await checkMailboxRecipientBlocks(db, { teamId: f.teamId, recipients: [f.recipients[0]!] }),
    ).toBe(false);
    expect(
      await checkMailboxRecipientBlocks(db, { teamId: f.teamId, recipients: [f.recipients[1]!] }),
    ).toBe(true);
  });

  it("does not partially accept or backfill a legacy row when the SNS identity belongs to another outbox", async () => {
    const f = await setup();
    const first = f.evidence("delivered");
    await f.record(first);
    const other = await f.queued();
    await sendMailboxOutbox(
      db,
      keys,
      other.id,
      {
        async send() {
          throw new Error("synthetic_lost_ack");
        },
      },
      mime,
    );
    const row = (
      await db.select().from(schema.mailboxOutbox).where(eq(schema.mailboxOutbox.id, other.id))
    )[0]!;
    await db
      .update(schema.mailboxOutbox)
      .set({ recipientHashes: null })
      .where(eq(schema.mailboxOutbox.id, other.id));
    await expect(
      acceptMailboxOutbox(db, other.id, {
        attemptId: row.attemptId!,
        messageId: `provider-${other.id}`,
        outboundEvidence: first,
      }),
    ).rejects.toThrow("conflict");
    const after = (
      await db.select().from(schema.mailboxOutbox).where(eq(schema.mailboxOutbox.id, other.id))
    )[0]!;
    expect(after.status).toBe("unknown");
    expect(after.recipientHashes).toBeNull();
    expect(
      await db.select().from(schema.mailboxItems).where(eq(schema.mailboxItems.id, other.id)),
    ).toHaveLength(0);
  });

  it("ignores arrival order for delay/delivery, and complaint/hard bounce stay adverse", async () => {
    const f = await setup();
    await f.record(f.evidence("delivered"));
    await f.record({ ...f.evidence("delayed"), occurredAt: new Date("2026-10-03T12:00:00Z") });
    expect(await f.summary()).toMatchObject({ delivered: 2, delayed: 0, unconfirmed: 0 });
    await f.record(f.evidence("hard_bounce", [f.recipients[0]!]));
    await f.record(f.evidence("complaint", [f.recipients[0]!]));
    await f.record(f.evidence("hard_bounce", [f.recipients[0]!]));
    await f.record(f.evidence("delivered"));
    expect(await f.summary()).toMatchObject({
      complaint: 1,
      delivered: 1,
      hardBounce: 0,
      unconfirmed: 0,
    });
    const [block] = await db
      .select()
      .from(schema.mailboxRecipientBlocks)
      .where(eq(schema.mailboxRecipientBlocks.teamId, f.teamId));
    expect(block?.reason).toBe("complaint");
  });

  it("scopes blocks per team and prevents both new admission and a previously queued provider attempt", async () => {
    const f = await setup();
    const pending = await f.queued();
    await f.record(f.evidence("complaint", [f.recipients[0]!]));
    const send = vi.fn();
    expect(await sendMailboxOutbox(db, keys, pending.id, { send }, mime)).toMatchObject({
      status: "failed",
    });
    expect(send).not.toHaveBeenCalled();
    await expect(f.queued()).rejects.toThrow("forbidden");
    // The refusal says why and names the blocked recipient, for the owner and the agent.
    await expect(f.queued()).rejects.toMatchObject({
      code: "forbidden",
      reason: "recipient_blocked",
      recipients: [f.recipients[0]],
    });
    expect(
      await mailboxBlockedRecipients(db, { teamId: f.teamId, recipients: f.recipients }),
    ).toEqual([f.recipients[0]]);
    const [other] = await db
      .insert(schema.teams)
      .values({ name: "Other", slug: randomUUID() })
      .returning();
    expect(
      await checkMailboxRecipientBlocks(db, { teamId: other!.id, recipients: f.recipients }),
    ).toBe(true);
    expect(mailboxRecipientHash(f.teamId, "ONE@EXAMPLE.INVALID")).toBe(
      mailboxRecipientHash(f.teamId, "one@example.invalid"),
    );
    expect(mailboxRecipientHash(f.teamId, f.recipients[0]!)).not.toBe(
      mailboxRecipientHash(other!.id, f.recipients[0]!),
    );
    expect(mailboxRecipientHash(f.teamId, f.recipients[0]!)).not.toBe(
      hashRecipient(f.recipients[0]!),
    );
  });

  it("persists facts after subscription expiry/suspension and records no public Envio event", async () => {
    const f = await setup();
    await db
      .update(schema.mailboxOutbox)
      .set({ recipientHashes: null })
      .where(eq(schema.mailboxOutbox.id, f.row.id));
    await db
      .update(schema.mailboxSubscriptions)
      .set({ status: "canceled" })
      .where(eq(schema.mailboxSubscriptions.teamId, f.teamId));
    await db
      .update(schema.mailboxes)
      .set({ status: "suspended" })
      .where(eq(schema.mailboxes.id, f.mailboxId));
    await f.record(f.evidence("hard_bounce", [f.recipients[0]!]));
    expect(await f.summary()).toMatchObject({ hardBounce: 1, unconfirmed: 1 });
    expect(
      (
        await db.select().from(schema.mailboxOutbox).where(eq(schema.mailboxOutbox.id, f.row.id))
      )[0]!.recipientHashes,
    ).toEqual(f.snapshot);
    expect(await db.select().from(schema.suppressions)).toHaveLength(0);
    expect(await db.select().from(schema.emailEvents)).toHaveLength(0);
    const stored = JSON.stringify(await db.select().from(schema.mailboxOutboundEvents));
    expect(stored).not.toContain("PRIVATE-CONTENT");
    expect(stored).not.toContain("PRIVATE-NOT-A-LEDGER-FIELD");
    expect(stored).not.toContain("one@example.invalid");
  });

  it("keeps blocks after outbox deletion and leaves unknown bounce unconfirmed", async () => {
    const f = await setup();
    await f.record(f.evidence("undetermined_bounce"));
    expect(await f.summary()).toMatchObject({ unconfirmed: 2, softBounce: 0, hardBounce: 0 });
    await f.record(f.evidence("hard_bounce", [f.recipients[0]!]));
    await db.delete(schema.mailboxOutbox).where(eq(schema.mailboxOutbox.id, f.row.id));
    expect(
      await checkMailboxRecipientBlocks(db, { teamId: f.teamId, recipients: [f.recipients[0]!] }),
    ).toBe(false);
    expect(
      await db
        .select()
        .from(schema.mailboxOutboundEvents)
        .where(eq(schema.mailboxOutboundEvents.outboxId, f.row.id)),
    ).toHaveLength(0);
  });

  it("refuses wrong attempt/provider/recipient, unknown status and foreign summary scopes", async () => {
    const f = await setup();
    await expect(f.record(f.evidence("delivered"), { attemptId: randomUUID() })).rejects.toThrow(
      "conflict",
    );
    await expect(
      f.record({
        ...f.evidence("delivered"),
        recipientHashes: [mailboxRecipientHash(f.teamId, "alien@example.invalid")],
      }),
    ).rejects.toThrow("conflict");
    await expect(
      f.record({
        ...f.evidence("delivered"),
        outcome: "unsupported" as MailboxOutboundEvidence["outcome"],
      }),
    ).rejects.toThrow("invalid");
    await f.record(f.evidence("delivered"));
    await expect(
      f.record(f.evidence("delivered"), { messageId: "different-provider" }),
    ).rejects.toThrow("conflict");
    expect(
      await getMailboxOutboundSummary(db, {
        teamId: randomUUID(),
        mailboxId: f.mailboxId,
        outboxId: f.row.id,
      }),
    ).toBeNull();
    expect(
      await getMailboxOutboundSummary(db, {
        teamId: f.teamId,
        mailboxId: randomUUID(),
        outboxId: f.row.id,
      }),
    ).toBeNull();
  });

  it("fails admission closed on a technical block lookup failure", async () => {
    const select = vi.fn(() => {
      throw new Error("synthetic_database_failure");
    });
    await expect(
      checkMailboxRecipientBlocks({ select } as unknown as Db, {
        teamId: randomUUID(),
        recipients: ["one@example.invalid"],
      }),
    ).rejects.toThrow("synthetic_database_failure");
  });

  it("rolls back acceptance, event, outcomes and block together when block persistence fails", async () => {
    const f = await setup();
    await client.exec(
      "CREATE FUNCTION mailbox_outcome_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_block_failure'; END $$; CREATE TRIGGER mailbox_outcome_fixture_failure BEFORE INSERT ON mailbox_recipient_blocks FOR EACH ROW EXECUTE FUNCTION mailbox_outcome_fixture_failure();",
    );
    try {
      await expect(f.record(f.evidence("hard_bounce", [f.recipients[0]!]))).rejects.toThrow();
      expect(
        (
          await db.select().from(schema.mailboxOutbox).where(eq(schema.mailboxOutbox.id, f.row.id))
        )[0]!.status,
      ).toBe("unknown");
      expect(
        await db.select().from(schema.mailboxItems).where(eq(schema.mailboxItems.id, f.row.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(schema.mailboxOutboundEvents)
          .where(eq(schema.mailboxOutboundEvents.outboxId, f.row.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(schema.mailboxRecipientBlocks)
          .where(eq(schema.mailboxRecipientBlocks.teamId, f.teamId)),
      ).toHaveLength(0);
    } finally {
      await client.exec(
        "DROP TRIGGER mailbox_outcome_fixture_failure ON mailbox_recipient_blocks; DROP FUNCTION mailbox_outcome_fixture_failure();",
      );
    }
  });

  it("returns exclusive confirmed counts for temporary bounce/rejection/rendering failure", async () => {
    const cases = [
      ["soft_bounce", "softBounce"],
      ["rejected", "rejected"],
      ["rendering_failed", "renderingFailed"],
    ] as const;
    for (const [outcome, category] of cases) {
      const f = await setup();
      await f.record(f.evidence(outcome, [f.recipients[0]!]));
      const summary = await f.summary();
      expect(summary?.[category]).toBe(1);
      expect(summary?.unconfirmed).toBe(1);
      expect(
        summary &&
          summary.delivered +
            summary.delayed +
            summary.hardBounce +
            summary.complaint +
            summary.softBounce +
            summary.rejected +
            summary.renderingFailed +
            summary.unconfirmed,
      ).toBe(2);
      expect(
        await checkMailboxRecipientBlocks(db, { teamId: f.teamId, recipients: f.recipients }),
      ).toBe(true);
    }
  });

  it("rejects NULL recipient hashes in the actual additive DDL", async () => {
    const f = await setup();
    await expect(
      client.query(
        "UPDATE mailbox_outbox SET recipient_hashes = ARRAY[$1::text, NULL] WHERE id = $2",
        [f.snapshot[0]!, f.row.id],
      ),
    ).rejects.toThrow();
    expect(
      (
        await db.select().from(schema.mailboxOutbox).where(eq(schema.mailboxOutbox.id, f.row.id))
      )[0]!.recipientHashes,
    ).toEqual(f.snapshot);
  });
});

describe("Correio SES account enforcement", () => {
  for (const name of ["AccountSuspendedException", "SendingPausedException", "MessageRejected"]) {
    it(`preserves the sealed queue on ${name}, even when refresh fails`, async () => {
      const f = await setup();
      const queued = await f.queued();
      const send = vi.fn(async () => {
        throw Object.assign(new Error("Sending suspended for this account."), { name });
      });
      const sender = createMailboxSesSender(db, {
        // This legacy transport contract is OSS; Cloud semantic admission is tested separately.
        isCloud: false,
        configurationSets: { "us-east-1": "private_fixture" },
        clientFactory: () => ({ send }),
        sesQuota: {
          exhausted: () => false,
          refresh: async () => {
            throw new Error("offline");
          },
        },
      });
      const before = (
        await db.select().from(schema.mailboxOutbox).where(eq(schema.mailboxOutbox.id, queued.id))
      )[0]!;
      const result = await sendMailboxOutbox(db, keys, queued.id, sender, mime);
      expect(result.status).toBe("queued");
      const after = (
        await db.select().from(schema.mailboxOutbox).where(eq(schema.mailboxOutbox.id, queued.id))
      )[0]!;
      expect(after.attemptId).toBeNull();
      expect(after.ciphertext).not.toBeNull();
      expect(after.ciphertext).toEqual(before.ciphertext);
      expect(after.wrappedDek).toEqual(before.wrappedDek);
      expect(after.recipientHashes).toEqual(before.recipientHashes);
      expect(after.rawSha256).toEqual(before.rawSha256);
      expect(send).toHaveBeenCalledTimes(1);
    });
  }
  it("blocks automatic SES failover and relay on a manual account pause", async () => {
    const f = await setup();
    await db
      .update(schema.domains)
      .set({ relayEnabledAt: new Date() })
      .where(eq(schema.domains.teamId, f.teamId));
    const queued = await f.queued();
    const send = vi.fn();
    const relay = vi.fn();
    const domain = (
      await db.select().from(schema.domains).where(eq(schema.domains.teamId, f.teamId))
    )[0]!;
    const sender = createMailboxSesSender(db, {
      // This legacy transport contract is OSS; Cloud semantic admission is tested separately.
      isCloud: false,
      configurationSets: { "us-east-1": "private_fixture", "eu-west-1": "alternate_fixture" },
      paused: (region) => region === "us-east-1",
      failover: { region: "eu-west-1", domains: new Set([domain.name]) },
      relay: { name: "fixture", sender: { sendRaw: relay } },
      clientFactory: () => ({ send }),
    });
    expect((await sendMailboxOutbox(db, keys, queued.id, sender, mime)).status).toBe("queued");
    expect(send).not.toHaveBeenCalled();
    expect(relay).not.toHaveBeenCalled();
  });
  it("rechecks account pause after asynchronous throttling", async () => {
    const f = await setup();
    const queued = await f.queued();
    let paused = false;
    const send = vi.fn();
    const sender = createMailboxSesSender(db, {
      // This legacy transport contract is OSS; Cloud semantic admission is tested separately.
      isCloud: false,
      configurationSets: { "us-east-1": "private_fixture" },
      paused: () => paused,
      throttle: async () => {
        paused = true;
      },
      clientFactory: () => ({ send }),
    });
    expect((await sendMailboxOutbox(db, keys, queued.id, sender, mime)).status).toBe("queued");
    expect(send).not.toHaveBeenCalled();
  });
  it("does not convert capacity-only or identity rejection to an account pause", async () => {
    const f = await setup();
    const queued = await f.queued();
    const send = vi.fn(async () => {
      throw Object.assign(new Error("identity not verified"), { name: "MessageRejected" });
    });
    const sender = createMailboxSesSender(db, {
      // This legacy transport contract is OSS; Cloud semantic admission is tested separately.
      isCloud: false,
      configurationSets: { "us-east-1": "private_fixture" },
      sesQuota: { exhausted: () => false, refresh: async () => true, accountPaused: () => false },
      clientFactory: () => ({ send }),
    });
    expect((await sendMailboxOutbox(db, keys, queued.id, sender, mime)).status).toBe("failed");
  });
  it("keeps ambiguous acceptance unknown and never replays it", async () => {
    const f = await setup();
    const queued = await f.queued();
    const send = vi.fn(async () => {
      throw Object.assign(new Error("lost acknowledgement"), { name: "TimeoutError" });
    });
    const sender = createMailboxSesSender(db, {
      // This legacy transport contract is OSS; Cloud semantic admission is tested separately.
      isCloud: false,
      configurationSets: { "us-east-1": "private_fixture" },
      clientFactory: () => ({ send }),
    });
    expect((await sendMailboxOutbox(db, keys, queued.id, sender, mime)).status).toBe("unknown");
    await sendMailboxOutbox(db, keys, queued.id, sender, mime);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("a late safe deferral cannot reset an already accepted claim", async () => {
    const f = await setup();
    const queued = await f.queued();
    const result = await sendMailboxOutbox(
      db,
      keys,
      queued.id,
      {
        async send(input) {
          await acceptMailboxOutbox(db, queued.id, {
            attemptId: input.attemptId,
            messageId: "accepted-fixture",
          });
          throw new MailboxSendDeferredError();
        },
      },
      mime,
    );
    expect(result.status).toBe("accepted");
  });
});

it("independently configured customer external mail still sends while platform SES is paused", async () => {
  const f = await setup();
  const { mailboxId } = await createMailboxExternalAccount(db, keys, f.actor, {
    address: "customer@gmail.com",
    label: "Independent fixture",
    servers: {
      provider: "gmail",
      imapHost: "imap.gmail.com",
      smtpHost: "smtp.gmail.com",
      smtpPort: 465,
      smtpSecurity: "tls",
      username: "customer@gmail.com",
    },
    secret: "synthetic-fixture-password",
  });
  const ses = vi.fn(
    createMailboxSesSender(db, {
      // This legacy transport contract is OSS; Cloud semantic admission is tested separately.
      isCloud: false,
      paused: () => true,
    }).send,
  );
  const smtp = vi.fn(async () => ({ messageId: "independent-fixture" }));
  const sender = createMailboxExternalAwareSender(db, keys, { send: ses }, undefined, {
    isCloud: false,
    lookup: (async () => [{ address: "142.250.0.109", family: 4 }]) as never,
    createTransport: (() => ({ sendMail: smtp, close() {} })) as never,
  });
  expect(
    await sender.send({
      idempotencyKey: "fixture",
      outboxId: "fixture",
      attemptId: "fixture",
      teamId: f.teamId,
      mailboxId,
      from: "customer@gmail.com",
      to: f.recipients,
      cc: [],
      bcc: [],
      raw: f.raw,
    }),
  ).toEqual({ messageId: "independent-fixture" });
  expect(smtp).toHaveBeenCalledTimes(1);
  expect(ses).not.toHaveBeenCalled();
});

describe("truthful Native send holds", () => {
  it("retains an approved queue after the same-team domain loses readiness, without sending", async () => {
    const f = await setup();
    const q = await f.queued();
    const send = vi.fn();
    await db
      .update(schema.domains)
      .set({ status: "pending" })
      .where(eq(schema.domains.teamId, f.teamId));
    const result = await sendMailboxOutbox(db, keys, q.id, { send }, mime);
    expect(result.status).toBe("queued");
    expect(result.hold).toMatchObject({
      reason: "domain_not_ready",
      actionRequired: "verify_domain",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("persists pre-claim signup review without claiming or sending and preserves reservation", async () => {
    const f = await setup();
    const q = await f.queued();
    await db.insert(schema.teamSignupRisk).values({
      teamId: f.teamId,
      principalUserId: f.actor.userId,
      level: "hold",
      signals: {} as never,
    });
    const before = (
      await db.select().from(schema.mailboxOutbox).where(eq(schema.mailboxOutbox.id, q.id))
    )[0]!;
    const send = vi.fn();
    const result = await sendMailboxOutbox(db, keys, q.id, { send }, mime);
    expect(result.status).toBe("queued");
    expect(result.hold?.reason).toBe("review_required");
    expect(send).not.toHaveBeenCalled();
    const after = (
      await db.select().from(schema.mailboxOutbox).where(eq(schema.mailboxOutbox.id, q.id))
    )[0]!;
    expect(after.attemptId).toBeNull();
    expect(after.ciphertext).toEqual(before.ciphertext);
    expect(after.periodStart).toEqual(before.periodStart);
    expect(after.periodEnd).toEqual(before.periodEnd);
  });

  it.each(MAILBOX_SEND_HOLD_REASONS)(
    "persists trusted %s with sealed payload and reservation",
    async (reason) => {
      const f = await setup();
      const q = await f.queued();
      const before = (
        await db.select().from(schema.mailboxOutbox).where(eq(schema.mailboxOutbox.id, q.id))
      )[0]!;
      const result = await sendMailboxOutbox(
        db,
        keys,
        q.id,
        {
          send: async () => {
            throw new MailboxSendDeferredError(reason);
          },
        },
        mime,
      );
      expect(result.status).toBe("queued");
      expect(result.hold).toMatchObject({
        reason,
        automaticRetry: true,
        nextRetryAt: null,
        queuedSince: before.createdAt,
      });
      const after = (
        await db.select().from(schema.mailboxOutbox).where(eq(schema.mailboxOutbox.id, q.id))
      )[0]!;
      expect(after.errorCode).toBe(mailboxSendHoldCode(reason));
      expect(after.attemptId).toBeNull();
      expect(after.ciphertext).toEqual(before.ciphertext);
      expect(after.periodStart).toEqual(before.periodStart);
      expect(after.periodEnd).toEqual(before.periodEnd);
      let claimed = false;
      const accepted = await sendMailboxOutbox(
        db,
        keys,
        q.id,
        {
          send: async () => {
            const row = (
              await db.select().from(schema.mailboxOutbox).where(eq(schema.mailboxOutbox.id, q.id))
            )[0]!;
            expect(row.status).toBe("sending");
            expect(row.errorCode).toBeNull();
            expect(mailboxSendHold(row)).toBeNull();
            claimed = true;
            return { messageId: "hold-fixture" };
          },
        },
        mime,
      );
      expect(claimed).toBe(true);
      expect(accepted.status).toBe("accepted");
      expect(accepted.hold).toBeNull();
    },
  );
  it("keeps legacy and ambiguous states hold-free without interpreting raw errors", async () => {
    const f = await setup();
    const q = await f.queued();
    expect(q.hold).toBeNull();
    const send = vi.fn(async () => {
      throw new Error("sending_paused secret fixture");
    });
    const result = await sendMailboxOutbox(db, keys, q.id, { send }, mime);
    expect(result.status).toBe("unknown");
    expect(result.hold).toBeNull();
    await sendMailboxOutbox(db, keys, q.id, { send }, mime);
    expect(send).toHaveBeenCalledTimes(1);
    for (const status of ["sending", "accepted", "unknown", "failed"])
      expect(
        mailboxSendHold({
          status,
          errorCode: mailboxSendHoldCode("review_required"),
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      ).toBeNull();
  });
  it.each([
    ["sending_paused", { paused: () => true }],
    ["configuration_unavailable", { configurationSets: {} }],
    ["quota_exceeded", { exhausted: () => true }],
    [
      "rate_limited",
      {
        throttle: async () => {
          throw new Error("private adapter detail");
        },
      },
    ],
    [
      "recipient_check_unavailable",
      {
        checkRecipients: async () => {
          throw new Error("private adapter detail");
        },
      },
    ],
  ] as const)("maps the actual SES %s gate", async (reason, options) => {
    const f = await setup();
    const q = await f.queued();
    const send = vi.fn();
    const sender = createMailboxSesSender(db, {
      // This legacy transport contract is OSS; Cloud semantic admission is tested separately.
      isCloud: false,
      configurationSets: { "us-east-1": "private_fixture" },
      ...options,
      clientFactory: () => ({ send }),
    });
    const result = await sendMailboxOutbox(db, keys, q.id, sender, mime);
    expect(result.hold?.reason).toBe(reason);
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(result.hold)).not.toContain("private adapter detail");
  });
  it("reports explicit campaign disable only at the reached trusted routing gate", async () => {
    const f = await setup();
    const q = await f.queued();
    const send = vi.fn();
    const policy = {
      version: 1,
      defaults: { campaign: "disabled", transactional: "disabled" },
    } as const;
    // Synthetic newsletter data only, never customer MIME.
    const input = {
      idempotencyKey: q.id,
      outboxId: q.id,
      attemptId: randomUUID(),
      teamId: f.teamId,
      mailboxId: q.mailboxId,
      from: (await mime.parse(f.raw)).from,
      to: ["one@example.invalid"],
      cc: [],
      bcc: [],
      raw: Buffer.from(
        `From: ${(await mime.parse(f.raw)).from}\r\nTo: one@example.invalid\r\nSubject: Newsletter\r\n\r\nNewsletter`,
      ),
    };
    const router = createMailboxContentPolicySender(db, { send }, false, policy);
    await expect(router.send(input)).rejects.toMatchObject({ reason: "campaign_sending_disabled" });
    input.raw = Buffer.from(
      `From: ${(await mime.parse(f.raw)).from}\r\nTo: one@example.invalid\r\nSubject: Hello\r\n\r\nHello`,
    );
    await expect(router.send(input)).rejects.toMatchObject({ reason: "provider_unavailable" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("graduated Native admission uses the sealed original approval", () => {
  beforeEach(async () => {
    await client.close();
    await resetNativeFixtureDatabase();
    vi.spyOn(SESv2Client.prototype, "send").mockImplementation((async (command: object) => {
      if (command.constructor.name !== "GetAccountCommand")
        throw new Error("fixture forbids physical AWS effects");
      return {
        SendingEnabled: true,
        ProductionAccessEnabled: true,
        EnforcementStatus: "HEALTHY",
        SendQuota: { Max24HourSend: 54900, MaxSendRate: 14, SentLast24Hours: 0 },
      };
    }) as never);
  });
  async function enable(
    f: Awaited<ReturnType<typeof setup>>,
    credits = 10,
    beforeModel?: () => Promise<void>,
  ) {
    const [box] = await db
      .select({ domainId: schema.mailboxes.domainId })
      .from(schema.mailboxes)
      .where(eq(schema.mailboxes.id, f.mailboxId));
    const [domain] = await db
      .select()
      .from(schema.domains)
      .where(eq(schema.domains.id, box!.domainId!));
    const now = new Date();
    await db
      .update(schema.domains)
      .set({
        status: "verified",
        verifiedAt: now,
        lastCheckedAt: now,
        dmarcCheckedAt: now,
        dkimSelector: "test",
        mailFromSubdomain: "send",
        dmarcPolicy: "none",
        dnsRecords: [
          {
            group: "verification",
            name: `test._domainkey.${domain!.name}`,
            type: "TXT",
            status: "found",
          },
          { group: "sending", name: `send.${domain!.name}`, type: "TXT", status: "found" },
          { group: "sending", name: `send.${domain!.name}`, type: "MX", status: "found" },
          { group: "dmarc", name: `_dmarc.${domain!.name}`, type: "TXT", status: "found" },
        ],
      })
      .where(eq(schema.domains.id, domain!.id));
    vi.stubEnv(
      "SENDING_PROVIDER_POLICY_JSON",
      JSON.stringify({
        version: 1,
        graduated: true,
        defaults: { transactional: "ses", campaign: "disabled" },
      }),
    );
    vi.stubEnv(
      "GRADUATED_SENDING_CAPACITY_JSON",
      JSON.stringify({
        version: 1,
        expiresAt: new Date(now.getTime() + 60000).toISOString(),
        globalPerMinute: 840,
        globalDaily: 53802,
        tenantPerMinute: 3,
        judgePerMinute: 3,
      }),
    );
    vi.stubEnv("ABUSE_JUDGE", "openai");
    vi.stubEnv("ABUSE_JUDGE_BASE_URL", "https://api.commandcode.ai/provider/v1");
    vi.stubEnv("ABUSE_JUDGE_MODEL", "deepseek/deepseek-v4.1-flash");
    vi.stubEnv("ABUSE_JUDGE_API_KEY", "synthetic-fixture-only");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(url) === "https://api.commandcode.ai/alpha/billing/credits") {
          expect(init?.method).toBe("GET");
          return new Response(
            JSON.stringify({
              credits: {
                monthlyCredits: credits,
                purchasedCredits: 0,
                freeCredits: 0,
                belowThreshold: false,
              },
              windowLimits: {
                fiveHour: { used: 0, cap: 100, resetAt: Date.now() + 3600000 },
                weekly: { used: 0, cap: 100, resetAt: Date.now() + 3600000 },
                exceeded: false,
              },
            }),
            { status: 200 },
          );
        }
        if (!beforeModel) throw new Error("MODEL_DISPATCH_NOT_AUTHORIZED_BY_NEGATIVE_FIXTURE");
        expect(String(url)).toBe("https://api.commandcode.ai/provider/v1/chat/completions");
        expect(JSON.parse(String(init?.body)).max_tokens).toBe(2048);
        await beforeModel();
        const clean = Object.fromEntries(
          Object.entries(ABUSE_JUDGE_QUESTIONS).map(([k, q]) => [
            k,
            q.type === "choice" ? Object.keys(q.criteria)[0] : 0,
          ]),
        );
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: JSON.stringify(clean) } }],
            usage: { prompt_tokens: 20, completion_tokens: 10 },
          }),
          { status: 200 },
        );
      }),
    );
  }
  it("admits the actual sealed human/domain/recipients once before the sender callback", async () => {
    const f = await setup();
    const queued = await f.queued();
    try {
      let physicalModelCalls = 0;
      await enable(f, 10, async () => {
        physicalModelCalls++;
        const rows = await db.execute(
          sql`select count(*)::int as n from sending_judge_attempts where team_id=${f.teamId} and message_kind='mailbox' and message_id=${queued.id} and mailbox_outbox_id=${queued.id} and email_id is null and state='pending'`,
        );
        const actual: unknown = rows;
        const resultRows = Array.isArray(actual) ? actual : (actual as { rows: unknown[] }).rows;
        expect(resultRows[0]).toEqual({ n: 1 });
      });
      const factory = createAbuseJudge({
        provider: "openai",
        baseUrl: "https://api.commandcode.ai/provider/v1",
        model: "deepseek/deepseek-v4.1-flash",
        apiKey: "synthetic-fixture-only",
        timeoutMs: 20000,
      })!;
      let senderError: unknown;
      const send = vi.fn(async (input: Parameters<MailboxOutboxSender["send"]>[0]) => {
        try {
          expect(input.to).toEqual(f.recipients);
          expect(
            (
              await judgeForEmail(factory, db, input.teamId, input.outboxId, "mailbox").judge(
                "<email>Synthetic Native fixture</email>",
                { signal: AbortSignal.timeout(20000) },
              )
            ).verdict,
          ).toBe("clean");
          const rows = await db
            .select()
            .from(schema.auditLog)
            .where(eq(schema.auditLog.target, `graduated:${queued.id}`));
          expect(rows.filter((r) => r.action === "sending.graduated_reserved")).toHaveLength(1);
          return { messageId: "synthetic-graduated-native" };
        } catch (error) {
          senderError = error;
          throw error;
        }
      });
      const result = await sendMailboxOutbox(db, keys, queued.id, { send }, mime);
      if (senderError) throw senderError;
      expect(result).toMatchObject({ status: "accepted", recipientCount: 2 });
      expect(send).toHaveBeenCalledTimes(1);
      expect(physicalModelCalls).toBe(1);
      await sendMailboxOutbox(db, keys, queued.id, { send }, mime);
      expect(send).toHaveBeenCalledTimes(1);
      const rows = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.target, `graduated:${queued.id}`));
      expect(rows.filter((r) => r.action === "sending.graduated_reserved")).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
  it("preserves immutable approval and refuses dispatch after actual mailbox ownership changes", async () => {
    const f = await setup();
    const queued = await f.queued();
    const otherOwner = await setup();
    await expect(
      db
        .update(schema.mailboxOutbox)
        .set({ approvedBy: otherOwner.actor.userId })
        .where(eq(schema.mailboxOutbox.id, queued.id)),
    ).rejects.toThrow();
    const [newMember] = await db
      .insert(schema.teamMembers)
      .values({ teamId: f.teamId, userId: otherOwner.actor.userId, role: "member" })
      .returning();
    await db
      .update(schema.mailboxes)
      .set({ ownerUserId: otherOwner.actor.userId, ownerMembershipId: newMember!.id })
      .where(eq(schema.mailboxes.id, f.mailboxId));
    try {
      await enable(f);
      const send = vi.fn();
      await sendMailboxOutbox(db, keys, queued.id, { send }, mime);
      expect(send).not.toHaveBeenCalled();
      const rows = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.target, `graduated:${queued.id}`));
      expect(rows).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
  it("fresh credit-floor refusal holds the exact queued MIME without sender or admission debit", async () => {
    const f = await setup();
    const queued = await f.queued();
    const [before] = await db
      .select()
      .from(schema.mailboxOutbox)
      .where(eq(schema.mailboxOutbox.id, queued.id));
    try {
      await enable(f, 5);
      const send = vi.fn();
      expect(await sendMailboxOutbox(db, keys, queued.id, { send }, mime)).toMatchObject({
        status: "queued",
        errorCode: mailboxSendHoldCode("rate_limited"),
      });
      expect(send).not.toHaveBeenCalled();
      const [after] = await db
        .select()
        .from(schema.mailboxOutbox)
        .where(eq(schema.mailboxOutbox.id, queued.id));
      expect(after!.status).toBe("queued");
      expect(after!.errorCode).toBe(mailboxSendHoldCode("rate_limited"));
      expect(after!.ciphertext).toEqual(before!.ciphertext);
      expect(
        await db
          .select()
          .from(schema.auditLog)
          .where(eq(schema.auditLog.target, `graduated:${queued.id}`)),
      ).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
  it("retains pending model identity and budget when its private source is deleted", async () => {
    const f = await setup();
    const queued = await f.queued();
    let attemptId: string | undefined;
    try {
      await enable(f);
      const send = vi.fn(async () => {
        const context = await getGraduatedSendingContext();
        const reservation = await reserveJudgeAttempt(
          db,
          {
            teamId: f.teamId,
            emailId: queued.id,
            attemptId: randomUUID(),
            inputTokenUpperBound: 1000000,
            sourceKind: "mailbox",
          },
          {
            ...context,
            judgeEnvelope: { ...context.judgeEnvelope!, accountKey: "synthetic-retention-account" },
          },
        );
        attemptId = reservation.attemptId;
        throw new MailboxSendDeferredError("preflight_unavailable");
      });
      expect(await sendMailboxOutbox(db, keys, queued.id, { send }, mime)).toMatchObject({
        status: "queued",
      });
      expect(attemptId).toBeDefined();
      await db.delete(schema.mailboxOutbox).where(eq(schema.mailboxOutbox.id, queued.id));
      const result: unknown = await db.execute(
        sql`select message_kind,message_id,email_id,mailbox_outbox_id,state,reserved_units::text as units from sending_judge_attempts where account_key='synthetic-retention-account' and attempt_id=${attemptId}::uuid`,
      );
      const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
      expect(rows).toEqual([
        {
          message_kind: "mailbox",
          message_id: queued.id,
          email_id: null,
          mailbox_outbox_id: null,
          state: "pending",
          units: "302457600",
        },
      ]);
      await expect(
        db.execute(
          sql`update sending_judge_attempts set message_id=${randomUUID()}::uuid where account_key='synthetic-retention-account' and attempt_id=${attemptId}::uuid`,
        ),
      ).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});

describe("external graduated full Native pipeline", () => {
  beforeEach(async () => {
    await client.close();
    await resetNativeFixtureDatabase();
    vi.spyOn(SESv2Client.prototype, "send").mockImplementation((async () => {
      throw new Error("external fixture forbids every SES SDK read/send");
    }) as never);
  });
  async function external(recipient = "one@example.invalid") {
    const f = await setup();
    const { mailboxId } = await createMailboxExternalAccount(db, keys, f.actor, {
      address: "customer@gmail.com",
      label: "Synthetic external",
      servers: {
        provider: "gmail",
        imapHost: "imap.gmail.com",
        smtpHost: "smtp.gmail.com",
        smtpPort: 465,
        smtpSecurity: "tls",
        username: "customer@gmail.com",
      },
      secret: "synthetic-fixture-password",
    });
    const raw = Buffer.from(
      `From: customer@gmail.com\r\nTo: ${recipient}\r\nSubject: Hello\r\nMessage-ID: <${randomUUID()}@fixture.invalid>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello, can we talk tomorrow?`,
    );
    const draft = await saveMailboxDraft(db, keys, f.actor, {
      mailboxId,
      expectedRevision: 0,
      raw,
    });
    const queued = await queueMailboxDraft(
      db,
      keys,
      f.actor,
      { mailboxId, id: draft.id, expectedRevision: draft.revision },
      mime,
    );
    return { ...f, mailboxId, queued, raw };
  }
  for (const scenario of [
    "positive",
    "judge_reject",
    "credential_revoked_during_model",
    "membership_revoked_during_model",
    "suspended",
    "unverified_foreign",
    "unverified_own",
    "spoof_from",
    "forged_proof",
    "foreign_tenant",
    "stale_credential",
    "revoked_membership",
    "operator_paused",
  ]) {
    it(scenario, async () => {
      const f = await external();
      let models = 0,
        sesGets = 0;
      const ses = vi.fn();
      const smtp = vi.fn(async () => ({ messageId: "synthetic-external-accepted" }));
      try {
        vi.stubEnv(
          "SENDING_PROVIDER_POLICY_JSON",
          JSON.stringify({
            version: 1,
            graduated: true,
            defaults: { transactional: "ses", campaign: "disabled" },
          }),
        );
        vi.stubEnv("ABUSE_JUDGE", "openai");
        vi.stubEnv("ABUSE_JUDGE_BASE_URL", "https://api.commandcode.ai/provider/v1");
        vi.stubEnv("ABUSE_JUDGE_MODEL", "deepseek/deepseek-v4.1-flash");
        vi.stubEnv("ABUSE_JUDGE_API_KEY", "synthetic-fixture-only");
        vi.stubGlobal(
          "fetch",
          vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
            if (String(url) === "https://api.commandcode.ai/alpha/billing/credits")
              return new Response(
                JSON.stringify({
                  credits: {
                    monthlyCredits: 10,
                    purchasedCredits: 8,
                    freeCredits: 5,
                    belowThreshold: false,
                  },
                  windowLimits: {
                    fiveHour: { used: 0, cap: 100, resetAt: Date.now() + 3600000 },
                    weekly: { used: 0, cap: 100, resetAt: Date.now() + 3600000 },
                    exceeded: false,
                  },
                }),
                { status: 200 },
              );
            if (String(url) !== "https://api.commandcode.ai/provider/v1/chat/completions") {
              sesGets++;
              throw new Error("unexpected physical network");
            }
            models++;
            expect(JSON.parse(String(init?.body)).max_tokens).toBe(2048);
            expect(Buffer.byteLength(String(init?.body))).toBeLessThanOrEqual(65536);
            const pending: unknown = await db.execute(
              sql`select count(*)::int as n from sending_judge_attempts where team_id=${f.teamId} and message_kind='mailbox' and mailbox_outbox_id=${f.queued.id} and email_id is null and state='pending'`,
            );
            expect(
              (Array.isArray(pending) ? pending : (pending as { rows: unknown[] }).rows)[0],
            ).toEqual({ n: 1 });
            if (scenario === "credential_revoked_during_model")
              await db
                .update(schema.mailboxExternalAccounts)
                .set({
                  status: "auth_failed",
                  connectionGeneration: sql`${schema.mailboxExternalAccounts.connectionGeneration}+1`,
                })
                .where(eq(schema.mailboxExternalAccounts.mailboxId, f.mailboxId));
            if (scenario === "membership_revoked_during_model")
              await db.delete(schema.teamMembers).where(eq(schema.teamMembers.teamId, f.teamId));
            const answers = Object.fromEntries(
              Object.entries(ABUSE_JUDGE_QUESTIONS).map(([k, q]) => [
                k,
                q.type === "choice"
                  ? Object.keys(q.criteria)[0]
                  : scenario === "judge_reject"
                    ? 100
                    : 0,
              ]),
            );
            return new Response(
              JSON.stringify({
                choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answers) } }],
                usage: { prompt_tokens: 20, completion_tokens: 10 },
              }),
              { status: 200 },
            );
          }),
        );
        if (scenario === "suspended")
          await db
            .update(schema.teams)
            .set({ suspendedAt: new Date() })
            .where(eq(schema.teams.id, f.teamId));
        if (scenario.startsWith("unverified"))
          await db
            .update(schema.user)
            .set({ emailVerified: false })
            .where(eq(schema.user.id, f.actor.userId));
        if (scenario === "stale_credential")
          await db
            .update(schema.mailboxExternalAccounts)
            .set({ status: "auth_failed" })
            .where(eq(schema.mailboxExternalAccounts.mailboxId, f.mailboxId));
        if (scenario === "revoked_membership")
          await db.delete(schema.teamMembers).where(eq(schema.teamMembers.userId, f.actor.userId));
        const factory = createAbuseJudge({
          provider: "openai",
          baseUrl: "https://api.commandcode.ai/provider/v1",
          model: "deepseek/deepseek-v4.1-flash",
          apiKey: "synthetic-fixture-only",
          timeoutMs: 20000,
        })!;
        const adapter = createMailboxExternalAwareSender(db, keys, { send: ses }, undefined, {
          isCloud: true,
          lookup: (async () => [{ address: "142.250.0.109", family: 4 }]) as never,
          createTransport: (() => ({ sendMail: smtp, close() {} })) as never,
        });
        const policy = {
          version: 1 as const,
          graduated: true,
          paused: scenario === "operator_paused",
          defaults: { transactional: "ses", campaign: "disabled" },
        } as const;
        const rootModule = await import("@millionsend/core");
        const wrapped = createMailboxContentPolicySender(db, adapter, true, policy, null, factory);
        let sender = wrapped;
        if (["spoof_from", "foreign_tenant"].includes(scenario))
          sender = {
            send: (input) =>
              wrapped.send({
                ...input,
                ...(scenario === "spoof_from"
                  ? { from: "spoof@gmail.com" }
                  : { teamId: randomUUID() }),
              }),
          };
        if (scenario === "forged_proof") {
          const { reserveGraduatedSending } = await import("../src/graduated-sending.js");
          await expect(
            db.transaction((tx) =>
              reserveGraduatedSending(tx as unknown as Db, {
                teamId: f.teamId,
                emailId: f.queued.id,
                from: "customer@gmail.com",
                recipients: ["one@example.invalid"],
                campaign: false,
                senderProof: {} as never,
              }),
            ),
          ).rejects.toMatchObject({ status: 403 });
          expect(models).toBe(0);
          expect(smtp).not.toHaveBeenCalled();
          return;
        }
        if (scenario === "unverified_own") {
          // The real registered principal remains the recipient, not the SMTP account.
          // Recreate through the encrypted draft/approval path, never mutate a sealed row.
          vi.unstubAllEnvs();
          const [u] = await db.select().from(schema.user).where(eq(schema.user.id, f.actor.userId));
          const raw = Buffer.from(
            `From: customer@gmail.com\r\nTo: ${u!.email}\r\nSubject: Own test\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello`,
          );
          const d = await saveMailboxDraft(db, keys, f.actor, {
            mailboxId: f.mailboxId,
            expectedRevision: 0,
            raw,
          });
          const q = await queueMailboxDraft(
            db,
            keys,
            f.actor,
            { mailboxId: f.mailboxId, id: d.id, expectedRevision: d.revision },
            mime,
          );
          vi.stubEnv("SENDING_PROVIDER_POLICY_JSON", JSON.stringify(policy));
          vi.stubEnv("ABUSE_JUDGE", "openai");
          vi.stubEnv("ABUSE_JUDGE_BASE_URL", "https://api.commandcode.ai/provider/v1");
          vi.stubEnv("ABUSE_JUDGE_MODEL", "deepseek/deepseek-v4.1-flash");
          vi.stubEnv("ABUSE_JUDGE_API_KEY", "synthetic-fixture-only");
          f.queued = q;
        }
        const result = await sendMailboxOutbox(db, keys, f.queued.id, sender, mime);
        console.log("EXTERNAL_RESULT", scenario, JSON.stringify(result), "models", models);
        if (["positive", "unverified_own"].includes(scenario)) {
          expect(result.status).toBe("accepted");
          expect(smtp).toHaveBeenCalledTimes(1);
          expect(models).toBe(1);
          await sendMailboxOutbox(db, keys, f.queued.id, sender, mime);
          expect(smtp).toHaveBeenCalledTimes(1);
          expect((await rootModule.fetchDeliverabilityHealth(db, f.teamId)).sent).toBe(0);
          expect(
            await db.select().from(schema.emails).where(eq(schema.emails.teamId, f.teamId)),
          ).toHaveLength(0);
        } else {
          expect(result.status).not.toBe("accepted");
          expect(smtp).not.toHaveBeenCalled();
        }
        if (
          [
            "suspended",
            "unverified_foreign",
            "stale_credential",
            "revoked_membership",
            "spoof_from",
            "foreign_tenant",
            "operator_paused",
          ].includes(scenario)
        )
          expect(models).toBe(0);
        if (scenario === "judge_reject") {
          expect(models).toBe(1);
          const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, f.teamId));
          expect(team!.suspendedAt).toBeNull();
        }
        if (
          ["credential_revoked_during_model", "membership_revoked_during_model"].includes(scenario)
        ) {
          expect(models).toBe(1);
          expect(result.status).toBe("queued");
          expect(result.errorCode).toMatch(
            /^mailbox_deferred:(review_required|preflight_unavailable)$/,
          );
          const [activeTeam] = await db
            .select()
            .from(schema.teams)
            .where(eq(schema.teams.id, f.teamId));
          expect(activeTeam!.suspendedAt).toBeNull();
        }
        expect(ses).not.toHaveBeenCalled();
        expect(sesGets).toBe(0);
        expect(SESv2Client.prototype.send).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
      }
    }, 40000);
  }
});
