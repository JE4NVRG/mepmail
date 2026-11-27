import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withMailboxDispatchContent } from "../../../apps/worker/src/mailbox-dispatch-content.js";
import type { JudgeVerdict } from "../src/abuse-judge/types.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { saveMailboxDraft } from "../src/mailbox-private-store.js";
import { mailboxThreadKeys } from "../src/mailbox-thread.js";
import {
  type MailboxOutboxSender,
  MailboxSendDeferredError,
  type MailboxTransportMimeAdapter,
  queueMailboxDraft,
  receiveMailboxMime,
  resolveMailboxReplySource,
} from "../src/mailbox-transport.js";
import { guardColdOutreach, guardColdOutreachWithReply } from "../src/outreach-guard.js";

/**
 * Respostas legítimas do parcerias@ (Jean 2026-11-26).
 *
 * The rule that paused the account was "prospecting never leaves", and it
 * classified by SENDER, so a real answer to someone who wrote to
 * parcerias@parceria was held exactly like a cold blast. The exemption must be
 * proved on the server, from sealed bytes, and must not open any other door.
 */

let client: PGlite;
let db: Db;
const keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);

/** A clean judge verdict: the model must not be what unblocks, the binding is. */
const clean: JudgeVerdict = {
  score: 0,
  verdict: "clean",
  categories: [],
  reasons: [],
  impersonatedBrand: null,
  language: "en",
};
const cleanJudge = {
  provider: "openai" as const,
  model: "synthetic",
  judge: async () => clean,
};

/** Real MIME read: the adapter parses the same headers the app parses. */
const mime: MailboxTransportMimeAdapter = {
  async parse(raw) {
    const headers = raw.toString("utf8").split("\r\n\r\n")[0]!;
    const one = (name: string) =>
      new RegExp(`^${name}: (.+)$`, "m").exec(headers)?.[1]?.trim() ?? null;
    const list = (name: string) => {
      const value = one(name);
      return value ? value.split(", ").map((entry) => entry.trim()) : [];
    };
    return {
      from: one("From") ?? "",
      to: list("To"),
      cc: list("Cc"),
      attachmentBytes: [],
    };
  },
};

async function migrate() {
  client = new PGlite();
  // Both real chains: the main schema plus the Correio extension (which carries
  // the reply-binding migration under test).
  for (const path of [
    fileURLToPath(new URL("../../db/drizzle/", import.meta.url)),
    fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url)),
  ])
    for (const name of readdirSync(path)
      .filter((entry) => entry.endsWith(".sql"))
      .sort())
      await client.transaction(async (tx) => {
        for (const statement of readFileSync(path + name, "utf8")
          .split("--> statement-breakpoint")
          .filter((part) => part.trim()))
          await tx.exec(statement);
      });
  db = drizzle(client, { schema }) as unknown as Db;
}

beforeAll(migrate);
afterAll(async () => {
  await client.close();
});

interface Fixture {
  teamId: string;
  userId: string;
  mailboxId: string;
  address: string;
}

/** One team, one verified domain, one mailbox owned by a human. */
async function fixture(local: string = "parcerias"): Promise<Fixture> {
  const userId = randomUUID();
  const [team] = await db
    .insert(schema.teams)
    .values({ name: "Reply binding", slug: randomUUID() })
    .returning();
  const teamId = team!.id;
  await db.insert(schema.user).values({
    id: userId,
    name: "Fixture owner",
    email: `${userId}@example.invalid`,
    emailVerified: true,
  });
  const [member] = await db
    .insert(schema.teamMembers)
    .values({ teamId, userId, role: "owner" })
    .returning();
  // A fresh domain per fixture: the address is unique across the database, and
  // the LOCAL part stays `parcerias` so the sender rule under test still fires.
  const domainName = `${randomUUID().slice(0, 8)}.invalid`;
  const address = `${local}@${domainName}`;
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: domainName,
      status: "verified",
      region: "us-east-1",
      relayEnabledAt: new Date(),
    })
    .returning();
  const [box] = await db
    .insert(schema.mailboxes)
    .values({
      teamId,
      domainId: domain!.id,
      address,
      label: "Parcerias",
      kind: "person",
      ownerUserId: userId,
      ownerMembershipId: member!.id,
    })
    .returning();
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "active",
    seats: 2,
    storageBytesPerMailbox: 10 * 1048576,
    includedOutboundPerMailbox: 1000,
    periodStart: new Date(Date.now() - 86_400_000),
    periodEnd: new Date(Date.now() + 86_400_000),
  });
  return { teamId, userId, mailboxId: box!.id, address };
}

