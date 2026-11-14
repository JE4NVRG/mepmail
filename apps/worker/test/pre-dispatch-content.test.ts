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
import { projectDispatchHtml } from "../../../packages/core/src/dispatch-html-projection.js";
import { rewriteForTracking } from "../../../packages/core/src/link-tracking.js";
import {
  bindDispatchTracking,
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
    await fixture.db.insert(schema.domains).values({
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
            if (!builder || typeof builder !== "object")
              throw new Error("fixture insert builder missing");
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

// Additive oracle for the finite-language compatibility change. All existing
// 34 tests remain unchanged, including the fragment <style> refusal oracle.
const compatibleDocument = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Receipt</title><style>
.receipt { background-color: #ffffff; padding: 16px; }
td { color: #333333; font-family: Arial, sans-serif; }
</style></head><body><div class="receipt"><h1>Requested receipt</h1><table cellpadding="0" cellspacing="0"><tbody><tr><td>Payment received</td><td>USD 24.00</td></tr></tbody></table><a href="https://sender.example/receipt?id=1&amp;view=full">View receipt</a></div></body></html>`;
const compatibleInline =
  '<table style="border-collapse:collapse;width:100%"><tbody><tr><td style="padding:16px;color:#333333;font-family:Arial,sans-serif">Requested receipt</td></tr></tbody></table>';
const baselineDocument =
  "<!DOCTYPE html><html><head><style>body{font-family:Arial}td{padding:12px}</style></head><body><table><tbody><tr><td>Recibo do pagamento solicitado: EUR 24,90.</td></tr></tbody></table></body></html>";
const baselineInline =
  '<table><tbody><tr><td style="padding:12px;color:#333">Recibo solicitado EUR 24,90</td></tr></tbody></table>';
it.each([compatibleDocument, compatibleInline, baselineDocument, baselineInline])(
  "finite safe document/inline CSS CLEAN captures exactly once (not a renderer proof)",
  async (html) => {
    const f = await seed({ html });
    const judge = {
      ...syntheticCleanContentJudge,
      judge: vi.fn(async (_block: string) => syntheticCleanVerdict),
    };
    const d = deps(judge);
    expect(await sendEmail(fixture.db, d.value, { emailId: f.id })).toBe("sent");
    expect(judge.judge).toHaveBeenCalledTimes(1);
    expect(judge.judge.mock.calls[0]![0]).toContain(
      html === baselineDocument || html === baselineInline ? "Recibo" : "Requested receipt",
    );
    expect(d.sendRaw).toHaveBeenCalledTimes(1);
    expect((await row(f.id)).sentAt).toBeInstanceOf(Date);
  },
);
it.each([
  { openTracking: true, clickTracking: false },
  { openTracking: false, clickTracking: true },
  { openTracking: true, clickTracking: true },
])("fresh domain explicit tracking %j, default email opts", async (flags) => {
  const f = await seed({ html: compatibleDocument });
  await fixture.db.update(schema.domains).set(flags).where(eq(schema.domains.id, f.domainId));
  const judge = {
    ...syntheticCleanContentJudge,
    judge: vi.fn(async (_block: string) => syntheticCleanVerdict),
  };
  const d = deps(judge);
  d.value.tracking = { secretKey: Buffer.alloc(32, 9), defaultBaseUrl: "https://track.example" };
  expect(await sendEmail(fixture.db, d.value, { emailId: f.id })).toBe("sent");
  expect(d.sendRaw).toHaveBeenCalledTimes(1);
  expect((await row(f.id)).sentAt).toBeInstanceOf(Date);
  const blocks = judge.judge.mock.calls.map((call) => call[0]).join("\n");
  expect(blocks).toContain("https://sender.example/receipt?id=1&view=full");
  if (flags.clickTracking) expect(blocks).toContain("https://track.example/t/c/");
  const mime = d.sendRaw.mock.calls[0]![0].raw.toString().replace(/=\r?\n/g, "");
  if (flags.openTracking) expect(mime).toContain("/t/o/");
});
it("hidden inline lure is retained in the projection and ABUSE prevents transport", async () => {
  const f = await seed({ html: `<div style="display:none">${bank}</div><p>Requested receipt</p>` });
  const judge = {
    ...syntheticCleanContentJudge,
    judge: vi.fn(async (block: string) =>
      block.includes("Banco CTT") ? abuse : syntheticCleanVerdict,
    ),
  };
  await held(f.id, deps(judge));
  expect(judge.judge).toHaveBeenCalledTimes(1);
  expect(judge.judge.mock.calls[0]![0]).toContain("Banco CTT");
});
it.each([
  '<div style="content:secret">Requested receipt</div>',
  '<div style="background-image:url(https://audit.invalid)">Receipt</div>',
  '<div style="width:expression(alert(1))">Receipt</div>',
  '<!doctype html><html><head><style>@import "https://audit.invalid";</style></head><body>Receipt</body></html>',
  '<!doctype html><html><head><style>p::before{content:"Banco CTT"}</style></head><body>Receipt</body></html>',
  "<p><div>invalid browser recovery</div></p>",
  "<table><p>foster-parented text</p></table>",
  '<div style="color:red" style="display:none">duplicate attribute</div>',
  '<div title="unclosed>Receipt</div>',
  "<div>truncated",
  "<div>&notAQualifiedEntity;</div>",
  "<div>Ban&#x200b;co CTT</div>",
  "<svg><text>receipt</text></svg>",
  '<meta http-equiv="refresh" content="0;url=https://audit.invalid">',
  '<form><input value="receipt"></form>',
  "<p>" + "x".repeat(6001) + "</p>",
  '<img src="https://track.example/t/o/copied" width="1" height="1" alt="Requested receipt" style="display:none">',
  '<p>Requested receipt</p><img src="https://sender.example/logo.png" alt="Legitimate receipt">',
])("unsupported author content stays HOLD even with explicit tracking: %s", async (html) => {
  const f = await seed({ html });
  await fixture.db
    .update(schema.domains)
    .set({ openTracking: true, clickTracking: true })
    .where(eq(schema.domains.id, f.domainId));
  const judge = {
    ...syntheticCleanContentJudge,
    judge: vi.fn(async (_block: string) => syntheticCleanVerdict),
  };
  const d = deps(judge);
  d.value.tracking = { secretKey: Buffer.alloc(32, 9), defaultBaseUrl: "https://track.example" };
  await held(f.id, d);
  expect(judge.judge).not.toHaveBeenCalled();
});
it("safe styled HTML never clears an ABUSE MIME text alternative", async () => {
  const f = await seed(
    { html: compatibleInline, text: bank },
    { tags: { [SYSTEM_MAIL_TAG]: "password_reset" } },
  );
  const judge = {
    ...syntheticCleanContentJudge,
    judge: vi.fn(async (block: string) =>
      block.includes("Banco CTT") ? abuse : syntheticCleanVerdict,
    ),
  };
  await held(f.id, deps(judge));
  expect(judge.judge.mock.calls.some((call) => call[0].includes("Banco CTT"))).toBe(true);
});

it("finite projection retains title, inline splits, decoded labels and full href", () => {
  const text = projectDispatchHtml(
    '<!doctype html><html><head><title>Receipt title</title></head><body><p>Ban<span>co</span> CTT</p><a href="https://sender.example/path?a=1&amp;b=2">R&#101;ceipt</a></body></html>',
  );
  expect(text).toContain("Receipt title");
  expect(text).toContain("Banco CTT");
  expect(text).toContain("Receipt");
  expect(text).toContain("https://sender.example/path?a=1&b=2");
});
it("tracking exemption is private, exact-regeneration-bound and source-image refusing", async () => {
  const before = '<p>Requested receipt</p><a href="https://sender.example/receipt">Receipt</a>';
  const options = {
    emailId: "fixture-email",
    trackingBaseUrl: "https://track.example",
    secretKey: Buffer.alloc(32, 9),
    click: true,
    open: true,
  };
  const snapshot = {
    teamId: "fixture-team",
    emailId: options.emailId,
    from: "a@sender.example",
    to: ["r@example.com"],
    cc: null,
    bcc: null,
    replyTo: null,
    subject: "Requested receipt",
    sourceHtml: before,
    sourceText: null,
    html: rewriteForTracking(before, options),
    text: null,
    headers: {},
    attachments: false,
    mime: Buffer.from("exact final MIME fixture"),
  };
  const context = {
    name: "fixture",
    plan: "free",
    ageDays: 1,
    verifiedDomains: ["sender.example"],
  };
  const judge = {
    ...syntheticCleanContentJudge,
    judge: vi.fn(async (_block: string) => syntheticCleanVerdict),
  };
  // A source-looking URL, signed pixel, JSON field, or clone is not capability.
  expect(
    await qualifyDispatchContent(
      { ...snapshot, trackingTrusted: true } as typeof snapshot,
      context,
      judge,
    ),
  ).toMatchObject({ allowed: false, reason: "uninspectable" });
  expect(judge.judge).not.toHaveBeenCalled();
  bindDispatchTracking(snapshot, before, options);
  expect(await qualifyDispatchContent(snapshot, context, judge)).toMatchObject({ allowed: true });
  const blocks = judge.judge.mock.calls.map((call) => call[0]).join("\n");
  expect(blocks).toContain("https://sender.example/receipt");
  expect(blocks).toContain("https://track.example/t/c/");
  judge.judge.mockClear();
  const clone = { ...snapshot };
  expect(await qualifyDispatchContent(clone, context, judge)).toMatchObject({ allowed: false });
  bindDispatchTracking(clone, "<p>different preimage</p>", options);
  expect(await qualifyDispatchContent(clone, context, judge)).toMatchObject({ allowed: false });
  snapshot.mime = Buffer.from("modified MIME");
  expect(await qualifyDispatchContent(snapshot, context, judge)).toMatchObject({ allowed: false });
  const authorImage = {
    ...clone,
    sourceHtml: before + '<img src="https://track.example/t/o/copied" width="1" height="1" alt="">',
  };
  bindDispatchTracking(authorImage, before, options);
  expect(await qualifyDispatchContent(authorImage, context, judge)).toMatchObject({
    allowed: false,
  });
  expect(judge.judge).not.toHaveBeenCalled();
});
