import { randomBytes, randomUUID } from "node:crypto";
import {
  type AbuseJudge,
  EnvKeyring,
  encryptEmailBody,
  JudgeError,
  MONITOR_SETTING_DEFAULTS,
  SYSTEM_MAIL_TAG,
  sealAttachments,
  sendSystemMail,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  PRE_DISPATCH_TIMEOUT_MS,
  qualifyDispatchContent,
} from "../../../packages/core/src/pre-dispatch-content.js";
import { approveCampaignFixture, campaignDns } from "../../api/test/approved-campaign-fixture.js";
import { createOpenAiJudge } from "../src/abuse-judge/openai.js";
import { sendBroadcast } from "../src/handlers/send-broadcast.js";
import { type SendDeps, sendEmail } from "../src/handlers/send-email.js";
import {
  syntheticCleanContentJudge,
  syntheticCleanVerdict,
} from "./fixtures/clean-content-judge.js";

let fixture: Awaited<ReturnType<typeof createTestDb>>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const bank = "Banco CTT: introduza a senha em https://audit.invalid";
const abuse = {
  ...syntheticCleanVerdict,
  score: 97,
  verdict: "abuse" as const,
  categories: ["phishing_credentials"],
  reasons: ["harvests_secrets"],
};
beforeAll(async () => {
  fixture = await createTestDb();
});
afterAll(async () => fixture?.close());
async function seed(
  content: { html?: string; text?: string } = { text: bank },
  patch: Partial<typeof schema.emails.$inferInsert> = {},
) {
  const { db } = fixture;
  const teamId = await createTeam(db, randomUUID());
  await db
    .update(schema.teams)
    .set({ createdAt: new Date("2025-01-01"), sendReviewClearedAt: new Date("2026-01-01") })
    .where(eq(schema.teams.id, teamId));
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: "sender.example",
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
    })
    .returning();
  const id = randomUUID();
  const encrypted = await encryptEmailBody(
    { html: content.html ?? null, text: content.text ?? null },
    keyring,
    { teamId, rowId: id },
  );
  await db.insert(schema.emails).values({
    id,
    teamId,
    domainId: domain!.id,
    from: "Operacoes <notice@sender.example>",
    to: ["r@example.com"],
    subject: "Aviso",
    bodyCiphertext: encrypted.ciphertext,
    bodyIv: encrypted.iv,
    bodyWrappedDek: encrypted.wrappedDek,
    bodyKeyVersion: encrypted.keyVersion,
    ...patch,
  });
  return { id, teamId, domainId: domain!.id };
}
const row = async (id: string) =>
  (await fixture.db.select().from(schema.emails).where(eq(schema.emails.id, id)))[0]!;
