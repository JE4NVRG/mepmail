import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import type { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createAbuseJudge } from "../../../apps/worker/src/abuse-judge/index.js";
import { createMailboxExternalAwareSender } from "../../../apps/worker/src/mailbox-external-sender.js";
import {
  createMailboxContentPolicySender,
  createMailboxSesSender,
} from "../../../apps/worker/src/mailbox-sender.js";
import { ABUSE_JUDGE_QUESTIONS } from "../src/abuse-judge/questions.js";
import { EnvKeyring } from "../src/crypto/keyring.js";
import {
  authorizeGraduatedSender,
  reconcileJudgeAttempt,
  reserveJudgeAttempt,
} from "../src/graduated-sending.js";
import { getGraduatedSendingContext } from "../src/graduated-sending-context.js";
import { createMailboxExternalAccount } from "../src/mailbox-external-accounts.js";
import { saveMailboxDraft, withMailboxSendAccess } from "../src/mailbox-private-store.js";
import { createMailboxRegistry, grantMailboxRegistry } from "../src/mailbox-registry.js";
import {
  type MailboxOutboxSender,
  MailboxSendDeferredError,
  type MailboxTransportMimeAdapter,
  queueMailboxDraft,
  sendMailboxOutbox,
} from "../src/mailbox-transport.js";

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
let _sqlClocks = 0;
let credits = 10;
let stockReset = 0;
let duringModel: (() => Promise<void>) | undefined;
let beforePhysical: (() => Promise<void>) | undefined;
let tailAfterCommit: (() => void) | undefined;
let tailArmed = false;
let _tailHooks = 0;
const keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
const dialect = new PgDialect();
function record(name: string, data: unknown) {
  if (process.env.NATIVE_CASE_REPORT)
    appendFileSync(process.env.NATIVE_CASE_REPORT, `${JSON.stringify({ name, data })}\n`);
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
      from: /^From: (.+)$/m.exec(raw.toString())?.[1]?.trim() ?? "",
      to: [/^To: (.+)$/m.exec(raw.toString())?.[1]?.trim() ?? ""],
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
            _sqlClocks++;
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
  _sqlClocks = 0;
  credits = 10;
  stockReset = 0;
  duringModel = undefined;
  beforePhysical = undefined;
  tailAfterCommit = undefined;
  tailArmed = false;
  _tailHooks = 0;
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
            limited: true,
            exceeded: false,
            fiveHour: { used: 0, cap: 14, resetAt: stockReset, exceeded: false },
            weekly: {
              used: 20.9629819327,
              cap: 35,
              resetAt: Date.now() + 3600000,
              exceeded: false,
            },
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

async function realm(mode: "owner" | "grant" | "external" = "owner") {
  const teamId = await createTeam(db, randomUUID());
  const a = randomUUID(),
    b = randomUUID();
  await db.insert(schema.user).values(
    [a, b].map((id) => ({
      id,
      name: "Synthetic authority",
      email: `${id}@example.invalid`,
      emailVerified: true,
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
    periodStart: new Date(Date.now() - 86400000),
    periodEnd: new Date(Date.now() + 86400000),
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
            domainId:
              domain?.id ??
              (() => {
                throw new Error("FIXTURE_DOMAIN_MISSING");
              })(),
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
    domainId:
      domain?.id ??
      (() => {
        throw new Error("FIXTURE_DOMAIN_MISSING");
      })(),
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

// Reuses canonical native realm, genuine context, SQL-clock adapter, queue,
// actual claim and real physical sender factory. No business-row fabrication.
it("unscheduled finite stock retains shared debt and ambiguous holds through zero-to-scheduled refresh", async () => {
  credits = 5.604915201;
  const first = await realm();
  const physical = sender(first);
  expect(await sendMailboxOutbox(db, keys, first.queued.id, physical, mime)).toMatchObject({
    status: "accepted",
  });
  expect(models).toBe(1);
  expect(claims).toBe(1);
  expect(physical.transport).toHaveBeenCalledTimes(1);
  const second = await realm();
  const attemptId = randomUUID();
  let reached = false;
  let callbackError: unknown;
  const pendingSender: MailboxOutboxSender = {
    async send(input) {
      try {
        claims++;
        reached = true;
        const cold = await getGraduatedSendingContext({ purpose: "judge" });
        const args = {
          teamId: second.teamId,
          emailId: input.outboxId,
          attemptId,
          inputTokenUpperBound: 1000000,
          sourceKind: "mailbox" as const,
        };
        // Opaque-context authority is enforced at the native authorization boundary,
        // not at the legacy internal structural-envelope reservation interface.
        if (!second.domainId) throw new Error("FIXTURE_DOMAIN_MISSING");
        await expect(
          authorizeGraduatedSender(
            db,
            {
              teamId: second.teamId,
              actorUserId: second.b,
              from: second.from,
              mailboxId: second.mailboxId,
              domainId: second.domainId,
            },
            { ...cold },
          ),
        ).rejects.toMatchObject({ reason: "registered_sender_required" });
        const held = await reserveJudgeAttempt(db, args, cold);
        expect(held).toMatchObject({
          accountKey: "commandcode-primary",
          dispatchAllowed: true,
          replay: false,
          reservedCreditUnits: 302457600,
        });
        await reconcileJudgeAttempt(
          db,
          {
            teamId: second.teamId,
            emailId: input.outboxId,
            accountKey: "commandcode-primary",
            attemptId,
            outcome: "ambiguous",
          },
          cold,
        );
        vi.setSystemTime(Date.now() + 6000);
        stockReset = Date.now() + 18000000;
        const active = await getGraduatedSendingContext({ purpose: "judge" });
        expect(active.judgeEnvelope?.accountKey).toBe(cold.judgeEnvelope?.accountKey);
        expect(active.judgeEnvelope?.meterId).not.toBe(cold.judgeEnvelope?.meterId);
        expect(active.judgeEnvelope?.remainingCreditUnits).toBe(
          cold.judgeEnvelope?.remainingCreditUnits,
        );
        expect(active.judgeEnvelope?.remainingCreditUnits).toBe(604915200);
        expect(await reserveJudgeAttempt(db, args, active)).toMatchObject({
          dispatchAllowed: false,
          replay: true,
        });
        await expect(
          reserveJudgeAttempt(db, { ...args, attemptId: randomUUID() }, active),
        ).rejects.toMatchObject({ reason: "minute_limit" });
        const debt = await db.execute(
          sql`select debt_units::text as units from sending_judge_account_debt where account_key='commandcode-primary'`,
        );
        const heldRows = await db.execute(
          sql`select state,reserved_units::text as units from sending_judge_attempts where account_key='commandcode-primary' and state<>'settled'`,
        );
        const rows = (v: unknown) => (Array.isArray(v) ? v : (v as { rows: unknown[] }).rows);
        expect(rows(debt)).toEqual([{ units: "180000" }]);
        expect(rows(heldRows)).toEqual([{ state: "ambiguous", units: "302457600" }]);
        record("zero-to-active-account-custody", {
          models,
          claims,
          debt: rows(debt),
          held: rows(heldRows),
          cold: cold.judgeEnvelope,
          active: active.judgeEnvelope,
          replay: true,
          secondAttemptDenied: true,
        });
        throw new MailboxSendDeferredError("preflight_unavailable");
      } catch (e) {
        if (!(e instanceof MailboxSendDeferredError)) callbackError = e;
        throw e;
      }
    },
  };
  const pendingResult = await sendMailboxOutbox(db, keys, second.queued.id, pendingSender, mime);
  if (callbackError) throw callbackError;
  expect(pendingResult).toMatchObject({
    status: "queued",
  });
  expect(reached).toBe(true);
  expect(models).toBe(1);
  expect(claims).toBe(2);
  expect(physical.transport).toHaveBeenCalledTimes(1);
});
