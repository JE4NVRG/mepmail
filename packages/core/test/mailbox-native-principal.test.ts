import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import type { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAbuseJudge } from "../../../apps/worker/src/abuse-judge/index.js";
import { createMailboxExternalAwareSender } from "../../../apps/worker/src/mailbox-external-sender.js";
import {
  createMailboxContentPolicySender,
  createMailboxSesSender,
} from "../../../apps/worker/src/mailbox-sender.js";
import { ABUSE_JUDGE_QUESTIONS } from "../src/abuse-judge/questions.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import {
  authorizeGraduatedExternalSender,
  authorizeGraduatedSender,
  getGraduatedSenderReputation,
  getTenantReputation,
  reserveGraduatedSending,
} from "../src/graduated-sending.js";
import { getGraduatedSendingContext } from "../src/graduated-sending-context.js";
import { createMailboxExternalAccount } from "../src/mailbox-external-accounts.js";
import { saveMailboxDraft, withMailboxSendAccess } from "../src/mailbox-private-store.js";
import {
  createMailboxRegistry,
  grantMailboxRegistry,
  revokeMailboxRegistry,
} from "../src/mailbox-registry.js";
import {
  mailboxServiceEntitlement,
  requireMailboxOperationalPlan,
} from "../src/mailbox-service.js";
import {
  assertMailboxOutboxSendAccess,
  type MailboxOutboxSender,
  type MailboxTransportMimeAdapter,
  queueMailboxDraft,
  sendMailboxOutbox,
} from "../src/mailbox-transport.js";
import { teamQuota } from "../src/plans.js";

const { epoch } = vi.hoisted(() => {
  const at = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  return { epoch: at };
});
let fixture: Awaited<ReturnType<typeof createTestDb>>;
let db: Db;
let sequence = 0;
let models = 0;
let claims = 0;
let sqlClocks = 0;
let credits = 10;
let duringModel: (() => Promise<void>) | undefined;
let beforePhysical: (() => Promise<void>) | undefined;
let tailAfterCommit: (() => void) | undefined;
let tailArmed = false;
let tailHooks = 0;
const keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
const dialect = new PgDialect();
function record(name: string, data: unknown) {
  if (process.env.NATIVE_CASE_REPORT)
    appendFileSync(process.env.NATIVE_CASE_REPORT, JSON.stringify({ name, data }) + "\n");
}
const policy = {
  version: 1,
  graduated: true,
  paused: false,
  defaults: { transactional: "ses", campaign: "disabled" },
} as const;
const mime: MailboxTransportMimeAdapter = {
  async parse(raw) {
    return {
      from: /^From: (.+)$/m.exec(raw.toString())![1]!.trim(),
      to: [/^To: (.+)$/m.exec(raw.toString())![1]!.trim()],
      attachmentBytes: [],
    };
  },
};
// The only fixture query adapter is a real parameterized SQL projection of the
// production DB wall clock. Preserve every business query, including nested tx.
function clocked(target: Db, depth = 0): Db {
  return new Proxy(target, {
    get(t, key) {
      if (key === "transaction")
        return async (operation: (tx: Db) => Promise<unknown>) => {
          const result = await t.transaction((tx) =>
            operation(clocked(tx as unknown as Db, depth + 1)),
          );
          // Advance only after the original outer transaction has COMMITTED.
          // All reputation/financial/seat/domain reads ran with the fresh clock.
          if (depth === 0 && tailArmed) {
            tailArmed = false;
            tailAfterCommit?.();
          }
          return result;
        };
      if (key === "execute")
        return (query: SQL | string) => {
          const statement = typeof query === "string" ? query : dialect.sqlToQuery(query).sql;
          if (statement.trim() === "select clock_timestamp()::text as at") {
            sqlClocks++;
            return t.execute(sql`select ${new Date().toISOString()}::timestamptz::text as at`);
          }
          return t.execute(query);
        };
      const value = Reflect.get(t, key);
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}
beforeAll(async () => {
  fixture = await createTestDb();
  const client = (fixture.db as unknown as { $client: PGlite }).$client;
  const directory = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
  for (const file of readdirSync(directory)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await client.transaction(async (tx) => {
      for (const statement of readFileSync(directory + file, "utf8").split(
        "--> statement-breakpoint",
      ))
        if (statement.trim()) await tx.exec(statement);
    });
  db = clocked(fixture.db);
});
afterAll(async () => {
  try {
    await fixture?.close();
  } finally {
    vi.useRealTimers();
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.setSystemTime(epoch + ++sequence * 120000);
  models = 0;
  claims = 0;
  sqlClocks = 0;
  credits = 10;
  duringModel = undefined;
  beforePhysical = undefined;
  tailAfterCommit = undefined;
  tailArmed = false;
  tailHooks = 0;
  vi.stubEnv("SENDING_PROVIDER_POLICY_JSON", JSON.stringify(policy));
  vi.stubEnv("ABUSE_JUDGE", "openai");
  vi.stubEnv("ABUSE_JUDGE_BASE_URL", "https://api.commandcode.ai/provider/v1");
  vi.stubEnv("ABUSE_JUDGE_MODEL", "deepseek/deepseek-v4.1-flash");
  vi.stubEnv("ABUSE_JUDGE_API_KEY", "synthetic-fixture-only");
  vi.spyOn(SESv2Client.prototype, "send").mockImplementation((async (command: object) => {
    if (command.constructor.name !== "GetAccountCommand") throw new Error("REAL_AWS_FORBIDDEN");
    return {
      SendingEnabled: true,
      ProductionAccessEnabled: true,
      EnforcementStatus: "HEALTHY",
      SendQuota: { Max24HourSend: 54900, MaxSendRate: 14, SentLast24Hours: 0 },
    };
  }) as never);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) === "https://api.commandcode.ai/alpha/billing/credits") {
        expect(init?.method).toBe("GET");
        return Response.json({
          credits: {
            monthlyCredits: credits,
            purchasedCredits: 0,
            freeCredits: 0,
            belowThreshold: false,
          },
          windowLimits: {
            exceeded: false,
            fiveHour: { used: 0, cap: 100, resetAt: Date.now() + 3600000 },
            weekly: { used: 0, cap: 100, resetAt: Date.now() + 3600000 },
          },
        });
      }
      expect(String(url)).toBe("https://api.commandcode.ai/provider/v1/chat/completions");
      models++;
      expect(JSON.parse(String(init?.body)).max_tokens).toBe(2048);
      await duringModel?.();
      const answers = Object.fromEntries(
        Object.entries(ABUSE_JUDGE_QUESTIONS).map(([k, q]) => [
          k,
          q.type === "choice" ? Object.keys(q.criteria)[0] : 0,
        ]),
      );
      return Response.json({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answers) } }],
        usage: { prompt_tokens: 200, completion_tokens: 100 },
      });
    }),
  );
});