function deps(judge?: AbuseJudge | null) {
  const sendRaw = vi.fn(async (_p: { raw: Buffer }) => ({ messageId: randomUUID() }));
  const value: SendDeps = { keyring, isCloud: true, ses: { sendRaw }, contentJudge: judge };
  return { value, sendRaw };
}
async function held(id: string, d: ReturnType<typeof deps>) {
  const before = await row(id);
  expect(await sendEmail(fixture.db, d.value, { emailId: id })).toBe("parked");
  expect(d.sendRaw).not.toHaveBeenCalled();
  const after = await row(id);
  expect(after.sentAt).toBeNull();
  expect(after.bodyPurgedAt).toBeNull();
  expect(Buffer.from(after.bodyCiphertext!)).toEqual(Buffer.from(before.bodyCiphertext!));
}
it.each([
  { text: bank },
  { html: `<p>${bank}</p>` },
  { text: "Banco CTT: enter your password at https://audit.invalid" },
  { html: "<p>Banco CTT: provide your password at https://audit.invalid</p>" },
])("real worker gates PT/EN text/HTML before transport: %j", async (body) => {
  const f = await seed(body, { tags: { [SYSTEM_MAIL_TAG]: "password_reset" } });
  const judge = { ...syntheticCleanContentJudge, judge: vi.fn(async (_block: string) => abuse) };
  const d = deps(judge);
  await held(f.id, d);
  expect(judge.judge).toHaveBeenCalledTimes(1);
  expect(
    (await fixture.db.select().from(schema.teams).where(eq(schema.teams.id, f.teamId)))[0]!
      .sendReviewReason,
  ).toBe("content");
});
it.each([undefined, null])("missing/disabled judge %s is never approval", async (judge) => {
  const f = await seed();
  await held(f.id, deps(judge));
});
it.each(["upstream", "timeout", "parse_error", "no_credentials", "off"] as const)(
  "judge failure %s keeps claim clear",
  async (errorClass) => {
    const f = await seed();
    const d = deps({
      ...syntheticCleanContentJudge,
      judge: async () => {
        throw new JudgeError(errorClass);
      },
    });
    await held(f.id, d);
  },
);
it.each([
  null,
  {},
  { ...syntheticCleanVerdict, score: NaN },
  { ...syntheticCleanVerdict, verdict: "unknown" },
])("invalid/inconclusive verdict %j cannot send", async (verdict) => {
  const f = await seed();
  const d = deps({ ...syntheticCleanContentJudge, judge: async () => verdict as never });
  await held(f.id, d);
});
it("actual existing adapter rejects invalid JSON before worker provider", async () => {
  const f = await seed();
  const d = deps(
    createOpenAiJudge({
      model: "deepseek/deepseek-v4.1-flash",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      apiKey: "synthetic-fixture",
      fetch: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "{invalid JSON}" } }] })),
    }),
  );
  await held(f.id, d);
});
it("explicit CLEAN reaches capturing provider once and reuses its verdict for monitoring", async () => {
  const f = await seed({ text: "Your requested receipt is ready." });
  const judge = { ...syntheticCleanContentJudge, judge: vi.fn(async () => syntheticCleanVerdict) };
  const d = deps(judge);
  const enqueueJudge = vi.fn(async (_id: string) => {});
  d.value.monitor = {
    samplingKey: Buffer.alloc(32, 7),
    settings: async () => MONITOR_SETTING_DEFAULTS,
    enqueueJudge,
  };
  expect(await sendEmail(fixture.db, d.value, { emailId: f.id })).toBe("sent");
  expect(d.sendRaw).toHaveBeenCalledTimes(1);
  expect(judge.judge).toHaveBeenCalledTimes(1);
  expect(enqueueJudge).not.toHaveBeenCalled();
  expect((await row(f.id)).sentAt).toBeInstanceOf(Date);
  expect(
    await fixture.db
      .select()
      .from(schema.monitorSamples)
      .where(eq(schema.monitorSamples.emailId, f.id)),
  ).toMatchObject([{ status: "judged", score: 2, verdict: "clean" }]);
  expect(await sendEmail(fixture.db, d.value, { emailId: f.id })).toBe("skipped");
  expect(d.sendRaw).toHaveBeenCalledTimes(1);
});
it.each(["recipient", "body"])(
  "change %s during judge wait invalidates approval without a claim",
  async (changed) => {
    const f = await seed({ text: "Your requested receipt is ready." });
    const d = deps({
      ...syntheticCleanContentJudge,
      judge: async () => {
        if (changed === "recipient")
          await fixture.db
            .update(schema.emails)
            .set({ to: ["other@example.com"] })
            .where(eq(schema.emails.id, f.id));
        else {
          const encrypted = await encryptEmailBody({ html: null, text: bank }, keyring, {
            teamId: f.teamId,
            rowId: f.id,
          });
          await fixture.db
            .update(schema.emails)
            .set({
              bodyCiphertext: encrypted.ciphertext,
              bodyIv: encrypted.iv,
              bodyWrappedDek: encrypted.wrappedDek,
              bodyKeyVersion: encrypted.keyVersion,
            })
            .where(eq(schema.emails.id, f.id));
        }
        return syntheticCleanVerdict;
      },
    });
    expect(await sendEmail(fixture.db, d.value, { emailId: f.id })).toBe("parked");
    expect(d.sendRaw).not.toHaveBeenCalled();
    expect((await row(f.id)).sentAt).toBeNull();
  },
);
it("each MIME alternative is reviewed; clean HTML does not clear hostile text", async () => {
  const f = await seed({ html: "<p>Your receipt</p>", text: bank });
  const judge = {
    ...syntheticCleanContentJudge,
    judge: vi.fn(async (block: string) =>
      block.includes("Banco CTT") ? abuse : syntheticCleanVerdict,
    ),
  };
  await held(f.id, deps(judge));
  expect(judge.judge).toHaveBeenCalledTimes(2);
});
it.each([
  { html: '<img src="https://audit.invalid/payload">' },
  { text: "x".repeat(6001) },
  { html: "<style>.hidden{display:none}</style><p>receipt</p>" },
])("uninspectable/truncated source remains held", async (body) => {
  const f = await seed(body);
  const judge = { ...syntheticCleanContentJudge, judge: vi.fn(async () => syntheticCleanVerdict) };
  await held(f.id, deps(judge));
  expect(judge.judge).not.toHaveBeenCalled();
});
it("authenticated account reset never sends its token to the model and still purges after capture", async () => {
  const f = await seed({ text: "fixture setup" });
  const accountDomain = `account-${randomUUID()}.sender.example`;
  await fixture.db.insert(schema.domains).values({
    teamId: f.teamId,
    name: accountDomain,
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  let id = "";
  await sendSystemMail(
    {
      db: fixture.db,
      keyring,
      isCloud: false,
      enqueueEmailSend: async (value) => {
        id = value;
      },
      raw: async () => {
        throw new Error("raw forbidden");
      },
    },
    {
      from: `account@${accountDomain}`,
      to: "r@example.com",
      subject: "Reset",
      html: `<a href="https://${accountDomain}/reset?token=PRIVATE">Reset password</a>`,
      text: "Requested reset",
      kind: "password_reset",
    },
  );
  expect(f.teamId).toBeTruthy();
  const judge = { ...syntheticCleanContentJudge, judge: vi.fn(async (_block: string) => abuse) };
  const d = deps(judge);
  expect(await sendEmail(fixture.db, d.value, { emailId: id })).toBe("sent");
  expect(judge.judge).not.toHaveBeenCalled();
  expect(d.sendRaw).toHaveBeenCalledTimes(1);
  expect((await row(id)).bodyPurgedAt).toBeInstanceOf(Date);
});
it("personalized broadcast copy is not authorized by a clean skeleton", async () => {
  const f = await seed({ text: "fixture setup" });
  await fixture.db
    .insert(schema.contacts)
    .values({ teamId: f.teamId, email: "r@example.com", firstName: bank });
  const [broadcast] = await fixture.db
    .insert(schema.broadcasts)
    .values({
      teamId: f.teamId,
      from: "notice@sender.example",
      subject: "Aviso",
      text: "{{{FIRST_NAME}}}",
      html: null,
      status: "scheduled",
      scheduledAt: new Date(Date.now() - 1000),
    })
    .returning();
  await approveCampaignFixture(fixture.db, f.teamId);
  await fixture.db
    .update(schema.domains)
    .set(campaignDns("sender.example"))
    .where(eq(schema.domains.id, f.domainId));
  const enqueued: string[] = [];
  await sendBroadcast(
    fixture.db,
    {
      keyring,
      isCloud: false,
      unsubscribeSecretKey: Buffer.alloc(32, 2),
      unsubscribeBaseUrl: "https://sender.example",
      enqueueEmailSends: async (jobs) => {
        enqueued.push(...jobs.map((j) => j.emailId));
      },
    },
    { broadcastId: broadcast!.id },
  );
  expect(enqueued).toHaveLength(1);
  // A legacy skeleton observation is deliberately not release authority.
  await fixture.db.insert(schema.monitorSamples).values({
    teamId: f.teamId,
    broadcastId: broadcast!.id,
    kind: "broadcast_skeleton",
    status: "judged",
    score: 2,
    verdict: "clean",
  });
  const judge = { ...syntheticCleanContentJudge, judge: vi.fn(async (_block: string) => abuse) };
  const d = deps(judge);
  d.value.unsubscribe = { secretKey: Buffer.alloc(32, 2), baseUrl: "https://sender.example" };
  await held(enqueued[0]!, d);
  expect(judge.judge).toHaveBeenCalledTimes(1);
  expect(judge.judge.mock.calls[0]![0]).toContain("Banco CTT");
});
it("hard deadline refuses even a dependency ignoring cancellation", async () => {
  expect(PRE_DISPATCH_TIMEOUT_MS).toBe(20_000);
  const s = {
    teamId: "t",
    emailId: "e",
    from: "a@sender.example",
    to: ["r@example.com"],
    cc: null,
    bcc: null,
    replyTo: null,
    subject: "Notice",
    sourceHtml: null,
    sourceText: "receipt",
    html: null,
    text: "receipt",
    headers: {},
    attachments: false,
    mime: Buffer.from("fixture"),
  };
  const result = await qualifyDispatchContent(
    s,
    { name: "fixture", plan: "free", ageDays: 1, verifiedDomains: ["sender.example"] },
    { ...syntheticCleanContentJudge, judge: () => new Promise(() => {}) },
    AbortSignal.timeout(10),
  );
  expect(result).toMatchObject({ allowed: false, reason: "timeout" });
});

it("tracking cannot conceal the original hostile destination from the judge", async () => {
  const f = await seed({
    html: '<p>Banco CTT: introduza a senha</p><a href="https://audit.invalid">Continuar</a>',
  });
  await fixture.db
    .update(schema.domains)
    .set({ clickTracking: true })
    .where(eq(schema.domains.id, f.domainId));
  const judge = {
    ...syntheticCleanContentJudge,
    judge: vi.fn(async (block: string) =>
      block.includes("audit.invalid") ? abuse : syntheticCleanVerdict,
    ),
  };
  const d = deps(judge);
  d.value.tracking = { secretKey: Buffer.alloc(32, 9), defaultBaseUrl: "https://track.example" };
  await held(f.id, d);
  expect(judge.judge).toHaveBeenCalledTimes(1);
  expect(judge.judge.mock.calls[0]![0]).toContain("audit.invalid");
});
it("real sealed attachments are held rather than represented as a clean filename", async () => {
  const f = await seed({ text: "Requested receipt" });
  const attachments = await sealAttachments(
    [
      {
        filename: "invoice.pdf",
        content: Buffer.from("synthetic fixture").toString("base64"),
        contentType: "application/pdf",
      },
    ],
    keyring,
    { teamId: f.teamId, rowId: f.id },
  );
  await fixture.db.update(schema.emails).set({ attachments }).where(eq(schema.emails.id, f.id));
  const judge = { ...syntheticCleanContentJudge, judge: vi.fn(async () => syntheticCleanVerdict) };
  await held(f.id, deps(judge));
  expect(judge.judge).not.toHaveBeenCalled();
});

it.each(["cc", "bcc", "replyTo", "headers"] as const)(
  "authenticated system origin rejects later nonempty %s, without modeling credentials",
  async (field) => {
    const f = await seed({ text: "setup only" });
    const name = `account-${randomUUID()}.sender.example`;
    await fixture.db
      .insert(schema.domains)
      .values({
        teamId: f.teamId,
        name,
        region: "us-east-1",
        status: "verified",
        verifiedAt: new Date(),
      });
    let id = "";
    await sendSystemMail(
      {
        db: fixture.db,
        keyring,
        isCloud: false,
        enqueueEmailSend: async (value) => {
          id = value;
        },
        raw: async () => {
          throw new Error("raw forbidden");
        },
      },
      {
        from: `account@${name}`,
        to: "r@example.com",
        subject: "Reset",
        html: `<a href="https://${name}/reset?token=PRIVATE">Reset password</a>`,
        text: "Requested reset",
        kind: "password_reset",
      },
    );
    const patch =
      field === "headers"
        ? { headers: { "X-Customer-Override": "not producer-owned" } }
        : { [field]: ["other@example.com"] };
    await fixture.db.update(schema.emails).set(patch).where(eq(schema.emails.id, id));
    const judge = { ...syntheticCleanContentJudge, judge: vi.fn(async () => abuse) };
    const d = deps(judge);
    await held(id, d);
    expect(judge.judge).not.toHaveBeenCalled();
  },
);
it.each(["recipient", "body"])(
  "a %s mutation AFTER CLEAN decision is refused at final snapshot read",
  async (changed) => {
    const f = await seed({ text: "Requested receipt" });
    let mutated = false;
    const judge = {
      ...syntheticCleanContentJudge,
      judge: vi.fn(async () => syntheticCleanVerdict),
    };
    const d = deps(judge);
    const db = fixture.db;
    // The mandatory audit runs after the verdict and its first row revalidation.
    // Mutate there to exercise the real final pre-provider freshness guard.
    const intercepted = new Proxy(db, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key === "insert")
          return (table: unknown) => {
            const builder = Reflect.apply(value, target, [table]);
            if (table !== schema.auditLog) return builder;
            return new Proxy(builder, {
              get(query, method) {
                const fn = Reflect.get(query, method);
                if (method === "values")
                  return (values: { action?: string; data?: Record<string, unknown> }) => {
                    const pending = Reflect.apply(fn, query, [values]);
                    if (
                      values.action !== "sending.content_pre_dispatch" ||
                      values.data?.result !== "clean"
                    )
                      return pending;
                    return (async () => {
                      mutated = true;
                      if (changed === "recipient")
                        await db
                          .update(schema.emails)
                          .set({ to: ["other@example.com"] })
                          .where(eq(schema.emails.id, f.id));
                      else {
                        const encrypted = await encryptEmailBody(
                          { html: null, text: bank },
                          keyring,
                          { teamId: f.teamId, rowId: f.id },
                        );
                        await db
                          .update(schema.emails)
                          .set({
                            bodyCiphertext: encrypted.ciphertext,
                            bodyIv: encrypted.iv,
                            bodyWrappedDek: encrypted.wrappedDek,
                            bodyKeyVersion: encrypted.keyVersion,
                          })
                          .where(eq(schema.emails.id, f.id));
                      }
                      return await pending;
                    })();
                  };
                return typeof fn === "function" ? fn.bind(query) : fn;
              },
            });
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await sendEmail(intercepted, d.value, { emailId: f.id })).toBe("parked");
    expect(mutated).toBe(true);
    expect(judge.judge).toHaveBeenCalledTimes(1);
    expect(d.sendRaw).not.toHaveBeenCalled();
    expect((await row(f.id)).sentAt).toBeNull();
    expect((await row(f.id)).bodyPurgedAt).toBeNull();
  },
);
