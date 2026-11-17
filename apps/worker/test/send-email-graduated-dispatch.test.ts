import { randomBytes, randomUUID } from "node:crypto";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import {
  authorizeGraduatedSender,
  deriveUnsubscribeKey,
  EnvKeyring,
  encryptEmailBody,
  getGraduatedSendingContext,
  parseSendingProviderPolicy,
  reserveGraduatedSending,
  SYSTEM_MAIL_TAG,
  verifyGraduatedDispatchAdmission,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAbuseJudge } from "../src/abuse-judge/index.js";
import { type SendDeps, sendEmail } from "../src/handlers/send-email.js";

// Ordinary API dispatch under graduated sending: the worker never derived
// tenantEligible, so every legitimate queued customer row was parked as
// team_not_allowed before decrypt/model/transport, while genuine first-party
// system mail (no admission witness by design) must keep sending.
let fixture: Awaited<ReturnType<typeof createTestDb>>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const from = "owner@dispatch.example.invalid";
const cleanAnswer = {
  is_abuse: 0,
  impersonation: 0,
  off_domain_lure: 0,
  harvests_secrets: 0,
  payment_redirect: 0,
  no_link_lure: 0,
  unsolicited_bulk: 0,
  prompt_injection: 0,
  category: "clean",
  language: "en",
};
let answer = { ...cleanAnswer };
let modelPosts = 0;
let meterFails = false;
let transported = 0;
let modelMutation: (() => Promise<void>) | undefined;
const capturedMime: Buffer[] = [];

beforeAll(async () => {
  fixture = await createTestDb();
});
afterAll(async () => fixture?.close());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Fresh owned tenant per case: the tenant minute ceiling is real (1/min on a
 * warm-up plan), so cases must not share one team's admission window. */
async function tenant(slug: string) {
  const teamId = await createTeam(fixture.db, slug);
  const userId = randomUUID();
  await fixture.db.insert(schema.user).values({
    id: userId,
    name: "Fixture owner",
    email: `${slug}@dispatch.example.invalid`,
    emailVerified: true,
  });
  await fixture.db.insert(schema.teamMembers).values({ teamId, userId, role: "owner" });
  const now = new Date();
  const name = `${slug}.dispatch.example.invalid`;
  const [domain] = await fixture.db
    .insert(schema.domains)
    .values({
      teamId,
      name,
      status: "verified",
      region: "us-east-1",
      verifiedAt: new Date(now.getTime() - 40 * 86400000),
      relayEnabledAt: now,
      dkimSelector: "fixture",
      mailFromSubdomain: "send",
      dmarcPolicy: "none",
      dmarcCheckedAt: now,
      lastCheckedAt: now,
      dnsRecords: [
        { group: "verification", type: "TXT", name: `fixture._domainkey.${name}`, status: "found" },
        { group: "sending", type: "TXT", name: `send.${name}`, status: "found" },
        { group: "sending", type: "MX", name: `send.${name}`, status: "found" },
        { group: "dmarc", type: "TXT", name: `_dmarc.${name}`, status: "found" },
      ],
    })
    .returning();
  await fixture.db
    .update(schema.teams)
    .set({
      plan: "starter",
      planStatus: "active",
      createdAt: new Date("2025-01-01"),
      sendReviewClearedAt: new Date("2026-01-01"),
    })
    .where(eq(schema.teams.id, teamId));
  return { teamId, domainId: domain!.id, name };
}

function fixtures() {
  vi.stubGlobal("fetch", (async (url: unknown) => {
    const u = String(url);
    if (u.includes("/alpha/billing/credits")) {
      if (meterFails) throw new Error("synthetic meter unavailable");
      return Response.json({
        credits: {
          monthlyCredits: 6,
          purchasedCredits: 0,
          freeCredits: 0,
          belowThreshold: false,
        },
        windowLimits: {
          exceeded: false,
          fiveHour: { used: 0, cap: 6, resetAt: Date.now() + 3_600_000 },
          weekly: { used: 0, cap: 6, resetAt: Date.now() + 7_200_000 },
        },
      });
    }
    if (u.endsWith("/chat/completions")) {
      modelPosts++;
      await modelMutation?.();
      return Response.json({
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(answer) } }],
        usage: { prompt_tokens: 200, completion_tokens: 100 },
      });
    }
    throw new Error(`NON_FIXTURE_FETCH:${u}`);
  }) as typeof fetch);
  vi.spyOn(SESv2Client.prototype, "send").mockImplementation(async () => ({
    SendingEnabled: true,
    ProductionAccessEnabled: true,
    EnforcementStatus: "HEALTHY",
    SendQuota: { Max24HourSend: 54900, SentLast24Hours: 5, MaxSendRate: 14 },
  }));
}