async function realm(mode: "owner" | "grant" | "external" = "owner", system = false) {
  const teamId = await createTeam(db, randomUUID());
  if (system)
    await db.update(schema.teams).set({ plan: "system" }).where(eq(schema.teams.id, teamId));
  const a = randomUUID(),
    b = randomUUID();
  await db.insert(schema.user).values(
    [a, b].map((id) => ({
      id,
      name: "Synthetic authority",
      email: `${id}@example.invalid`,
      emailVerified: true,
      ...(system && id === a
        ? { createdAt: new Date(Date.UTC(2000, 0, 1) - sequence * 86400000) }
        : {}),
    })),
  );
  const members = await db
    .insert(schema.teamMembers)
    .values([
      { teamId, userId: a, role: "owner" },
      { teamId, userId: b, role: "member" },
    ])
    .returning();
  const memberA = members.find((m) => m.userId === a)!,
    memberB = members.find((m) => m.userId === b)!;
  const admin = { teamId, userId: a },
    actor = { teamId, userId: b };
  const name = `${teamId}.example.invalid`,
    now = new Date();
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name,
      region: "us-east-1",
      status: "verified",
      verifiedAt: now,
      relayEnabledAt: now,
      lastCheckedAt: now,
      dmarcCheckedAt: now,
      dkimSelector: "fixture",
      mailFromSubdomain: "send",
      dmarcPolicy: "none",
      dnsRecords: [
        { group: "verification", type: "TXT", name: `fixture._domainkey.${name}`, status: "found" },
        { group: "sending", type: "TXT", name: `send.${name}`, status: "found" },
        { group: "sending", type: "MX", name: `send.${name}`, status: "found" },
        { group: "dmarc", type: "TXT", name: `_dmarc.${name}`, status: "found" },
      ],
    })
    .returning();
  // Original native financial fixture contract, never fabricated outbox/claim/audit.
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "active",
    seats: 2,
    storageBytesPerMailbox: 1048576,
    includedOutboundPerMailbox: 100,
    periodStart: new Date(Date.now() - (system ? 44 : 1) * 86400000),
    periodEnd: new Date(Date.now() + (system ? -14 : 1) * 86400000),
  });
  const mailboxId =
    mode === "external"
      ? (
          await createMailboxExternalAccount(db, keys, actor, {
            address: `${b}@gmail.com`,
            label: "Synthetic external",
            servers: {
              provider: "gmail",
              imapHost: "imap.gmail.com",
              smtpHost: "smtp.gmail.com",
              smtpPort: 465,
              smtpSecurity: "tls",
              username: `${b}@gmail.com`,
            },
            secret: "synthetic-fixture-password",
          })
        ).mailboxId
      : (
          await createMailboxRegistry(db, admin, {
            domainId: domain!.id,
            localPart: "person",
            label: "Synthetic native",
            kind: "person",
            ownerUserId: mode === "grant" ? a : b,
          })
        ).id;
  const grant =
    mode === "grant"
      ? await grantMailboxRegistry(db, admin, { mailboxId, userId: b, permission: "send" })
      : null;
  const from = mode === "external" ? `${b}@gmail.com` : `person@${name}`;
  const raw = Buffer.from(
    `From: ${from}\r\nTo: recipient@example.invalid\r\nSubject: Tomorrow\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello, can we talk tomorrow?`,
  );
  await withMailboxSendAccess(db, actor, mailboxId, async (_tx, id) => {
    expect(id).toBe(memberB.id);
  });
  const draft = await saveMailboxDraft(db, keys, actor, { mailboxId, expectedRevision: 0, raw });
  const queued = await queueMailboxDraft(
    db,
    keys,
    actor,
    { mailboxId, id: draft.id, expectedRevision: draft.revision },
    mime,
  );
  const [row] = await db
    .select()
    .from(schema.mailboxOutbox)
    .where(eq(schema.mailboxOutbox.id, queued.id));
  expect(row).toMatchObject({
    approvedBy: b,
    approvedMembershipId: memberB.id,
    approvalKind: "human",
    status: "queued",
    attemptId: null,
  });
  return {
    teamId,
    a,
    b,
    actor,
    admin,
    memberA,
    memberB,
    domainId: domain!.id,
    mailboxId,
    from,
    queued,
    grant,
    mode,
  };
}
type Realm = Awaited<ReturnType<typeof realm>>;
function sender(f: Realm) {
  const transport = vi.fn(async () => ({
    MessageId: "synthetic-accepted",
    messageId: "synthetic-accepted",
  }));
  const ses = createMailboxSesSender(db, {
    isCloud: true,
    configurationSets: { "us-east-1": "native_fixture_events" },
    throttle: async () => {
      await beforePhysical?.();
    },
    clientFactory: () => ({ send: transport }),
  });
  const adapter =
    f.mode === "external"
      ? createMailboxExternalAwareSender(
          db,
          keys,
          {
            send: vi.fn(() => {
              throw new Error("EXTERNAL_SES_FORBIDDEN");
            }),
          },
          undefined,
          {
            isCloud: true,
            lookup: (async () => {
              await beforePhysical?.();
              return [{ address: "142.250.0.109", family: 4 }];
            }) as never,
            createTransport: (() => ({ sendMail: transport, close() {} })) as never,
          },
        )
      : ses;
  const judge = createAbuseJudge({
    provider: "openai",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    model: "deepseek/deepseek-v4.1-flash",
    apiKey: "synthetic-fixture-only",
    timeoutMs: 20000,
  })!;
  const wrapped = createMailboxContentPolicySender(db, adapter, true, policy, null, judge);
  const send = async (input: Parameters<MailboxOutboxSender["send"]>[0]) => {
    claims++;
    const [claimed] = await db
      .select()
      .from(schema.mailboxOutbox)
      .where(eq(schema.mailboxOutbox.id, input.outboxId));
    expect(claimed).toMatchObject({
      status: "sending",
      approvedBy: f.b,
      attemptId: input.attemptId,
    });
    return wrapped.send(input);
  };
  return { send, transport };
}
async function issue(f: Realm, context: Awaited<ReturnType<typeof getGraduatedSendingContext>>) {
  return f.mode === "external"
    ? authorizeGraduatedExternalSender(
        db,
        { teamId: f.teamId, actorUserId: f.b, from: f.from, mailboxId: f.mailboxId },
        context,
      )
    : authorizeGraduatedSender(
        db,
        {
          teamId: f.teamId,
          actorUserId: f.b,
          from: f.from,
          domainId: f.domainId,
          mailboxId: f.mailboxId,
        },
        context,
      );
}
async function ledger(f: Realm) {
  const rows = await db
    .select()
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.teamId, f.teamId),
        eq(schema.auditLog.action, "sending.graduated_reserved"),
      ),
    );
  const attempts: unknown = await db.execute(
    sql`select state,actual_units::text as units from sending_judge_attempts where team_id=${f.teamId}`,
  );
  return {
    rows,
    attempts: Array.isArray(attempts) ? attempts : (attempts as { rows: unknown[] }).rows,
  };
}
async function remove(f: Realm, who: "a" | "b", recreate = false) {
  await db
    .delete(schema.teamMembers)
    .where(eq(schema.teamMembers.id, who === "a" ? f.memberA.id : f.memberB.id));
  if (recreate)
    await db
      .insert(schema.teamMembers)
      .values({ teamId: f.teamId, userId: f[who], role: who === "a" ? "owner" : "member" });
}

