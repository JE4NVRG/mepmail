import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { saveMailboxDraft } from "../src/mailbox-private-store.js";
import {
  acceptMailboxOutbox,
  checkMailboxRecipientBlocks,
  getMailboxOutboundSummary,
  type MailboxOutboundEvidence,
  type MailboxTransportMimeAdapter,
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

beforeAll(async () => {
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
});
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
