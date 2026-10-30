import type { SesSender } from "../../../apps/worker/src/handlers/send-email.js";
import { createMailboxContentPolicySender } from "../../../apps/worker/src/mailbox-sender.js";
import { createMailboxAgentKey } from "../src/mailbox-agent-access.js";
import * as azureBudget from "../src/mailbox-azure-budget.js";
import { utcDay } from "../src/utc-day.js";

afterEach(() => vi.restoreAllMocks());
async function cloud(
  f: Awaited<ReturnType<typeof setup>>,
  queued?: { id: string },
  sendRaw = vi.fn(async (_input: Parameters<SesSender["sendRaw"]>[0]) => ({ messageId: receipt })),
) {
  const p = policy(f);
  const azure = createMailboxAzureSender(db, {
    policy: p,
    isCloud: true,
    relay: { name: "azure", sender: { sendRaw } },
  });
  // Real outer router + real factory wrapper both clone their input. Neither may
  // reserve probation; the final Azure adapter must reserve exactly once.
  const sender = createMailboxContentPolicySender(
    db,
    {
      async send() {
        throw new Error("unexpected SES");
      },
    },
    true,
    p,
    azure,
  );
  const outbox = queued ?? (await f.queued());
  const result = await sendMailboxOutbox(db, keys, outbox.id, sender, mime);
  return { result, sendRaw, outbox, sender };
}
async function daily(teamId: string) {
  const [row] = await db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, teamId));
  return row?.accepted ?? 0;
}
async function receipts(teamId: string) {
  return (await db.select().from(schema.auditLog).where(eq(schema.auditLog.teamId, teamId))).filter(
    (row) => ["sending.azure_quota_reserved", "sending.mailbox_azure_claimed"].includes(row.action),
  );
}
describe("NativeR2 cloud and blocking-boundary regressions", () => {
  it("cloud nested routers reserve probation exactly once, preserving Sent and replay fence", async () => {
    const f = await setup();
    const sent = await cloud(f);
    expect(sent.result.status).toBe("accepted");
    expect(sent.sendRaw).toHaveBeenCalledTimes(1);
    expect(await daily(f.teamId)).toBe(1);
    expect(await receipts(f.teamId)).toHaveLength(2);
    expect((await sendMailboxOutbox(db, keys, sent.outbox.id, sent.sender, mime)).duplicate).toBe(
      true,
    );
    expect(await daily(f.teamId)).toBe(1);
    expect(sent.sendRaw).toHaveBeenCalledTimes(1);
  });
  it("cloud agent-authenticated approval sends once with one probation reservation", async () => {
    const f = await setup();
    const key = await createMailboxAgentKey(db, f.actor, {
      mailboxId: f.box.id,
      label: "fixture",
      scopes: ["send"],
    });
    const draft = await saveMailboxDraft(db, keys, f.actor, {
      mailboxId: f.box.id,
      expectedRevision: 0,
      raw: f.raw,
    });
    const { queueMailboxAgentDraft } = await import("../src/mailbox-transport.js");
    const outbox = await queueMailboxAgentDraft(
      db,
      keys,
      key.token,
      { id: draft.id, expectedRevision: draft.revision },
      mime,
    );
    const sent = await cloud(f, outbox);
    expect(sent.result.status).toBe("accepted");
    expect(sent.sendRaw).toHaveBeenCalledTimes(1);
    expect(await daily(f.teamId)).toBe(1);
  });
  it("cloud probation/daily ceiling stops Azure before global claim or SMTP", async () => {
    const f = await setup();
    await db.insert(schema.usageCounters).values({ teamId: f.teamId, day: utcDay(), accepted: 25 });
    const sent = await cloud(f);
    expect(sent.result.status).toBe("queued");
    expect(sent.sendRaw).not.toHaveBeenCalled();
    expect(await daily(f.teamId)).toBe(25);
    expect(await receipts(f.teamId)).toHaveLength(0);
  });
  it("cloud disconnect keeps probation, global receipts and lifetime claim without retry", async () => {
    const f = await setup();
    const send = vi.fn(
      async (_input: Parameters<SesSender["sendRaw"]>[0]): Promise<{ messageId: string }> => {
        throw new Error("synthetic disconnect");
      },
    );
    const sent = await cloud(f, undefined, send);
    expect(sent.result.status).toBe("unknown");
    expect(await daily(f.teamId)).toBe(1);
    expect(await receipts(f.teamId)).toHaveLength(2);
    await sendMailboxOutbox(db, keys, sent.outbox.id, sent.sender, mime);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([
    "relay",
    "domain",
    "standing",
    "license",
    "membership",
    "agent-revoked",
    "agent-expired",
  ])(
    "rechecks %s after the global-budget await without refunding its durable claim",
    async (kind) => {
      const f = await setup();
      let outbox: { id: string };
      let keyId: string | undefined;
      if (kind.startsWith("agent")) {
        const key = await createMailboxAgentKey(db, f.actor, {
          mailboxId: f.box.id,
          label: "synthetic approval",
          scopes: ["send"],
        });
        keyId = key.id;
        const draft = await saveMailboxDraft(db, keys, f.actor, {
          mailboxId: f.box.id,
          expectedRevision: 0,
          raw: f.raw,
        });
        const { queueMailboxAgentDraft } = await import("../src/mailbox-transport.js");
        outbox = await queueMailboxAgentDraft(
          db,
          keys,
          key.token,
          { id: draft.id, expectedRevision: draft.revision },
          mime,
        );
      } else outbox = await f.queued();
      const original = azureBudget.reserveMailboxAzureBudget;
      // Infrastructure scheduling barrier only: run REAL SQL reservation, then
      // commit a revocation before resolving that await. No policy/auth/quota mocks.
      vi.spyOn(azureBudget, "reserveMailboxAzureBudget").mockImplementation(async (d, i) => {
        const result = await original(d, i);
        expect(result).toBe("reserved");
        await Promise.resolve();
        if (kind === "relay")
          await db
            .update(schema.domains)
            .set({ relayEnabledAt: null })
            .where(eq(schema.domains.id, f.domain.id));
        if (kind === "domain")
          await db
            .update(schema.domains)
            .set({ status: "pending" })
            .where(eq(schema.domains.id, f.domain.id));
        if (kind === "standing")
          await db
            .update(schema.teams)
            .set({ sendReviewAt: new Date() })
            .where(eq(schema.teams.id, f.teamId));
        if (kind === "license")
          await db
            .update(schema.mailboxSubscriptions)
            .set({ periodEnd: new Date(Date.now() - 1) })
            .where(eq(schema.mailboxSubscriptions.teamId, f.teamId));
        if (kind === "membership")
          await db.delete(schema.teamMembers).where(eq(schema.teamMembers.teamId, f.teamId));
        if (kind === "agent-revoked")
          await db
            .update(schema.mailboxAgentKeys)
            .set({ revokedAt: new Date() })
            .where(eq(schema.mailboxAgentKeys.id, keyId!));
        if (kind === "agent-expired")
          await db
            .update(schema.mailboxAgentKeys)
            .set({ expiresAt: new Date(Date.now() - 1) })
            .where(eq(schema.mailboxAgentKeys.id, keyId!));
        return result;
      });
      const sent = await cloud(f, outbox);
      expect(sent.result.status).toBe("unknown");
      expect(sent.sendRaw).not.toHaveBeenCalled();
      expect(await daily(f.teamId)).toBe(1);
      expect(await receipts(f.teamId)).toHaveLength(2);
      await sendMailboxOutbox(db, keys, outbox.id, sent.sender, mime);
      expect(sent.sendRaw).not.toHaveBeenCalled();
    },
  );
  it("API and native mail share the global hourly budget across teams", async () => {
    const a = await setup();
    const b = await setup();
    await db.insert(schema.auditLog).values({
      teamId: a.teamId,
      actorId: "system",
      action: "sending.azure_quota_reserved",
      createdAt: new Date(Date.now() - 120000),
      data: { units: 100 },
    });
    const [email] = await db
      .insert(schema.emails)
      .values({
        teamId: b.teamId,
        from: b.box.address,
        to: ["one@example.invalid"],
        subject: "fixture",
      })
      .returning();
    expect(await claimAzureSend(db, { emailId: email!.id, teamId: b.teamId, recipients: 1 })).toBe(
      "quota",
    );
    const sent = await cloud(b);
    expect(sent.result.status).toBe("queued");
    expect(sent.sendRaw).not.toHaveBeenCalled();
    expect(await daily(b.teamId)).toBe(0);
    expect(await receipts(b.teamId)).toHaveLength(0);
  });
  it.each(["api-minute", "api-hour", "native-minute", "native-hour"])(
    "uses DB wall clock for expired %s units and new receipts in an older transaction",
    async (kind) => {
      const f = await setup();
      const outbox = await f.queued();
      const attemptId = randomUUID();
      await db
        .update(schema.mailboxOutbox)
        .set({ status: "sending", attemptId, attemptedAt: new Date() })
        .where(eq(schema.mailboxOutbox.id, outbox.id));
      const [email] = await db
        .insert(schema.emails)
        .values({
          teamId: f.teamId,
          from: f.box.address,
          to: ["one@example.invalid"],
          subject: "fixture",
        })
        .returning();
      await db.transaction(async (transaction) => {
        const tx = transaction as unknown as Db;
        const hour = kind.endsWith("hour");
        await tx.execute(
          sql`insert into audit_log (team_id,actor_id,action,created_at,data) values (${f.teamId},'system','sending.azure_quota_reserved', now() - (${hour ? "3599.9 seconds" : "59.9 seconds"})::interval, ${JSON.stringify({ units: hour ? 100 : 30 })}::jsonb)`,
        );
        await tx.execute(sql`select pg_sleep(0.25)`);
        if (kind.startsWith("api"))
          expect(
            await claimAzureSend(tx, { emailId: email!.id, teamId: f.teamId, recipients: 1 }),
          ).toBe("claimed");
        else
          expect(
            await azureBudget.reserveMailboxAzureBudget(tx, {
              outboxId: outbox.id,
              attemptId,
              teamId: f.teamId,
              mailboxId: f.box.id,
              recipients: 1,
            }),
          ).toBe("reserved");
        const result = await tx.execute(
          sql`select count(*)::int as n, bool_and(created_at > transaction_timestamp() + interval '0.2 seconds') as wall from audit_log where team_id=${f.teamId} and action in ('sending.azure_quota_reserved','sending.mailbox_azure_claimed') and (data->>'units'='1' or action='sending.mailbox_azure_claimed')`,
        );
        const rows = (
          Array.isArray(result) ? result : (result as unknown as { rows: unknown[] }).rows
        ) as { n: number; wall: boolean }[];
        expect(rows[0].n).toBe(kind.startsWith("api") ? 1 : 2);
        expect(rows[0].wall).toBe(true);
      });
    },
  );
});

import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMailboxExternalAwareSender } from "../../../apps/worker/src/mailbox-external-sender.js";
import {
  createMailboxSesSender,
  mailboxWorkerMime,
} from "../../../apps/worker/src/mailbox-sender.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import { createMailboxExternalAccount } from "../src/mailbox-external-accounts.js";
import { saveMailboxDraft } from "../src/mailbox-private-store.js";
import {
  acceptMailboxOutbox,
  checkMailboxRecipientBlocks,
  getMailboxOutboundSummary,
  type MailboxOutboundEvidence,
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
const unusedLegacyMime: MailboxTransportMimeAdapter = {
  async parse(raw) {
    const headers = raw.toString("utf8").split("\r\n\r\n")[0]!;
    return {
      from: /^From: (.+)$/m.exec(headers)?.[1]?.trim() ?? "",
      to: /^To: (.+)$/m.exec(headers)?.[1]?.trim().split(", ") ?? [],
      attachmentBytes: [],
    };
  },
};

const mime = mailboxWorkerMime;
beforeEach(async () => {
  client = new PGlite();
  const base = process.env.MEPMAIL_AZURE_FIXTURE_DDL_ROOT
    ? process.env.MEPMAIL_AZURE_FIXTURE_DDL_ROOT + "/drizzle/"
    : fileURLToPath(new URL("../../db/drizzle/", import.meta.url));
  const mail = process.env.MEPMAIL_AZURE_FIXTURE_DDL_ROOT
    ? process.env.MEPMAIL_AZURE_FIXTURE_DDL_ROOT + "/mailbox-drizzle/"
    : fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
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
afterEach(async () => {
  await client.close();
});

async function setup(multi = false) {
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
    .values({
      teamId,
      name: `${userId}.invalid`,
      status: "verified",
      relayEnabledAt: new Date(),
      region: "us-east-1",
    })
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
  const recipients = multi
    ? ["one@example.invalid", "two@example.invalid"]
    : ["one@example.invalid"];
  const raw = Buffer.from(
    `From: ${from}\r\nTo: ${recipients.join(", ")}\r\n${multi ? "Bcc: hidden@example.invalid\r\n" : ""}Subject: A direct reply\r\nMessage-ID: <original@fixture.invalid>\r\nIn-Reply-To: <prior@fixture.invalid>\r\nReferences: <prior@fixture.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=fixture\r\n\r\n--fixture\r\nContent-Type: text/plain\r\n\r\nPersonal reply\r\n--fixture\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=fixture.txt\r\nContent-Transfer-Encoding: base64\r\n\r\nZml4dHVyZQ==\r\n--fixture--\r\n`,
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
  return { actor, teamId, domain: domain!, box: box!, raw, recipients, queued };
}

import { azureEmailEventStore } from "../../../apps/web/src/server/azure-email-event-store.js";
import { createMailboxAzureSender } from "../../../apps/worker/src/mailbox-azure-sender.js";
import { claimAzureSend } from "../src/azure-send-claim.js";
import { mailboxRecipientHashFromPublicHash } from "../src/mailbox-transport.js";
import type { SendingProviderPolicy } from "../src/sending-provider-policy.js";

const receipt = "smtp-relay:azure:11111111-2222-4333-8444-555555555555";
function policy(f: Awaited<ReturnType<typeof setup>>): SendingProviderPolicy {
  return {
    version: 1,
    allowedTeamIds: [f.teamId],
    defaults: { transactional: "disabled", campaign: "disabled" },
    teams: { [f.teamId]: { transactional: "azure_smtp", campaign: "disabled" } },
    restoration: {
      teams: { [f.teamId]: { notBefore: "2020-01-01T00:00:00.000Z", senders: [f.box.address] } },
    },
  };
}
async function run(
  f: Awaited<ReturnType<typeof setup>>,
  mutate?: (p: SendingProviderPolicy) => void,
  sendRaw = vi.fn(async (_input: Parameters<SesSender["sendRaw"]>[0]) => ({ messageId: receipt })),
) {
  const p = policy(f);
  mutate?.(p);
  const sender = createMailboxAzureSender(db, {
    policy: p,
    isCloud: false,
    relay: { name: "azure", sender: { sendRaw } },
  });
  const outbox = await f.queued();
  const result = await sendMailboxOutbox(db, keys, outbox.id, sender, mime);
  return { result, sendRaw, sender, outbox };
}
// Quota receipts are global; isolate fixture tests without clearing business tables.
// Each case uses a fresh in-memory DB state for the provider audit reservations only.

describe("native Azure Correio through the real outbox", () => {
  it("sends one-recipient reply once, preserving encrypted Sent history and attachment", async () => {
    const f = await setup();
    const sent = await run(f);
    expect(sent.result.status).toBe("accepted");
    expect(sent.sendRaw).toHaveBeenCalledTimes(1);
    const wire = sent.sendRaw.mock.calls[0]![0];
    expect(wire.bcc).toEqual([]);
    expect(wire.raw.toString()).not.toMatch(/^Bcc:/im);
    expect(wire.raw.toString()).toContain("In-Reply-To: <prior@fixture.invalid>");
    expect(wire.raw.toString()).toContain("References: <prior@fixture.invalid>");
    expect(wire.raw.toString()).toContain("Zml4dHVyZQ==");
    expect((await sendMailboxOutbox(db, keys, sent.outbox.id, sent.sender, mime)).duplicate).toBe(
      true,
    );
    expect(sent.sendRaw).toHaveBeenCalledTimes(1);
    const [row] = await db
      .select()
      .from(schema.mailboxItems)
      .where(eq(schema.mailboxItems.id, sent.outbox.id));
    expect(row?.kind).toBe("sent");
    expect(row?.ciphertext).toBeTruthy();
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.teamId, f.teamId));
    expect(JSON.stringify(audit)).not.toContain("Personal reply");
    expect(JSON.stringify(audit)).not.toContain("hidden@example.invalid");
  });
  it.each(["paused", "tenant", "sender", "age", "marketing"])(
    "fails closed for policy %s",
    async (kind) => {
      const f = await setup();
      const sent = await run(f, (p) => {
        if (kind === "paused") p.paused = true;
        if (kind === "tenant") p.allowedTeamIds = [];
        if (kind === "sender") p.restoration!.teams[f.teamId]!.senders = ["other@example.invalid"];
        if (kind === "age") p.restoration!.teams[f.teamId]!.notBefore = "2099-01-01T00:00:00Z";
        if (kind === "marketing") p.teams![f.teamId]!.transactional = "disabled";
      });
      expect(sent.result.status).toBe("queued");
      expect(sent.sendRaw).not.toHaveBeenCalled();
    },
  );
  it("refuses an unlinked relay domain and revoked human rights", async () => {
    const f = await setup();
    await db
      .update(schema.domains)
      .set({ relayEnabledAt: null })
      .where(eq(schema.domains.id, f.domain.id));
    const held = await run(f);
    expect(held.result.status).toBe("queued");
    expect(held.sendRaw).not.toHaveBeenCalled();
    const outbox = await f.queued();
    await db.delete(schema.teamMembers).where(eq(schema.teamMembers.teamId, f.teamId));
    const result = await sendMailboxOutbox(db, keys, outbox.id, held.sender, mime);
    expect(result.status).toBe("failed");
    expect(held.sendRaw).not.toHaveBeenCalled();
  });
  it.each(["disconnect", "missing-receipt", "temporary-refusal"])(
    "never resends ambiguous %s",
    async (kind) => {
      const f = await setup();
      const send = vi.fn(async (_input: Parameters<SesSender["sendRaw"]>[0]) => {
        if (kind === "missing-receipt") return { messageId: "<rfc@fixture.invalid>" };
        throw Object.assign(
          new Error("synthetic"),
          kind === "temporary-refusal" ? { responseCode: 451, command: "DATA" } : {},
        );
      });
      const sent = await run(f, undefined, send);
      expect(sent.result.status).toBe("unknown");
      await sendMailboxOutbox(db, keys, sent.outbox.id, sent.sender, mime);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
  it("shares the API GLOBAL minute budget, not a mailbox-specific quota", async () => {
    const f = await setup();
    const [email] = await db
      .insert(schema.emails)
      .values({
        teamId: f.teamId,
        from: f.box.address,
        to: ["synthetic@example.invalid"],
        subject: "fixture",
      })
      .returning();
    expect(await claimAzureSend(db, { emailId: email!.id, teamId: f.teamId, recipients: 30 })).toBe(
      "claimed",
    );
    const held = await run(f);
    expect(held.result.status).toBe("queued");
    expect(held.sendRaw).not.toHaveBeenCalled();
  });
  it("applies authenticated callbacks to native history with durable dedupe and sticky recipient blocks", async () => {
    const f = await setup();
    const uniqueReceipt = "smtp-relay:azure:" + randomUUID();
    const sent = await run(
      f,
      undefined,
      vi.fn(async (_input: Parameters<SesSender["sendRaw"]>[0]) => ({ messageId: uniqueReceipt })),
    );
    expect(sent.result.status).toBe("accepted");
    const recipient = "one@example.invalid";
    expect(mailboxRecipientHashFromPublicHash(f.teamId, hashRecipient(recipient))).toBe(
      mailboxRecipientHash(f.teamId, recipient),
    );
    const event = {
      provider: "azure" as const,
      messageId: uniqueReceipt.split(":")[2]!,
      eventId: randomUUID(),
      status: "hard_bounce" as const,
      recipientHash: hashRecipient(recipient),
      eventTime: new Date().toISOString(),
      deliveryAttemptTime: new Date().toISOString(),
    };
    const store = azureEmailEventStore(db);
    await store.apply!([event]);
    await store.apply!([event]);
    const summary = await getMailboxOutboundSummary(db, {
      teamId: f.teamId,
      mailboxId: f.box.id,
      outboxId: sent.outbox.id,
    });
    expect(summary?.hardBounce).toBe(1);
    expect(
      await checkMailboxRecipientBlocks(db, { teamId: f.teamId, recipients: [recipient] }),
    ).toBe(false);
    await expect(store.apply!([{ ...event, status: "delivered" }])).rejects.toThrow();
    await expect(
      store.apply!([
        {
          ...event,
          eventId: randomUUID(),
          recipientHash: hashRecipient("stranger@example.invalid"),
        },
      ]),
    ).rejects.toThrow();
    expect(sent.sendRaw).toHaveBeenCalledTimes(1);
  });
});

it("diagnoses multi-recipient/Bcc incompatibility without bypassing campaign policy", async () => {
  const f = await setup(true);
  const sent = await run(f);
  expect(sent.result.status).toBe("queued");
  expect(sent.sendRaw).not.toHaveBeenCalled();
});