if (process.env.NATIVE_FRESHNESS_TAIL_ONLY !== "1")
  describe("native registered principal A / actual approver B", () => {
    for (const mode of ["owner", "grant", "external"] as const)
      it(`real caller admits ${mode} B once without impersonating A`, async () => {
        const f = await realm(mode),
          send = sender(f);
        const result = await sendMailboxOutbox(db, keys, f.queued.id, send, mime);
        // Preserve a causal RED witness even though the real dispatcher safely maps
        // the constructor's registered_sender_required into a review hold.
        let reason: unknown = null;
        try {
          await issue(
            f,
            await getGraduatedSendingContext(mode === "external" ? { purpose: "judge" } : {}),
          );
        } catch (e) {
          reason = (e as { reason?: string }).reason;
        }
        console.log(
          "NATIVE_PRINCIPAL_CASE",
          JSON.stringify({
            mode,
            result,
            constructorReason: reason,
            claims,
            models,
            physical: send.transport.mock.calls.length,
          }),
        );
        expect(result.status, String(reason)).toBe("accepted");
        expect(claims).toBe(1);
        expect(models).toBe(1);
        expect(send.transport).toHaveBeenCalledTimes(1);
        const before = await ledger(f);
        record(`accepted-${mode}`, {
          result,
          principal: f.a,
          approver: f.b,
          claims,
          models,
          physical: send.transport.mock.calls.length,
          admissions: before.rows.length,
          attempts: before.attempts,
        });
        expect(before.rows).toHaveLength(1);
        expect(before.rows[0]!.data).toMatchObject({
          version: 1,
          units: 1,
          transport: mode === "external" ? "external" : "ses",
        });
        expect(before.attempts).toEqual([{ state: "settled", units: "180000" }]);
        const approval = await db
          .select()
          .from(schema.auditLog)
          .where(
            and(
              eq(schema.auditLog.teamId, f.teamId),
              eq(schema.auditLog.action, "mailbox.send_approved"),
            ),
          );
        expect(approval).toHaveLength(1);
        expect(approval[0]).toMatchObject({
          actorId: `user:${f.b}`,
          data: { outboxId: f.queued.id },
        });
        const debt: unknown = await db.execute(
          sql`select debt_units::text as units from sending_judge_account_debt where account_key='commandcode-primary'`,
        );
        expect(
          Number(
            (Array.isArray(debt) ? debt : (debt as { rows: { units: string }[] }).rows)[0].units,
          ),
        ).toBeGreaterThanOrEqual(180000);
        await sendMailboxOutbox(db, keys, f.queued.id, send, mime);
        expect(await ledger(f)).toEqual(before);
        expect(
          await db.execute(
            sql`select debt_units::text as units from sending_judge_account_debt where account_key='commandcode-primary'`,
          ),
        ).toEqual(debt);
        record(`replay-${mode}`, {
          claims,
          models,
          physical: send.transport.mock.calls.length,
          debtUnchanged: true,
        });
        expect(claims).toBe(1);
        expect(models).toBe(1);
        expect(send.transport).toHaveBeenCalledTimes(1);
        expect(sqlClocks).toBeGreaterThan(0);
        if (mode === "external") expect(SESv2Client.prototype.send).not.toHaveBeenCalled();
      });
    for (const kind of [
      "removed_B",
      "recreated_B",
      "revoked_grant",
      "removed_A",
      "held_A",
      "insufficient_budget",
    ] as const)
      it(`refuses ${kind} before claim/model`, async () => {
        const f = await realm(kind === "revoked_grant" ? "grant" : "owner"),
          send = sender(f);
        if (kind === "removed_B" || kind === "recreated_B")
          await remove(f, "b", kind === "recreated_B");
        if (kind === "revoked_grant") await revokeMailboxRegistry(db, f.admin, f.grant!.id);
        if (kind === "removed_A") await remove(f, "a");
        if (kind === "held_A")
          await db
            .update(schema.teams)
            .set({ sendReviewAt: new Date() })
            .where(eq(schema.teams.id, f.teamId));
        if (kind === "insufficient_budget") credits = 5;
        const result = await sendMailboxOutbox(db, keys, f.queued.id, send, mime);
        expect(result.status).not.toBe("accepted");
        expect(claims).toBe(0);
        expect(models).toBe(0);
        expect(send.transport).not.toHaveBeenCalled();
        expect(await ledger(f)).toEqual({ rows: [], attempts: [] });
      });
    for (const kind of [
      "removed_B",
      "recreated_B",
      "removed_A",
      "recreated_A",
      "revoked_grant",
    ] as const)
      it(`rechecks original proof after await: ${kind}`, async () => {
        const f = await realm(kind === "revoked_grant" ? "grant" : "owner"),
          context = await getGraduatedSendingContext();
        const proof = await issue(f, context);
        expect((await getGraduatedSenderReputation(db, proof, context)).state).toBe(
          "domain_verified",
        );
        if (kind === "revoked_grant") await revokeMailboxRegistry(db, f.admin, f.grant!.id);
        else await remove(f, kind.endsWith("A") ? "a" : "b", kind.startsWith("recreated"));
        await expect(getGraduatedSenderReputation(db, proof, context)).rejects.toMatchObject({
          reason: "registered_sender_required",
        });
        await expect(
          reserveGraduatedSending(
            db,
            {
              teamId: f.teamId,
              emailId: f.queued.id,
              from: f.from,
              recipients: ["recipient@example.invalid"],
              campaign: false,
              senderProof: proof,
            },
            context,
          ),
        ).rejects.toMatchObject({ reason: "registered_sender_required" });
        expect(await ledger(f)).toEqual({ rows: [], attempts: [] });
      });
    for (const kind of ["removed_B", "removed_A", "revoked_grant", "unverified_A"] as const)
      it(`post-model ${kind} clears only its claim and retains settled debt`, async () => {
        const f = await realm(kind === "revoked_grant" ? "grant" : "owner"),
          send = sender(f);
        duringModel = async () => {
          expect(claims).toBe(1);
          expect(models).toBe(1);
          if (kind === "revoked_grant") await revokeMailboxRegistry(db, f.admin, f.grant!.id);
          else if (kind === "unverified_A")
            await db
              .update(schema.user)
              .set({ emailVerified: false })
              .where(eq(schema.user.id, f.a));
          else await remove(f, kind === "removed_A" ? "a" : "b");
        };
        const result = await sendMailboxOutbox(db, keys, f.queued.id, send, mime);
        expect(claims).toBe(1);
        expect(models).toBe(1);
        expect(send.transport).not.toHaveBeenCalled();
        expect(result.status).toBe("queued");
        expect((await ledger(f)).attempts).toEqual([{ state: "settled", units: "180000" }]);
        const [row] = await db
          .select()
          .from(schema.mailboxOutbox)
          .where(eq(schema.mailboxOutbox.id, f.queued.id));
        expect(row).toMatchObject({ approvedBy: f.b, attemptId: null, attemptedAt: null });
      });
    it("rechecks B at final SES throttle boundary after clean model", async () => {
      const f = await realm(),
        send = sender(f);
      beforePhysical = async () => {
        expect(models).toBe(1);
        await remove(f, "b");
      };
      const result = await sendMailboxOutbox(db, keys, f.queued.id, send, mime);
      expect(claims).toBe(1);
      expect(models).toBe(1);
      expect(send.transport).not.toHaveBeenCalled();
      expect(result.status).toBe("queued");
      expect((await ledger(f)).attempts).toEqual([{ state: "settled", units: "180000" }]);
    });
    it("rechecks the exact current sender-domain name at the final physical boundary", async () => {
      const f = await realm(),
        adapter = sender(f);
      beforePhysical = async () => {
        expect(models).toBe(1);
        await db
          .update(schema.domains)
          .set({ name: `${randomUUID()}.example.invalid` })
          .where(eq(schema.domains.id, f.domainId));
      };
      const result = await sendMailboxOutbox(db, keys, f.queued.id, adapter, mime);
      expect(claims).toBe(1);
      expect(models).toBe(1);
      expect(adapter.transport).not.toHaveBeenCalled();
      expect(result.status).toBe("queued");
      expect((await ledger(f)).attempts).toEqual([{ state: "settled", units: "180000" }]);
    });
    it("does not decrypt or backfill a counterfeit legacy outbox without original approval audit", async () => {
      const f = await realm(),
        adapter = sender(f);
      const [source] = await db
        .select()
        .from(schema.mailboxOutbox)
        .where(eq(schema.mailboxOutbox.id, f.queued.id));
      // Negative only: clone a real queued snapshot into a distinct, unapproved
      // draft/outbox identity to represent a legacy or forged provenance row.
      // No positive case inserts its own business claim/admission/audit.
      const raw = Buffer.from(
        `From: ${f.from}\r\nTo: recipient@example.invalid\r\nSubject: Legacy\r\n\r\nHello`,
      );
      const draft = await saveMailboxDraft(db, keys, f.actor, {
        mailboxId: f.mailboxId,
        expectedRevision: 0,
        raw,
      });
      const id = randomUUID();
      await db
        .insert(schema.mailboxOutbox)
        .values({ ...source!, id, draftId: draft.id, draftRevision: draft.revision });
      const unwrap = vi
        .spyOn(keys, "unwrapDek")
        .mockRejectedValue(new Error("UNPROVEN_ROW_MUST_NOT_REACH_DECRYPT"));
      const result = await sendMailboxOutbox(db, keys, id, adapter, mime);
      expect(result).toMatchObject({
        status: "queued",
        errorCode: "mailbox_deferred:review_required",
      });
      expect(unwrap).not.toHaveBeenCalled();
      expect(claims).toBe(0);
      expect(models).toBe(0);
      expect(adapter.transport).not.toHaveBeenCalled();
      expect(await ledger(f)).toEqual({ rows: [], attempts: [] });
    });
    it("rechecks B after claim and before model at an awaited adapter boundary", async () => {
      const f = await realm(),
        adapter = sender(f);
      const result = await sendMailboxOutbox(
        db,
        keys,
        f.queued.id,
        {
          send: async (input) => {
            await remove(f, "b");
            return adapter.send(input);
          },
        },
        mime,
      );
      expect(claims).toBe(1);
      expect(models).toBe(0);
      expect(adapter.transport).not.toHaveBeenCalled();
      expect(result.status).toBe("queued");
      expect((await ledger(f)).attempts).toEqual([]);
    });
    it("retains the external credential generation fence after model and on proof reuse", async () => {
      const f = await realm("external"),
        adapter = sender(f),
        context = await getGraduatedSendingContext({ purpose: "judge" });
      const proof = await issue(f, context);
      expect((await getGraduatedSenderReputation(db, proof, context)).state).toBe("verified");
      duringModel = async () => {
        expect(models).toBe(1);
        await db
          .update(schema.mailboxExternalAccounts)
          .set({
            connectionGeneration: sql`${schema.mailboxExternalAccounts.connectionGeneration}+1`,
          })
          .where(eq(schema.mailboxExternalAccounts.mailboxId, f.mailboxId));
      };
      const result = await sendMailboxOutbox(db, keys, f.queued.id, adapter, mime);
      expect(claims).toBe(1);
      expect(models).toBe(1);
      expect(adapter.transport).not.toHaveBeenCalled();
      expect(result.status).toBe("queued");
      expect((await ledger(f)).attempts).toEqual([{ state: "settled", units: "180000" }]);
      await expect(getGraduatedSenderReputation(db, proof, context)).rejects.toMatchObject({
        reason: "registered_sender_required",
      });
      expect(SESv2Client.prototype.send).not.toHaveBeenCalled();
    });
    it("expires the same original observation without restamping its native proof", async () => {
      const f = await realm(),
        context = await getGraduatedSendingContext(),
        proof = await issue(f, context);
      expect((await getGraduatedSenderReputation(db, proof, context)).state).toBe(
        "domain_verified",
      );
      vi.setSystemTime(Date.now() + 5001);
      await expect(getGraduatedSenderReputation(db, proof, context)).rejects.toMatchObject({
        reason: "capacity_unavailable",
      });
      await expect(
        reserveGraduatedSending(
          db,
          {
            teamId: f.teamId,
            emailId: f.queued.id,
            from: f.from,
            recipients: ["recipient@example.invalid"],
            campaign: false,
            senderProof: proof,
          },
          context,
        ),
      ).rejects.toThrow();
      expect(await ledger(f)).toEqual({ rows: [], attempts: [] });
    });
    it("rejects DTO authority, cross-tenant mailbox, wrong domain, and cloned capabilities", async () => {
      const f = await realm(),
        foreign = await realm(),
        context = await getGraduatedSendingContext();
      const input = { teamId: f.teamId, actorUserId: f.b, from: f.from, domainId: f.domainId };
      await expect(
        authorizeGraduatedSender(db, { ...input, nativeAuthorized: true } as never, context),
      ).rejects.toMatchObject({ reason: "registered_sender_required" });
      await expect(
        authorizeGraduatedSender(db, { ...input, mailboxId: foreign.mailboxId }, context),
      ).rejects.toMatchObject({ reason: "registered_sender_required" });
      await expect(
        authorizeGraduatedSender(
          db,
          { ...input, mailboxId: f.mailboxId, domainId: foreign.domainId },
          context,
        ),
      ).rejects.toMatchObject({ reason: "registered_sender_required" });
      await expect(issue(f, { ...context })).rejects.toMatchObject({
        reason: "registered_sender_required",
      });
      const proof = await issue(f, context);
      await expect(getGraduatedSenderReputation(db, { ...proof }, context)).rejects.toMatchObject({
        reason: "registered_sender_required",
      });
      await expect(getGraduatedSenderReputation(db, proof, { ...context })).rejects.toMatchObject({
        reason: "registered_sender_required",
      });
      await expect(
        reserveGraduatedSending(
          db,
          {
            teamId: f.teamId,
            emailId: f.queued.id,
            from: f.from,
            recipients: ["recipient@example.invalid"],
            campaign: false,
            senderProof: proof,
          },
          { ...context },
        ),
      ).rejects.toMatchObject({ reason: "registered_sender_required" });
      // A caller-created DTO cannot bootstrap a durable admission or a claim.
      await expect(
        assertMailboxOutboxSendAccess(db, {
          teamId: f.teamId,
          mailboxId: f.mailboxId,
          outboxId: f.queued.id,
          attemptId: randomUUID(),
          from: f.from,
          to: ["recipient@example.invalid"],
          cc: [],
          bcc: [],
          raw: Buffer.alloc(0),
          idempotencyKey: f.queued.id,
        }),
      ).rejects.toThrow();
      expect(await ledger(f)).toEqual({ rows: [], attempts: [] });
      expect(models).toBe(0);
    });
  });