function env() {
  vi.stubEnv("SENDING_PROVIDER_POLICY_JSON", JSON.stringify({ version: 1, graduated: true }));
  vi.stubEnv("ABUSE_JUDGE", "openai");
  vi.stubEnv("ABUSE_JUDGE_MODEL", "deepseek/deepseek-v4.1-flash");
  vi.stubEnv("ABUSE_JUDGE_BASE_URL", "https://api.commandcode.ai/provider/v1");
  vi.stubEnv("ABUSE_JUDGE_API_KEY", "synthetic-offline-not-a-secret");
}

async function seed(
  t: { teamId: string; domainId: string; name: string },
  options: { tags?: Record<string, string>; systemOrigin?: boolean } = {},
) {
  const id = randomUUID();
  const to = ["recipient@example.invalid"];
  const subject = options.systemOrigin ? "Verify your address" : "Your requested document";
  const senderAddr = options.systemOrigin ? from : `owner@${t.name}`;
  const sender = `MepMail <${senderAddr}>`;
  const body = await encryptEmailBody(
    {
      html: "<p>Requested document for your records</p>",
      text: "Requested document for your records",
    },
    keyring,
    { teamId: t.teamId, rowId: id },
    options.systemOrigin
      ? { version: 1, source: "system", kind: "email_verification", from: sender, to, subject }
      : undefined,
  );
  const [email] = await fixture.db
    .insert(schema.emails)
    .values({
      id,
      teamId: t.teamId,
      from: sender,
      to,
      domainId: options.systemOrigin ? null : t.domainId,
      subject,
      latestStatus: "queued",
      ...(options.tags ? { tags: options.tags } : {}),
      bodyCiphertext: body.ciphertext,
      bodyIv: body.iv,
      bodyWrappedDek: body.wrappedDek,
      bodyKeyVersion: body.keyVersion,
    })
    .returning();
  if (!email) throw new Error("seed failed");
  return email;
}

/** The actual accept-time producer path, not a hand-written audit row. */
async function admit(id: string, teamId: string, domainId: string) {
  await fixture.db.transaction(async (tx) => {
    const context = await getGraduatedSendingContext();
    const [email] = await tx.select().from(schema.emails).where(eq(schema.emails.id, id));
    const [owner] = await tx
      .select({ id: schema.teamMembers.userId })
      .from(schema.teamMembers)
      .where(eq(schema.teamMembers.teamId, teamId));
    await reserveGraduatedSending(
      tx as never,
      {
        teamId,
        emailId: id,
        from: email!.from,
        recipients: [...email!.to, ...(email!.cc ?? []), ...(email!.bcc ?? [])],
        campaign: !!email!.topicId,
        senderProof: await authorizeGraduatedSender(
          tx as never,
          { teamId, actorUserId: owner!.id, from: email!.from, domainId },
          context,
        ),
      },
      context,
    );
  });
}

function deps(overrides: Partial<SendDeps> = {}): SendDeps {
  return {
    keyring,
    isCloud: true,
    onboardingEmailFrom: from,
    unsubscribe: {
      secretKey: deriveUnsubscribeKey(Buffer.alloc(32, 43)),
      baseUrl: "https://optout.example.invalid",
    },
    ses: {
      sendRaw: async (params) => {
        capturedMime.push(Buffer.from(params.raw));
        transported++;
        return { messageId: `<ses-${randomUUID()}@example.invalid>` };
      },
    },
    contentJudge: createAbuseJudge({
      provider: "openai",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      model: "deepseek/deepseek-v4.1-flash",
      apiKey: "synthetic-offline-not-a-secret",
      timeoutMs: 20000,
    }),
    sendingProviderPolicy: parseSendingProviderPolicy(
      JSON.stringify({ version: 1, graduated: true }),
    ),
    ...overrides,
  };
}

