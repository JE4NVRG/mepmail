import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import * as core from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { SesSender } from "../../../apps/worker/src/handlers/send-email.js";
import { createMailboxAzureSender } from "../../../apps/worker/src/mailbox-azure-sender.js";
import { createMailboxExternalAwareSender } from "../../../apps/worker/src/mailbox-external-sender.js";
import {
  createMailboxContentPolicySender,
  createMailboxSesSender,
  mailboxWorkerMime,
} from "../../../apps/worker/src/mailbox-sender.js";
import type { AbuseJudge, JudgeVerdict } from "../src/abuse-judge/types.js";
import { recordAzureRecipientOptout } from "../src/azure-recipient-optout.js";
import { createMailboxAgentKey } from "../src/mailbox-agent-access.js";
import * as azureBudget from "../src/mailbox-azure-budget.js";
import { prepareMailboxOptout } from "../src/mailbox-optout.js";
import { saveMailboxDraft } from "../src/mailbox-private-store.js";
import { mailboxSendHold } from "../src/mailbox-send-hold.js";
import {
  queueMailboxAgentDraft,
  queueMailboxDraft,
  sendMailboxOutbox,
} from "../src/mailbox-transport.js";
import { evaluatePreSendContent } from "../src/pre-send-content-policy.js";
import type { SendingProviderPolicy } from "../src/sending-provider-policy.js";

let db: Db, client: PGlite;
const observations: unknown[] = [];
const keys = new core.EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
const master = Buffer.alloc(32, 73);
process.env.MASTER_ENCRYPTION_KEY = master.toString("base64");
process.env.APP_BASE_URL = "https://optout.example.invalid";
const clean = {
  score: 0,
  verdict: "clean" as const,
  categories: [],
  reasons: [],
  impersonatedBrand: null,
  language: "en",
};
const abuse = {
  ...clean,
  score: 100,
  verdict: "abuse" as const,
  categories: ["phishing"],
  reasons: ["credential_theft"],
  impersonatedBrand: "AtlasBank",
};
const text =
  "Can we meet tomorrow?\nSynthetic Sender, Example Company\nhttps://example.invalid/contact";