describe("native final composite freshness tail", () => {
  for (const mode of ["owner", "external"] as const)
    it(`refuses ${mode} after final access COMMIT expires the original observation`, async () => {
      const f = await realm(mode),
        adapter = sender(f);
      const original = await getGraduatedSendingContext(
        mode === "external" ? { purpose: "judge" } : {},
      );
      const origin = Date.parse(original.judgeEnvelope!.meterAt),
        expires = Date.parse(original.judgeEnvelope!.meterExpiresAt);
      let freshAge: number | undefined, expiredAge: number | undefined;
      beforePhysical = async () => {
        expect(models).toBe(1);
        expect(claims).toBe(1);
        expect((await ledger(f)).attempts).toEqual([{ state: "settled", units: "180000" }]);
        freshAge = Date.now() - origin;
        expect(Date.now()).toBeLessThan(expires);
        tailArmed = true;
      };
      tailAfterCommit = () => {
        tailHooks++;
        expect(models).toBe(1);
        expect(claims).toBe(1);
        expect(Date.now()).toBeLessThan(expires);
        vi.setSystemTime(Date.now() + 5001);
        expiredAge = Date.now() - origin;
        record(`tail-after-commit-${mode}`, {
          boundary: "original-outer-transaction-commit-return",
          freshAge,
          expiredAge,
          origin,
          expires,
          now: Date.now(),
          models,
          claims,
        });
      };
      const result = await sendMailboxOutbox(db, keys, f.queued.id, adapter, mime);
      const accounting = await ledger(f);
      record(`tail-result-${mode}`, {
        result,
        tailHooks,
        freshAge,
        expiredAge,
        claims,
        models,
        physical: adapter.transport.mock.calls.length,
        admissions: accounting.rows.length,
        attempts: accounting.attempts,
      });
      expect(tailHooks).toBe(1);
      expect(freshAge).toBeLessThan(5000);
      expect(expiredAge).toBeGreaterThan(5000);
      expect(claims).toBe(1);
      expect(models).toBe(1);
      expect(accounting.rows).toHaveLength(1);
      expect(accounting.attempts).toEqual([{ state: "settled", units: "180000" }]);
      expect(adapter.transport).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        status: "queued",
        errorCode: "mailbox_deferred:review_required",
      });
      const [row] = await db
        .select()
        .from(schema.mailboxOutbox)
        .where(eq(schema.mailboxOutbox.id, f.queued.id));
      expect(row).toMatchObject({
        approvedBy: f.b,
        approvedMembershipId: f.memberB.id,
        attemptId: null,
        attemptedAt: null,
      });
      expect(await ledger(f)).toEqual(accounting);
    });
});