/** A message that really arrived in the mailbox, with its own Message-ID. */
async function receive(
  box: Fixture,
  input: { from: string; to: string[]; cc?: string[]; subject?: string; messageId: string },
) {
  const raw = Buffer.from(
    [
      `From: ${input.from}`,
      `To: ${input.to.join(", ")}`,
      ...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
      `Subject: ${input.subject ?? "Partnership question"}`,
      `Message-ID: ${input.messageId}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      "Are you open to a sponsorship conversation?",
    ].join("\r\n"),
  );
  const [result] = (
    await receiveMailboxMime(
      db,
      keys,
      { sourceId: `ingress-${randomUUID()}`, recipients: [box.address], raw },
      mime,
    )
  ).items;
  return result!.id;
}

/** A draft reply as the composer would build it. */
function replyRaw(input: {
  from: string;
  to: string[];
  cc?: string[];
  subject?: string;
  inReplyTo: string;
}) {
  return Buffer.from(
    [
      `From: ${input.from}`,
      `To: ${input.to.join(", ")}`,
      ...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
      `Subject: ${input.subject ?? "Re: Partnership question"}`,
      `In-Reply-To: ${input.inReplyTo}`,
      "References: " + input.inReplyTo,
      `Message-ID: <${randomUUID()}@${input.from.slice(input.from.lastIndexOf("@") + 1)}>`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      "Thanks for reaching out, happy to talk.",
    ].join("\r\n"),
  );
}

async function draftAndQueue(box: Fixture, raw: Buffer) {
  const actor = { teamId: box.teamId, userId: box.userId };
  const draft = await saveMailboxDraft(db, keys, actor, {
    mailboxId: box.mailboxId,
    expectedRevision: 0,
    raw,
  });
  return queueMailboxDraft(
    db,
    keys,
    actor,
    { mailboxId: box.mailboxId, id: draft.id, expectedRevision: draft.revision },
    mime,
  );
}

/** The outbox input exactly as the worker receives it from the claimed row. */
async function dispatched(outboxId: string): Promise<Parameters<MailboxOutboxSender["send"]>[0]> {
  const [row] = await db
    .select()
    .from(schema.mailboxOutbox)
    .where(eq(schema.mailboxOutbox.id, outboxId));
  const [box] = await db
    .select()
    .from(schema.mailboxes)
    .where(eq(schema.mailboxes.id, row!.mailboxId));
  const raw = await openDraft(row!.draftId);
  const parsed = await mime.parse(raw);
  // Claim the row exactly as sendMailboxOutbox does before the adapter runs; the
  // dispatch gate re-reads this attempt, so an unclaimed row is a different test.
  const attemptId = randomUUID();
  await db
    .update(schema.mailboxOutbox)
    .set({ status: "sending", attemptId, attemptedAt: new Date() })
    .where(eq(schema.mailboxOutbox.id, row!.id));
  return {
    idempotencyKey: row!.id,
    outboxId: row!.id,
    attemptId,
    teamId: row!.teamId,
    mailboxId: row!.mailboxId,
    from: box!.address,
    to: parsed.to,
    cc: parsed.cc ?? [],
    bcc: [],
    raw,
  };
}

/** Opens the sealed draft the outbox admitted, the same way the worker does. */
async function openDraft(draftId: string) {
  const { decryptPayload } = await import("../src/crypto/envelope.js");
  const [item] = await db
    .select()
    .from(schema.mailboxItems)
    .where(eq(schema.mailboxItems.id, draftId));
  return decryptPayload(
    {
      ciphertext: item!.ciphertext,
      iv: item!.iv,
      wrappedDek: item!.wrappedDek,
      keyVersion: item!.keyVersion,
    },
    keys,
    {
      teamId: item!.teamId,
      rowId: `mailbox-private-v1:${item!.mailboxId}:${item!.id}`,
      kind: "email_body",
    },
  );
}

describe("cold-outreach rule and the server-proved reply binding", () => {
  it("still blocks a NEW message from the prospecting sender", () => {
    expect(guardColdOutreach({ from: "parcerias@urlpivot.test", subject: "Hello" })).toMatchObject({
      blocked: true,
    });
    expect(
      guardColdOutreachWithReply({
        from: "parcerias@urlpivot.test",
        subject: "Hello",
        replySourceItemId: null,
      }).blocked,
    ).toBe(true);
  });

  it("refuses a non-item-id binding instead of trusting a caller flag", () => {
    for (const forged of ["", "true", "1", "../x", randomUUID().toUpperCase() + "x"])
      expect(
        guardColdOutreachWithReply({
          from: "parcerias@urlpivot.test",
          subject: "Hello",
          replySourceItemId: forged,
        }),
      ).toMatchObject({ blocked: true });
  });

  it("keeps a prospecting SUBJECT blocked when nothing was proved", () => {
    expect(
      guardColdOutreachWithReply({
        from: "someone@ordinary.invalid",
        subject: "Sponsorship opportunities for your newsletter",
        replySourceItemId: null,
      }),
    ).toMatchObject({ blocked: true, signal: "subject:sponsorship" });
  });

  it("lets a proved conversation keep the subject it inherited from the thread", () => {
    // The reply carries the received subject ("Re: Partnership question"). With
    // the server-proved binding that reads as correspondence, not an approach.
    expect(
      guardColdOutreachWithReply({
        from: "parcerias@urlpivot.test",
        subject: "Re: Partnership question",
        replySourceItemId: randomUUID(),
      }),
    ).toEqual({ blocked: false });
  });

  it("allows the sender only when the server proved the conversation", () => {
    expect(
      guardColdOutreachWithReply({
        from: "parcerias@urlpivot.test",
        subject: "Re: Partnership question",
        replySourceItemId: randomUUID(),
      }),
    ).toEqual({ blocked: false });
  });
});

describe("resolveMailboxReplySource", () => {
  it("binds a reply to the received message of the same mailbox", async () => {
    const box = await fixture();
    const received = await receive(box, {
      from: "carol@partner.invalid",
      to: [box.address],
      messageId: "<parent-1@partner.invalid>",
    });
    const source = await resolveMailboxReplySource(
      db,
      keys,
      {
        teamId: box.teamId,
        mailboxId: box.mailboxId,
        address: box.address,
        recipients: ["carol@partner.invalid"],
        raw: replyRaw({
          from: box.address,
          to: ["carol@partner.invalid"],
          inReplyTo: "<parent-1@partner.invalid>",
        }),
      },
      mime,
    );
    expect(source).toBe(received);
  });

  it("does not bind a new message (no In-Reply-To)", async () => {
    const box = await fixture();
    await receive(box, {
      from: "carol@partner.invalid",
      to: [box.address],
      messageId: "<parent-2@partner.invalid>",
    });
    const raw = Buffer.from(
      [
        `From: ${box.address}`,
        "To: carol@partner.invalid",
        "Subject: A new message",
        `Message-ID: <${randomUUID()}@urlpivot.test>`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Cold prospecting to someone new.",
      ].join("\r\n"),
    );
    expect(
      await resolveMailboxReplySource(
        db,
        keys,
        {
          teamId: box.teamId,
          mailboxId: box.mailboxId,
          address: box.address,
          recipients: ["carol@partner.invalid"],
          raw,
        },
        mime,
      ),
    ).toBeNull();
  });

  it("does not bind a forged In-Reply-To that names nothing in this mailbox", async () => {
    const box = await fixture();
    await receive(box, {
      from: "carol@partner.invalid",
      to: [box.address],
      messageId: "<parent-3@partner.invalid>",
    });
    expect(
      await resolveMailboxReplySource(
        db,
        keys,
        {
          teamId: box.teamId,
          mailboxId: box.mailboxId,
          address: box.address,
          recipients: ["carol@partner.invalid"],
          raw: replyRaw({
            from: box.address,
            to: ["carol@partner.invalid"],
            inReplyTo: "<totally-invented@attacker.invalid>",
          }),
        },
        mime,
      ),
    ).toBeNull();
  });

  it("does not bind when the reply adds a recipient outside the conversation", async () => {
    const box = await fixture();
    await receive(box, {
      from: "carol@partner.invalid",
      to: [box.address],
      messageId: "<parent-4@partner.invalid>",
    });
    expect(
      await resolveMailboxReplySource(
        db,
        keys,
        {
          teamId: box.teamId,
          mailboxId: box.mailboxId,
          address: box.address,
          recipients: ["carol@partner.invalid", "victim@elsewhere.invalid"],
          raw: replyRaw({
            from: box.address,
            to: ["carol@partner.invalid", "victim@elsewhere.invalid"],
            inReplyTo: "<parent-4@partner.invalid>",
          }),
        },
        mime,
      ),
    ).toBeNull();
  });

  it("does not bind the same Message-ID received in ANOTHER mailbox", async () => {
    const box = await fixture();
    const other = await fixture();
    const messageId = "<parent-5@partner.invalid>";
    await receive(other, {
      from: "carol@partner.invalid",
      to: [other.address],
      messageId,
    });
    // The mailbox under test never received it, so its own In-Reply-To proves
    // nothing even though the Message-ID exists in the same team/database.
    expect(
      await resolveMailboxReplySource(
        db,
        keys,
        {
          teamId: box.teamId,
          mailboxId: box.mailboxId,
          address: box.address,
          recipients: ["carol@partner.invalid"],
          raw: replyRaw({
            from: box.address,
            to: ["carol@partner.invalid"],
            inReplyTo: messageId,
          }),
        },
        mime,
      ),
    ).toBeNull();
  });
});

describe("admission writes the binding, the worker reads it, and repeats are refused", () => {
  it("admits the legitimate reply with the binding and keeps the sender rule for a new one", async () => {
    const box = await fixture();
    const received = await receive(box, {
      from: "carol@partner.invalid",
      to: [box.address],
      messageId: "<parent-6@partner.invalid>",
    });
    const reply = await draftAndQueue(
      box,
      replyRaw({
        from: box.address,
        to: ["carol@partner.invalid"],
        inReplyTo: "<parent-6@partner.invalid>",
      }),
    );
    const [replyRow] = await db
      .select()
      .from(schema.mailboxOutbox)
      .where(eq(schema.mailboxOutbox.id, reply.id));
    expect(replyRow!.replySourceItemId).toBe(received);

    const fresh = await draftAndQueue(
      box,
      Buffer.from(
        [
          `From: ${box.address}`,
          "To: carol@partner.invalid",
          "Subject: Introduction",
          `Message-ID: <${randomUUID()}@urlpivot.test>`,
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Brand new message.",
        ].join("\r\n"),
      ),
    );
    const [freshRow] = await db
      .select()
      .from(schema.mailboxOutbox)
      .where(eq(schema.mailboxOutbox.id, fresh.id));
    expect(freshRow!.replySourceItemId).toBeNull();
  });

  it("refuses a second live reply to the same received message", async () => {
    const box = await fixture();
    await receive(box, {
      from: "carol@partner.invalid",
      to: [box.address],
      messageId: "<parent-7@partner.invalid>",
    });
    const raw = () =>
      replyRaw({
        from: box.address,
        to: ["carol@partner.invalid"],
        inReplyTo: "<parent-7@partner.invalid>",
      });
    await draftAndQueue(box, raw());
    await expect(draftAndQueue(box, raw())).rejects.toMatchObject({ code: "conflict" });
  });

  it("lets the worker deliver the bound reply and still holds a new prospecting message", async () => {
    const box = await fixture();
    await receive(box, {
      from: "carol@partner.invalid",
      to: [box.address],
      messageId: "<parent-8@partner.invalid>",
    });
    const reply = await draftAndQueue(
      box,
      replyRaw({
        from: box.address,
        to: ["carol@partner.invalid"],
        inReplyTo: "<parent-8@partner.invalid>",
      }),
    );
    const input = await dispatched(reply.id);
    const send = vi.fn(async () => ({ messageId: "provider-accepted" }));
    // The judge is not the authority here: the sender rule is, and an explicit
    // clean verdict proves the binding — not the model — is what unblocks it.
    await expect(withMailboxDispatchContent(db, input, cleanJudge, true, send)).resolves.toEqual({
      messageId: "provider-accepted",
    });
    expect(send).toHaveBeenCalledTimes(1);

    const fresh = await draftAndQueue(
      box,
      Buffer.from(
        [
          `From: ${box.address}`,
          "To: someone@new.invalid",
          "Subject: Introduction",
          `Message-ID: <${randomUUID()}@urlpivot.test>`,
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Brand new message.",
        ].join("\r\n"),
      ),
    );
    const freshInput = await dispatched(fresh.id);
    freshInput.to = ["someone@new.invalid"];
    const held = vi.fn();
    await expect(
      withMailboxDispatchContent(db, freshInput, cleanJudge, true, held),
    ).rejects.toMatchObject({ reason: "cold_outreach" });
    expect(held).not.toHaveBeenCalledTimes(1);
  });
});

describe("the stored binding is the authority the worker reads", () => {
  it("ignores an outbox row whose mailbox does not match the attempt", async () => {
    const box = await fixture();
    const received = await receive(box, {
      from: "carol@partner.invalid",
      to: [box.address],
      messageId: "<parent-9@partner.invalid>",
    });
    const reply = await draftAndQueue(
      box,
      replyRaw({
        from: box.address,
        to: ["carol@partner.invalid"],
        inReplyTo: "<parent-9@partner.invalid>",
      }),
    );
    expect(received).toBeTruthy();
    const { mailboxReplySourceForOutbox } = await import("../src/mailbox-transport.js");
    expect(
      await mailboxReplySourceForOutbox(db, {
        teamId: box.teamId,
        mailboxId: box.mailboxId,
        outboxId: reply.id,
      }),
    ).toBe(received);
    // A different box in the same team cannot borrow the proof.
    expect(
      await mailboxReplySourceForOutbox(db, {
        teamId: box.teamId,
        mailboxId: randomUUID(),
        outboxId: reply.id,
      }),
    ).toBeNull();
  });
});

describe("thread keys still describe the conversation", () => {
  it("keeps message_key comparable to an In-Reply-To digest", async () => {
    const box = await fixture();
    const messageId = "<parent-10@partner.invalid>";
    const received = await receive(box, {
      from: "carol@partner.invalid",
      to: [box.address],
      messageId,
    });
    const [item] = await db
      .select()
      .from(schema.mailboxItems)
      .where(eq(schema.mailboxItems.id, received));
    expect(item!.messageKey).toBe(
      mailboxThreadKeys(Buffer.from(`Message-ID: ${messageId}\r\n\r\n`)).messageKey,
    );
  });
});