async function admitCount(teamId: string) {
  const { rows } = (await fixture.db.execute(
    // biome-ignore lint/suspicious/noExplicitAny: raw audit projection
    `select count(*)::int as n from audit_log where action='sending.graduated_reserved' and team_id='${teamId}'`,
  )) as unknown as { rows: { n: number }[] };
  return rows[0]!.n;
}

function resultRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value : (value as { rows: Record<string, unknown>[] }).rows;
}

async function accounting(emailId: string, teamId: string) {
  const attempts = await fixture.db.execute(
    sql`select account_key,attempt_id,state,actual_units,reserved_units from sending_judge_attempts where message_id=${emailId}::uuid order by attempt_id`,
  );
  const debt = await fixture.db.execute(
    sql`select debt_units::text as units from sending_judge_account_debt where account_key='commandcode-primary'`,
  );
  const logical = await fixture.db.execute(
    sql`select data from audit_log where team_id=${teamId} and action='sending.graduated_reserved' and target=${`graduated:${emailId}`}`,
  );
  return { attempts: resultRows(attempts), debt: resultRows(debt), logical: resultRows(logical) };
}

function send(emailId: string, overrides: Partial<SendDeps> = {}) {
  return sendEmail(fixture.db, deps(overrides), { emailId });
}

beforeEach(() => {
  transported = 0;
  capturedMime.length = 0;
  modelMutation = undefined;
  modelPosts = 0;
  answer = { ...cleanAnswer };
  meterFails = false;
  fixtures();
  env();
});