describe("system finite regional quota", () => {
  it("canonical Pro control traverses identical realm and transport before System", async () => {
    const f = await realm(),
      send = sender(f);
    await db
      .update(schema.teams)
      .set({ plan: "pro", currentPeriodEnd: new Date(Date.now() + 86400000) })
      .where(eq(schema.teams.id, f.teamId));
    const result = await sendMailboxOutbox(db, keys, f.queued.id, send, mime);
    record("canonical-pro-control", {
      result,
      models,
      claims,
      physical: send.transport.mock.calls.length,
    });
    expect(result.status).toBe("accepted");
    expect(models).toBe(1);
    expect(claims).toBe(1);
    expect(send.transport).toHaveBeenCalledTimes(1);
    expect((await ledger(f)).attempts).toEqual([{ state: "settled", units: "180000" }]);
  });
  it("real System caller uses fresh capacity once, preserves old license and Root debt on replay", async () => {
    const f = await realm("owner", true),
      send = sender(f);
    const entitlement = await mailboxServiceEntitlement(db, f.teamId);
    expect(requireMailboxOperationalPlan(entitlement)).toMatchObject({
      unlimitedOutbound: true,
      unlimitedSeats: true,
      status: "active",
    });
    expect(entitlement.plan!.periodEnd.getTime()).toBeLessThan(Date.now());
    const context = await getGraduatedSendingContext();
    const reputation = await getTenantReputation(db, f.teamId, {
      ...context,
      domainId: f.domainId,
    });
    const result = await sendMailboxOutbox(db, keys, f.queued.id, send, mime);
    record("system-original-caller", {
      result,
      reputation,
      models,
      claims,
      physical: send.transport.mock.calls.length,
    });
    expect(result.status).toBe("accepted");
    expect(reputation).toMatchObject({
      plan: "system",
      state: "domain_verified",
      warmupPercent: 25,
      capacityAvailable: true,
    });
    expect(reputation.effectiveDaily).toBeGreaterThan(0);
    expect(reputation.effectiveDaily).toBeLessThanOrEqual(
      context.regionalCapacity!["us-east-1"]!.globalDaily,
    );
    await expect(issue(f, { ...context })).rejects.toMatchObject({
      reason: "registered_sender_required",
    });
    record("system-finite-positive", {
      result,
      reputation,
      claims,
      models,
      physical: send.transport.mock.calls.length,
    });
    expect(result.status).toBe("accepted");
    expect(claims).toBe(1);
    expect(models).toBe(1);
    expect(send.transport).toHaveBeenCalledTimes(1);
    const before = await ledger(f);
    expect(before.rows).toHaveLength(1);
    expect(before.attempts).toEqual([{ state: "settled", units: "180000" }]);
    const debt = await db.execute(
      sql`select debt_units::text as units from sending_judge_account_debt where account_key='commandcode-primary'`,
    );
    await sendMailboxOutbox(db, keys, f.queued.id, send, mime);
    expect(await ledger(f)).toEqual(before);
    expect(
      await db.execute(
        sql`select debt_units::text as units from sending_judge_account_debt where account_key='commandcode-primary'`,
      ),
    ).toEqual(debt);
    expect(models).toBe(1);
    expect(claims).toBe(1);
    expect(send.transport).toHaveBeenCalledTimes(1);
    expect(sqlClocks).toBeGreaterThan(0);
    record("system-debt-replay", {
      attempts: before.attempts,
      admissions: before.rows.length,
      debt,
      models,
      claims,
      physical: send.transport.mock.calls.length,
      replayUnchanged: true,
    });
  });
  it("System rejects absent, copied and expired original capacity without model or physical send", async () => {
    const f = await realm("owner", true);
    const context = await getGraduatedSendingContext();
    await expect(issue(f, {})).rejects.toMatchObject({ reason: "registered_sender_required" });
    await expect(issue(f, JSON.parse(JSON.stringify(context)))).rejects.toMatchObject({
      reason: "registered_sender_required",
    });
    const absent = await getTenantReputation(db, f.teamId, { domainId: f.domainId });
    expect(absent.capacityAvailable).toBe(false);
    vi.setSystemTime(Date.now() + 5001);
    await expect(issue(f, context)).rejects.toMatchObject({ reason: "capacity_unavailable" });
    expect(models).toBe(0);
    expect(claims).toBe(0);
    expect((await ledger(f)).rows).toHaveLength(0);
    record("system-original-capacity-negative", {
      absentAvailable: absent.capacityAvailable,
      clonesDenied: true,
      expiredDenied: true,
      models,
      claims,
    });
  });
  for (const denial of ["unverified", "review", "suspended", "dns", "capacity"] as const)
    it(`real System caller refuses ${denial} before physical transport`, async () => {
      const f = await realm("owner", true),
        send = sender(f);
      if (denial === "unverified")
        await db.update(schema.user).set({ emailVerified: false }).where(eq(schema.user.id, f.a));
      if (denial === "review")
        await db
          .update(schema.teams)
          .set({ sendReviewAt: new Date() })
          .where(eq(schema.teams.id, f.teamId));
      if (denial === "suspended")
        await db
          .update(schema.teams)
          .set({ suspendedAt: new Date() })
          .where(eq(schema.teams.id, f.teamId));
      if (denial === "dns")
        await db
          .update(schema.domains)
          .set({ dnsRecords: [] })
          .where(eq(schema.domains.id, f.domainId));
      if (denial === "capacity")
        vi.mocked(SESv2Client.prototype.send).mockRejectedValue(
          new Error("SYNTHETIC_CAPACITY_UNKNOWN") as never,
        );
      const result = await sendMailboxOutbox(db, keys, f.queued.id, send, mime);
      record(`system-refused-${denial}`, {
        result,
        claims,
        models,
        physical: send.transport.mock.calls.length,
      });
      expect(result.status).not.toBe("accepted");
      expect(models).toBe(0);
      expect(send.transport).not.toHaveBeenCalled();
      expect((await ledger(f)).rows).toHaveLength(0);
    });
  it("Free and paid keep actual quota/warmup and operator ceiling, never inherit System fallback", async () => {
    const f = await realm();
    const context = await getGraduatedSendingContext();
    const free = await getTenantReputation(db, f.teamId, { ...context, domainId: f.domainId });
    record("free-comparison", free);
    expect(free).toMatchObject({ plan: "free", effectiveDaily: 16, warmupPercent: 25 });
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, f.teamId));
    expect(teamQuota(team!, true).kind).toBe("day");
    await db
      .update(schema.teams)
      .set({
        plan: "starter",
        currentPeriodEnd: new Date(Date.now() + 86400000),
        dailySendCeiling: 2,
      })
      .where(eq(schema.teams.id, f.teamId));
    const paid = await getTenantReputation(db, f.teamId, { ...context, domainId: f.domainId });
    expect(paid).toMatchObject({ plan: "starter", effectiveDaily: 2, warmupPercent: 25 });
  });
});