const lure = "Verify your AtlasBank account password at https://account-check.example/verify";
const receipt = "smtp-relay:azure:11111111-2222-4333-8444-555555555555";
function judge(value: unknown = clean): AbuseJudge {
  return {
    provider: "openai",
    model: "synthetic-no-inference",
    judge: vi.fn(async () => value as JudgeVerdict),
  };
}
beforeAll(async () => {
  client = new PGlite();
  for (const relative of ["../../db/drizzle/", "../../db/mailbox-drizzle/"]) {
    const base = fileURLToPath(new URL(relative, import.meta.url));
    for (const name of readdirSync(base)
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await client.transaction(async (tx) => {
        for (const s of readFileSync(base + name, "utf8")
          .split("--> statement-breakpoint")
          .filter((s) => s.trim()))
          await tx.exec(s);
      });
  }
  db = drizzle(client, { schema }) as unknown as Db;
});
afterAll(async () => {
  writeFileSync(
    process.env.OBSERVATIONS_PATH ?? "/proof/observations.json",
    JSON.stringify(observations, null, 2),
  );
  await client?.close();
});
afterEach(() => {
  vi.restoreAllMocks();
});
async function fixture(provider = "azure", body = text, html?: string) {
  const userId = randomUUID();
  const [team] = await db
    .insert(schema.teams)
    .values({
      name: "Synthetic correspondence",
      slug: userId,
      createdAt: new Date("2025-01-01"),
      sendReviewClearedAt: new Date(),
    })
    .returning();
  const teamId = team!.id;
  await db.insert(schema.user).values({
    id: userId,
    name: "Synthetic",
    email: userId + "@example.invalid",
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
      name: userId + ".invalid",
      status: "verified",
      relayEnabledAt: new Date(),
      region: "us-east-1",
      sesConfigurationSet: "campaign-events",
    })
    .returning();
  const from = `person@${domain!.name}`;
  const box = await (async () => {
    if (provider === "external") {
      const account = await core.createMailboxExternalAccount(
        db,
        keys,
        { teamId, userId },
        {
          address: from,
          label: "Synthetic",
          secret: "synthetic",
          servers: {
            provider: "imap",
            imapHost: "imap.example.invalid",
            smtpHost: "smtp.example.invalid",
            smtpPort: 465,
            smtpSecurity: "tls",
            username: from,
          },
        },
      );
      const [row] = await db
        .select()
        .from(schema.mailboxes)
        .where(eq(schema.mailboxes.id, account.mailboxId));
      return row!;
    }
    const [row] = await db
      .insert(schema.mailboxes)
      .values({
        teamId,
        domainId: domain!.id,
        address: from,
        label: "Synthetic",
        kind: "person",
        ownerUserId: userId,
        ownerMembershipId: member!.id,
      })
      .returning();
    return row!;
  })();
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "active",
    seats: 2,
    storageBytesPerMailbox: 1048576,
    includedOutboundPerMailbox: 100,
    periodStart: new Date(Date.now() - 86400000),
    periodEnd: new Date(Date.now() + 86400000),
  });
  const to = ["one@example.invalid"];
  const compliance = await prepareMailboxOptout(db, teamId, to, {
    baseUrl: "https://optout.example.invalid",
    masterKey: master,
  });
  const headers = `From: Synthetic Sender <${from}>\r\nTo: ${to.join(", ")}\r\nReply-To: reply@example.invalid\r\nSubject: ${body === lure ? "Verify your AtlasBank account" : "A direct reply"}\r\nMessage-ID: <original@fixture.invalid>\r\nIn-Reply-To: <prior@fixture.invalid>\r\nReferences: <prior@fixture.invalid>\r\nList-Unsubscribe: ${compliance.headers["List-Unsubscribe"]}\r\nMIME-Version: 1.0\r\n`;
  const raw = Buffer.from(
    headers +
      (html === undefined
        ? `Content-Type: text/plain; charset=utf-8\r\n\r\n${body}${compliance.text}\r\n`
        : `Content-Type: multipart/alternative; boundary=fixture\r\n\r\n--fixture\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}${compliance.text}\r\n--fixture\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}${compliance.html}\r\n--fixture--\r\n`),
  );
  const actor = { teamId, userId };
  return { teamId, domain: domain!, box: box!, from, raw, actor, to, provider };
}
async function queued(f: Awaited<ReturnType<typeof fixture>>, raw = f.raw, agent = false) {
  const draft = await saveMailboxDraft(db, keys, f.actor, {
    mailboxId: f.box.id,
    expectedRevision: 0,
    raw,
  });
  if (agent) {
    const key = await createMailboxAgentKey(db, f.actor, {
      mailboxId: f.box.id,
      label: "Synthetic",
      scopes: ["send"],
      expiresAt: new Date(Date.now() + 3600000),
    });
    return queueMailboxAgentDraft(
      db,
      keys,
      key.token,
      { id: draft.id, expectedRevision: draft.revision },
      mailboxWorkerMime,
    );
  }
  return queueMailboxDraft(
    db,
    keys,
    f.actor,
    { mailboxId: f.box.id, id: draft.id, expectedRevision: draft.revision },
    mailboxWorkerMime,
  );
}
async function senderFor(f: Awaited<ReturnType<typeof fixture>>, contentJudge?: AbuseJudge | null) {
  type Captured = Partial<Parameters<SesSender["sendRaw"]>[0]> & {
    Content?: { Raw?: { Data?: Uint8Array | undefined } | undefined } | undefined;
    Destination?:
      | {
          ToAddresses?: string[] | undefined;
          CcAddresses?: string[] | undefined;
          BccAddresses?: string[] | undefined;
        }
      | undefined;
    FromEmailAddress?: string | undefined;
    envelope?: { from: string; to: string[] };
  };
  const send = vi.fn(async (_input: Captured) => ({ messageId: receipt }));
  const ses = createMailboxSesSender(db, {
    isCloud: true,
    contentJudge: contentJudge ?? null,
    configurationSets: { "us-east-1": "private-events" },
    clientFactory: () => ({
      send: async (command) => {
        await send(command.input);
        return { MessageId: "synthetic-ses" };
      },
    }),
  });

  const external = createMailboxExternalAwareSender(
    db,
    keys,
    ses,
    async () => ({ password: "synthetic" }),
    {
      isCloud: true,
      lookup: (async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as NonNullable<
        NonNullable<Parameters<typeof createMailboxExternalAwareSender>[4]>["lookup"]
      >,
      createTransport: (() => ({ sendMail: send, close: vi.fn() })) as unknown as NonNullable<
        NonNullable<Parameters<typeof createMailboxExternalAwareSender>[4]>["createTransport"]
      >,
    },
  );
  const policy: SendingProviderPolicy = {
    version: 1,
    allowedTeamIds: [f.teamId],
    defaults: { transactional: "disabled", campaign: "disabled" },
    teams: {
      [f.teamId]: {
        transactional:
          f.provider === "azure"
            ? "azure_smtp"
            : f.provider === "external"
              ? "customer_smtp"
              : "ses",
        campaign: "disabled",
      },
    },
    ...(f.provider === "azure"
      ? {
          restoration: {
            teams: { [f.teamId]: { notBefore: "2020-01-01T00:00:00.000Z", senders: [f.from] } },
          },
        }
      : {}),
  };
  const azure = createMailboxAzureSender(db, {
    policy,
    isCloud: true,
    contentJudge: contentJudge ?? null,
    relay: { name: "azure", sender: { sendRaw: send } },
  });
  const sender = createMailboxContentPolicySender(db, external, true, policy, azure, contentJudge);
  return { sender, send, policy };
}
async function state(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const [row] = await db.select().from(schema.mailboxOutbox).where(eq(schema.mailboxOutbox.id, id));
  const [counter] = await db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, f.teamId));
  const receipts = (
    await db.select().from(schema.auditLog).where(eq(schema.auditLog.teamId, f.teamId))
  ).filter((a) => a.action === "sending.mailbox_azure_claimed");
  return { row: row!, charged: counter?.accepted ?? 0, claims: receipts.length };
}
it.each(["azure", "ses", "external"])(
  "unlisted-brand semantic abuse has zero submits: %s",
  async (provider) => {
    const f = await fixture(provider, lure);
    const q = await queued(f);
    const j = judge(abuse);
    const s = await senderFor(f, j);
    expect(
      evaluatePreSendContent({
        from: f.from,
        subject: "Verify your AtlasBank account",
        text: lure,
        html: null,
      }),
    ).toEqual({ action: "allow" });
    const before = await state(f, q.id);
    const result = await sendMailboxOutbox(db, keys, q.id, s.sender, mailboxWorkerMime);
    if (process.env.BASELINE_WITNESS === "1") {
      expect(result.status).toBe("accepted");
      expect(s.send).toHaveBeenCalledTimes(1);
      expect(j.judge).not.toHaveBeenCalled();
      const wire = s.send.mock.calls[0]![0];
      expect(f.provider === "ses" ? Buffer.from(wire.Content!.Raw!.Data!) : wire.raw).toEqual(
        core.stripMailboxPrivateHeaders(f.raw),
      );
      if (f.provider === "ses") {
        expect(wire.FromEmailAddress).toBe(f.from);
        expect(wire.Destination).toEqual({ ToAddresses: f.to, CcAddresses: [], BccAddresses: [] });
      } else if (f.provider === "external")
        expect(wire.envelope).toEqual({ from: f.from, to: f.to });
      else {
        expect(wire.envelopeFrom).toBe(f.from);
        expect(wire.to).toEqual(f.to);
        expect(wire.cc).toEqual([]);
        expect(wire.bcc).toEqual([]);
      }
      observations.push({
        phase: "baseline",
        provider,
        status: result.status,
        providerSubmits: s.send.mock.calls.length,
        semanticCalls: vi.mocked(j.judge).mock.calls.length,
        deterministicVerdict: "allow",
      });
      return;
    }
    expect(result.status).toBe("queued");
    expect(s.send).not.toHaveBeenCalled();
    expect(j.judge).toHaveBeenCalledTimes(1);
    observations.push({
      phase: "candidate",
      provider,
      status: result.status,
      providerSubmits: s.send.mock.calls.length,
      semanticCalls: vi.mocked(j.judge).mock.calls.length,
      deterministicVerdict: "allow",
    });
    expect(vi.mocked(j.judge).mock.calls[0]![0]).toContain(lure);
    expect(vi.mocked(j.judge).mock.calls[0]![0]).toContain(f.from);
    const after = await state(f, q.id);
    expect(after.charged).toBe(0);
    expect(after.claims).toBe(0);
    expect(after.row.ciphertext).toEqual(before.row.ciphertext);
    expect(after.row.errorCode).toBe("mailbox_deferred:semantic_content_review");
    expect(mailboxSendHold(after.row)?.actionRequired).toBe("review");
  },
);
it.each(["azure", "ses", "external"].flatMap((p) => [false, true].map((h) => [p, h] as const)))(
  "clean text/HTML sends once with one quota and exact bytes: %s html=%s",
  async (provider, html) => {
    const f = await fixture(provider, text, html ? "<p>Can we meet tomorrow?</p>" : undefined);
    const q = await queued(f, f.raw, provider !== "external");
    const j = judge();
    const s = await senderFor(f, j);
    const result = await sendMailboxOutbox(db, keys, q.id, s.sender, mailboxWorkerMime);
    expect(result.status).toBe("accepted");
    expect(s.send).toHaveBeenCalledTimes(1);
    const wire = s.send.mock.calls[0]![0];
    const raw = provider === "ses" ? Buffer.from(wire.Content!.Raw!.Data!) : wire.raw!;
    if (provider === "ses") {
      expect(wire.FromEmailAddress).toBe(f.from);
      expect(wire.Destination).toEqual({ ToAddresses: f.to, CcAddresses: [], BccAddresses: [] });
    } else if (provider === "external") expect(wire.envelope).toEqual({ from: f.from, to: f.to });
    else {
      expect(wire.envelopeFrom).toBe(f.from);
      expect(wire.to).toEqual(f.to);
      expect(wire.cc).toEqual([]);
      expect(wire.bcc).toEqual([]);
    }
    expect(raw).toEqual(core.stripMailboxPrivateHeaders(f.raw));
    expect(raw.toString()).toContain("Reply-To: reply@example.invalid");
    expect(raw.toString()).toContain("References: <prior@fixture.invalid>");
    expect(
      vi.mocked(j.judge).mock.calls.some(([b]) => b.includes("https://example.invalid/contact")),
    ).toBe(true);
    expect((await state(f, q.id)).charged).toBe(1);
    const calls = vi.mocked(j.judge).mock.calls.length;
    expect(calls).toBe(html ? 2 : 1);
    await sendMailboxOutbox(db, keys, q.id, s.sender, mailboxWorkerMime);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(j.judge).toHaveBeenCalledTimes(calls);
  },
);
it.each(["missing", "error", "timeout", "malformed", "categories", "reasons", "brand", "risk"])(
  "judge %s fails closed",
  async (kind) => {
    const f = await fixture();
    const q = await queued(f);
    const j = judge(
      kind === "malformed"
        ? {}
        : kind === "categories"
          ? { ...clean, categories: ["phishing"] }
          : kind === "reasons"
            ? { ...clean, reasons: ["suspect"] }
            : kind === "brand"
              ? { ...clean, impersonatedBrand: "AtlasBank" }
              : kind === "risk"
                ? { ...clean, score: 99 }
                : clean,
    );
    if (kind === "error")
      vi.mocked(j.judge).mockRejectedValue(new Error("private-error-must-not-leak"));
    if (kind === "timeout")
      vi.mocked(j.judge).mockRejectedValue(new DOMException("synthetic", "TimeoutError"));
    const s = await senderFor(f, kind === "missing" ? null : j);
    expect((await sendMailboxOutbox(db, keys, q.id, s.sender, mailboxWorkerMime)).status).toBe(
      "queued",
    );
    expect(s.send).not.toHaveBeenCalled();
    const st = await state(f, q.id);
    expect(st.charged).toBe(0);
    expect(st.claims).toBe(0);
    expect(st.row.errorCode).toBe("mailbox_deferred:semantic_content_review");
  },
);
it.each([
  '<img src="https://assets.mepmail.dev/signature-logos/example.png?v=123" width="1" height="1">',
  '<p style="border-left:2px solid #333333">Synthetic signature</p>',
  '<p>Synthetic Sender</p><img src="https://assets.mepmail.dev/signature-logos/example.png?v=456" width="200" height="100">',
  "<p><script>synthetic</script></p>",
])("unsupported/copied signature markup is held without rewriting: %s", async (html) => {
  const f = await fixture("azure", text, html);
  const q = await queued(f);
  const before = await state(f, q.id);
  const j = judge();
  const s = await senderFor(f, j);
  expect((await sendMailboxOutbox(db, keys, q.id, s.sender, mailboxWorkerMime)).status).toBe(
    "queued",
  );
  expect(s.send).not.toHaveBeenCalled();
  expect(j.judge).not.toHaveBeenCalled();
  expect((await state(f, q.id)).row.ciphertext).toEqual(before.row.ciphertext);
});
it("unknown Azure acceptance keeps lifetime/quota and cannot replay", async () => {
  const f = await fixture();
  const q = await queued(f);
  const s = await senderFor(f, judge());
  s.send.mockRejectedValue(new Error("synthetic disconnect"));
  expect((await sendMailboxOutbox(db, keys, q.id, s.sender, mailboxWorkerMime)).status).toBe(
    "unknown",
  );
  const st = await state(f, q.id);
  expect(st.charged).toBe(1);
  expect(st.claims).toBe(1);
  await sendMailboxOutbox(db, keys, q.id, s.sender, mailboxWorkerMime);
  expect(s.send).toHaveBeenCalledTimes(1);
});
it.each(["paused", "tenant", "standing", "consent", "quota", "revoked"])(
  "existing %s boundary still denies",
  async (kind) => {
    const f = await fixture();
    const q = await queued(f);
    const s = await senderFor(f, judge());
    if (kind === "paused") s.policy.paused = true;
    if (kind === "tenant") s.policy.allowedTeamIds = [];
    if (kind === "standing")
      await db
        .update(schema.teams)
        .set({ suspendedAt: new Date() })
        .where(eq(schema.teams.id, f.teamId));
    if (kind === "consent")
      await recordAzureRecipientOptout(db, {
        teamId: f.teamId,
        recipientHash: core.hashRecipient(f.to[0]!),
      });
    if (kind === "quota")
      await db
        .insert(schema.usageCounters)
        .values({ teamId: f.teamId, day: new Date().toISOString().slice(0, 10), accepted: 100000 });
    if (kind === "revoked")
      await db.delete(schema.teamMembers).where(eq(schema.teamMembers.teamId, f.teamId));
    expect((await sendMailboxOutbox(db, keys, q.id, s.sender, mailboxWorkerMime)).status).not.toBe(
      "accepted",
    );
    expect(s.send).not.toHaveBeenCalled();
    expect((await state(f, q.id)).claims).toBe(0);
  },
);
it("authority revoked after durable claim remains unknown without refund or provider call", async () => {
  const f = await fixture();
  const q = await queued(f);
  const s = await senderFor(f, judge());
  const reserve = azureBudget.reserveMailboxAzureBudget;
  vi.spyOn(azureBudget, "reserveMailboxAzureBudget").mockImplementation(async (d, input) => {
    const result = await reserve(d, input);
    expect(result).toBe("reserved");
    await db.delete(schema.teamMembers).where(eq(schema.teamMembers.teamId, f.teamId));
    return result;
  });
  expect((await sendMailboxOutbox(db, keys, q.id, s.sender, mailboxWorkerMime)).status).toBe(
    "unknown",
  );
  expect(s.send).not.toHaveBeenCalled();
  const st = await state(f, q.id);
  expect(st.charged).toBe(1);
  expect(st.claims).toBe(1);
  await sendMailboxOutbox(db, keys, q.id, s.sender, mailboxWorkerMime);
  expect(s.send).not.toHaveBeenCalled();
});
it.each(["revoked", "expired"])(
  "current agent %s authority denies before semantic/provider admission",
  async (kind) => {
    const f = await fixture();
    const q = await queued(f, f.raw, true);
    const s = await senderFor(f, judge());
    const before = await state(f, q.id);
    const keyId = before.row.agentKeyId;
    expect(keyId).toBeTruthy();
    if (kind === "revoked")
      await db
        .update(schema.mailboxAgentKeys)
        .set({ revokedAt: new Date() })
        .where(eq(schema.mailboxAgentKeys.id, keyId!));
    else {
      const [key] = await db
        .select()
        .from(schema.mailboxAgentKeys)
        .where(eq(schema.mailboxAgentKeys.id, keyId!));
      expect(key?.expiresAt).toBeInstanceOf(Date);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(key!.expiresAt!.getTime() + 1000);
    }
    try {
      expect((await sendMailboxOutbox(db, keys, q.id, s.sender, mailboxWorkerMime)).status).toBe(
        "failed",
      );
      expect(s.send).not.toHaveBeenCalled();
      expect((await state(f, q.id)).claims).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);
it("unsupported attachment preserves sealed MIME and reaches no lifetime claim", async () => {
  const f = await fixture();
  const raw = Buffer.from(
    f.raw
      .toString()
      .replace(
        "Content-Type: text/plain; charset=utf-8\r\n\r\n",
        "Content-Type: multipart/mixed; boundary=attachment\r\n\r\n--attachment\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n",
      ) +
      "\r\n--attachment\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=synthetic.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nc3ludGhldGlj\r\n--attachment--\r\n",
  );
  const q = await queued(f, raw);
  const before = await state(f, q.id);
  const j = judge();
  const s = await senderFor(f, j);
  expect((await sendMailboxOutbox(db, keys, q.id, s.sender, mailboxWorkerMime)).status).toBe(
    "queued",
  );
  expect(s.send).not.toHaveBeenCalled();
  expect(j.judge).not.toHaveBeenCalled();
  const after = await state(f, q.id);
  expect(after.claims).toBe(0);
  expect(after.charged).toBe(0);
  for (const key of [
    "ciphertext",
    "iv",
    "wrappedDek",
    "keyVersion",
    "rawSha256",
    "recipientHashes",
  ] as const)
    expect(after.row[key]).toEqual(before.row[key]);
});