describe("ordinary API dispatch under graduated sending", () => {
  it("sends an admitted customer row through the real classifier and transport exactly once", async () => {
    const t = await tenant("green-customer");
    const email = await seed(t);
    await admit(email.id, t.teamId, t.domainId);
    const admits = await admitCount(t.teamId);
    const debtBefore = await fixture.db.execute(
      sql`select coalesce((select debt_units from sending_judge_account_debt where account_key='commandcode-primary'),0)::text as units`,
    );
    const outcome = await send(email.id);
    if (outcome !== "sent") {
      const [r] = await fixture.db
        .select()
        .from(schema.emails)
        .where(eq(schema.emails.id, email.id));
      const { rows } = (await fixture.db.execute(
        `select action,target,data from audit_log where team_id='${t.teamId}' order by created_at desc limit 6`,
      )) as unknown as { rows: unknown[] };
      throw new Error(
        `OUTCOME=${outcome} status=${r!.latestStatus} sentAt=${r!.sentAt} audits=${JSON.stringify(rows)}`,
      );
    }
    expect(transported).toBe(1);
    expect(modelPosts).toBe(1);
    const settled = await accounting(email.id, t.teamId);
    expect(settled.attempts).toHaveLength(1);
    expect(settled.attempts[0]).toMatchObject({ state: "settled", actual_units: 180000 });
    expect(Number(settled.debt[0]!.units) - Number(resultRows(debtBefore)[0]!.units)).toBe(180000);
    expect(settled.logical).toHaveLength(1);
    expect(settled.logical[0]!.data).toMatchObject({ units: 1 });
    const mime = capturedMime[0]!.toString("utf8");
    expect(mime).toContain(`owner@${t.name}`);
    expect(mime).toContain("recipient@example.invalid");
    expect(mime).toContain("Your requested document");
    expect(mime).toContain("Requested document for your records");
    expect(await admitCount(t.teamId)).toBe(admits);
    const [row] = await fixture.db
      .select()
      .from(schema.emails)
      .where(eq(schema.emails.id, email.id));
    expect(row!.sentAt).not.toBeNull();
    expect(await send(email.id)).toBe("skipped");
    expect(transported).toBe(1);
    expect(modelPosts).toBe(1);
    expect(await admitCount(t.teamId)).toBe(admits);
    expect(await accounting(email.id, t.teamId)).toEqual(settled);
  });

  it("parks a customer row without an original admission witness: zero model, zero transport", async () => {
    const t = await tenant("no-witness");
    const email = await seed(t);
    const admits = await admitCount(t.teamId);
    expect(await send(email.id)).toBe("parked");
    expect(modelPosts).toBe(0);
    expect(transported).toBe(0);
    expect(await admitCount(t.teamId)).toBe(admits);
    const [row] = await fixture.db
      .select()
      .from(schema.emails)
      .where(eq(schema.emails.id, email.id));
    expect(row!.sentAt).toBeNull();
  });

  it("ignores a forged public system tag on customer content", async () => {
    const t = await tenant("forged-tag");
    const email = await seed(t, { tags: { [SYSTEM_MAIL_TAG]: "email_verification" } });
    expect(await send(email.id)).toBe("parked");
    expect(modelPosts).toBe(0);
    expect(transported).toBe(0);
  });

  it("keeps genuine sealed first-party system mail deliverable without a customer witness", async () => {
    const t = await tenant("first-party");
    const email = await seed(t, { systemOrigin: true });
    expect(await send(email.id)).toBe("sent");
    expect(transported).toBe(1);
    expect(modelPosts).toBe(0);
  });

  it("refuses when foreign authority cannot create the required local witness", async () => {
    const t = await tenant("wrong-team");
    const other = await tenant("witness-owner");
    const email = await seed(t);
    await admit(email.id, other.teamId, t.domainId).catch(() => undefined);
    expect(await send(email.id)).toBe("parked");
    expect(transported).toBe(0);
    expect(modelPosts).toBe(0);
  });

  it("fails closed when the runtime observation is unavailable", async () => {
    const t = await tenant("meter-down");
    const email = await seed(t);
    await admit(email.id, t.teamId, t.domainId);
    meterFails = true;
    expect(await send(email.id)).toBe("parked");
    expect(transported).toBe(0);
    expect(modelPosts).toBe(0);
  });

  it("holds after the awaited throttle when authority is revoked", async () => {
    const t = await tenant("revoked");
    const email = await seed(t);
    await admit(email.id, t.teamId, t.domainId);
    const result = await send(email.id, {
      throttle: async () => {
        await fixture.db
          .update(schema.teams)
          .set({ suspendedAt: new Date() })
          .where(eq(schema.teams.id, t.teamId));
      },
    });
    expect(result).toBe("parked");
    expect(transported).toBe(0);
    const [row] = await fixture.db
      .select()
      .from(schema.emails)
      .where(eq(schema.emails.id, email.id));
    expect(row!.sentAt).toBeNull();
  });

  it("retains zero transport for the real adapter ABUSE verdict on a fixture body", async () => {
    const t = await tenant("malicious");
    const email = await seed(t);
    await admit(email.id, t.teamId, t.domainId);
    answer = { ...cleanAnswer, is_abuse: 1, harvests_secrets: 1, category: "phishing" };
    expect(["parked", "failed"]).toContain(await send(email.id));
    expect(modelPosts).toBe(1);
    expect(transported).toBe(0);
  });
  it("late model suspension preserves settled cost but prevents transport and claim", async () => {
    const t = await tenant("late-model-suspension");
    const email = await seed(t);
    await admit(email.id, t.teamId, t.domainId);
    const before = await fixture.db.execute(
      sql`select coalesce((select debt_units from sending_judge_account_debt where account_key='commandcode-primary'),0)::text as units`,
    );
    modelMutation = async () => {
      await fixture.db
        .update(schema.teams)
        .set({ suspendedAt: new Date() })
        .where(eq(schema.teams.id, t.teamId));
    };
    expect(await send(email.id)).toBe("parked");
    expect(modelPosts).toBe(1);
    expect(transported).toBe(0);
    const [row] = await fixture.db
      .select()
      .from(schema.emails)
      .where(eq(schema.emails.id, email.id));
    expect(row!.sentAt).toBeNull();
    const state = await accounting(email.id, t.teamId);
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0]).toMatchObject({ state: "settled", actual_units: 180000 });
    expect(Number(state.debt[0]!.units) - Number(resultRows(before)[0]!.units)).toBe(180000);
  });

  it("late domain revocation after the claim releases only the owned non-dispatched claim", async () => {
    const t = await tenant("late-domain-claim");
    const email = await seed(t);
    await admit(email.id, t.teamId, t.domainId);
    const update = fixture.db.update.bind(fixture.db);
    vi.spyOn(fixture.db, "update").mockImplementation(((table: unknown) => {
      const q = update(table as never);
      if (table !== schema.emails) return q;
      const set = q.set.bind(q);
      q.set = ((values: Record<string, unknown>) => {
        const builder = set(values as never);
        if (!(values.sentAt instanceof Date)) return builder;
        const where = builder.where.bind(builder);
        builder.where = ((condition: Parameters<typeof where>[0]) => {
          const selected = where(condition);
          const returning = selected.returning.bind(selected);
          selected.returning = (async (fields: unknown) => {
            const rows = (await returning(fields as never)) as unknown as unknown[];
            if (rows.length)
              await update(schema.domains)
                .set({ status: "pending" })
                .where(eq(schema.domains.id, t.domainId));
            return rows;
          }) as typeof selected.returning;
          return selected;
        }) as typeof builder.where;
        return builder;
      }) as typeof q.set;
      return q;
    }) as typeof fixture.db.update);
    expect(await send(email.id)).toBe("parked");
    expect(modelPosts).toBe(1);
    expect(transported).toBe(0);
    const [row] = await fixture.db
      .select()
      .from(schema.emails)
      .where(eq(schema.emails.id, email.id));
    expect(row!.sentAt).toBeNull();
    expect(row!.sesMessageId).toBeNull();
    expect((await accounting(email.id, t.teamId)).attempts[0]).toMatchObject({
      state: "settled",
      actual_units: 180000,
    });
  });

  it("expired original observation during DB authority queries cannot return true", async () => {
    const t = await tenant("expired-during-query");
    const email = await seed(t);
    await admit(email.id, t.teamId, t.domainId);
    const context = await getGraduatedSendingContext({ purpose: "judge" });
    const select = fixture.db.select.bind(fixture.db);
    let expired = false;
    vi.spyOn(fixture.db, "select").mockImplementation(((...args: unknown[]) => {
      // The first wall clock sample precedes these queries. Advance the real
      // fixture DB wall clock by waiting, never by restamping the context.
      if (!expired) {
        expired = true;
        const query = select(...(args as Parameters<typeof select>));
        const from = query.from.bind(query);
        query.from = ((table: Parameters<typeof from>[0]) => {
          const result = from(table);
          const then = result.then.bind(result);
          // biome-ignore lint/suspicious/noThenProperty: delay the real Drizzle thenable to exercise observation expiry during DB I/O
          result.then = ((resolve: unknown, reject: unknown) =>
            new Promise((r) => setTimeout(r, 5100)).then(() =>
              then(resolve as never, reject as never),
            )) as typeof result.then;
          return result;
        }) as typeof query.from;
        return query;
      }
      return select(...(args as Parameters<typeof select>));
    }) as typeof fixture.db.select);
    expect(
      await verifyGraduatedDispatchAdmission(
        fixture.db,
        { teamId: t.teamId, emailId: email.id },
        context,
      ),
    ).toBe(false);
    expect(modelPosts).toBe(0);
    expect(transported).toBe(0);
  }, 15000);

  it("JSON cloned observation cannot acquire original server context authority", async () => {
    const t = await tenant("cloned-context");
    const email = await seed(t);
    await admit(email.id, t.teamId, t.domainId);
    const context = await getGraduatedSendingContext();
    expect(
      await verifyGraduatedDispatchAdmission(
        fixture.db,
        { teamId: t.teamId, emailId: email.id },
        JSON.parse(JSON.stringify(context)),
      ),
    ).toBe(false);
    expect(modelPosts).toBe(0);
    expect(transported).toBe(0);
  });
});
