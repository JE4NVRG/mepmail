import { randomBytes } from "node:crypto";
import { decryptEmailBody, EnvKeyring, hashRecipient } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb, verifiedMonthlyBilling } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listSignupRiskReviewCandidates,
  type SignupRiskReviewCandidate,
} from "../../../packages/core/src/signup-risk-review-digest.js";
import {
  buildSignupRiskDigest,
  canRunSignupRiskDigest,
  SIGNUP_RISK_DIGEST_KIND,
  SIGNUP_RISK_DIGEST_RECIPIENT,
  type SignupRiskDigestDeps,
  sendSignupRiskDailyDigest,
  signupRiskDigestWindow,
  summarizeSignupRiskDigest,
} from "../src/handlers/signup-risk-digest.js";

const now = new Date("2026-10-17T11:00:00.000Z");
const recent = new Date("2026-10-17T09:00:00.000Z");
const old = new Date("2024-01-01T00:00:00.000Z");
const from = "MepMail <notifications@sender.example.test>";
const appBaseUrl = "https://app.example.test";
const signals = {
  domain: "signup.example.test",
  disposable: false,
  mx: "present" as const,
  domainAgeDays: 365,
  catchAll: "unknown" as const,
  randomLocal: false,
  ipKey: null,
  asn: null,
  signupsIp1h: 0,
  signupsDomain24h: 0,
  signupsAsn1h: 0,
};

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("synthetic fixture missing");
  return value;
}

it("08h Sao Paulo is 11h UTC, with a previous-08h window and a local-date dedupe key", () => {
  const window = required(signupRiskDigestWindow(now));
  expect(window.day).toBe("2026-10-17");
  expect(window.from.toISOString()).toBe("2026-10-16T11:00:00.000Z");
  expect(window.until.toISOString()).toBe(now.toISOString());
  expect(window.periodKey).toBe("America/Sao_Paulo:2026-10-17:alertas@je4ndev.com");
  expect(signupRiskDigestWindow(new Date("2026-10-17T10:59:59Z"))).toBeNull();
  expect(signupRiskDigestWindow(new Date("2026-10-17T11:59:59Z"))?.periodKey).toBe(
    window.periodKey,
  );
  expect(signupRiskDigestWindow(new Date("2026-10-17T12:00:00Z"))).toBeNull();
  expect(signupRiskDigestWindow(new Date("2027-01-01T11:00:00Z"))?.from.toISOString()).toBe(
    "2026-12-31T11:00:00.000Z",
  );
  // Historical DST proves that this is an IANA-zone clock, not a fixed UTC-3 shortcut.
  const dst = required(signupRiskDigestWindow(new Date("2018-11-04T10:00:00Z")));
  expect(dst.from.toISOString()).toBe("2018-11-03T11:00:00.000Z");
  expect(dst.until.toISOString()).toBe("2018-11-04T10:00:00.000Z");
});

it("web/API and non-cloud processes never qualify as the digest scheduler or sender", async () => {
  expect(canRunSignupRiskDigest(true, "worker")).toBe(true);
  expect(canRunSignupRiskDigest(true, "all")).toBe(true);
  for (const selection of ["web", "api", "smtp", "docs"])
    expect(canRunSignupRiskDigest(true, selection)).toBe(false);
  expect(canRunSignupRiskDigest(false, "worker")).toBe(false);
  const result = await sendSignupRiskDailyDigest({} as Db, {
    isCloud: true,
    processSelection: "web",
    from,
    appBaseUrl,
    keyring: EnvKeyring.fromBase64(randomBytes(32).toString("base64")),
    enqueueSend: vi.fn(),
    now: () => now,
  });
  expect(result).toEqual({ status: "disabled" });
});

it("the summary is a domain-only projection, prioritizes paid teams and counts each hold once", () => {
  const window = required(signupRiskDigestWindow(now));
  const row: SignupRiskReviewCandidate = {
    teamId: "private-team-id",
    level: "hold",
    reasons: ["private-reason"],
    policyVersion: 2,
    profileCreatedAt: recent,
    sendReviewAt: recent,
    suspendedAt: recent,
    reviewRequestedAt: recent,
    paid: true,
    paidHistory: true,
    paymentStatus: "confirmed",
    commercialActive: false,
    domains: [
      "paid.example.test",
      "Owner",
      "user@private.test",
      "192.0.2.1",
      "<script>",
      "https://private.test/body",
    ],
  };
  const summary = summarizeSignupRiskDigest([row, row], window);
  expect(summary).toMatchObject({
    pending: 1,
    paidAffected: 1,
    newHolds: 1,
    newSandbox: 0,
    reviewRequests: 1,
    newReviewRequests: 1,
  });
  const message = buildSignupRiskDigest(summary, window, appBaseUrl);
  expect(message.text.startsWith("Pagantes afetados: 1")).toBe(true);
  expect(message.text).toContain("paid.example.test");
  expect(message.text).toContain("https://app.example.test/console/safety#signup-reviews");
  for (const privateValue of [
    "private-team-id",
    "private-reason",
    "Owner",
    "user@private.test",
    "192.0.2.1",
    "<script>",
    "https://private.test/body",
  ])
    expect(`${message.text}${message.html}`).not.toContain(privateValue);
  expect(() =>
    buildSignupRiskDigest(summary, window, "https://user:secret@app.example.test"),
  ).toThrow("console_url_invalid");
});

describe("daily digest transaction, without SMTP or provider calls", () => {
  let db: Db;
  let close: () => Promise<void>;
  let home: string;
  let keyring: EnvKeyring;
  let enqueueSend = vi.fn<SignupRiskDigestDeps["enqueueSend"]>();
  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    home = await createTeam(db, "digest-home");
    await db.update(schema.teams).set({ plan: "system" }).where(eq(schema.teams.id, home));
    await db.insert(schema.domains).values({
      teamId: home,
      name: "sender.example.test",
      status: "verified",
      region: "us-east-1",
    });
    keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
    enqueueSend = vi.fn<SignupRiskDigestDeps["enqueueSend"]>().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await close();
  });
  const run = (over: Partial<SignupRiskDigestDeps> = {}) =>
    sendSignupRiskDailyDigest(db, {
      isCloud: true,
      processSelection: "worker",
      from,
      appBaseUrl,
      keyring,
      enqueueSend,
      now: () => now,
      ...over,
    });
  async function sandbox(slug = "new-sandbox") {
    const teamId = await createTeam(db, slug);
    await db
      .insert(schema.teamSignupRisk)
      .values({ teamId, level: "sandbox", policyVersion: 2, signals, createdAt: recent });
    return teamId;
  }
  const emails = () => db.select().from(schema.emails);
  const claims = () => db.select().from(schema.teamNotifications);
  const audits = () =>
    db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "signup_risk.digest_pipeline_accepted"));

  it("an empty queue or an out-of-hour run creates no claim, email, audit or enqueue", async () => {
    expect(await run()).toEqual({ status: "empty" });
    await sandbox();
    expect(await run({ now: () => new Date("2026-10-17T14:00:00Z") })).toEqual({
      status: "outside_window",
    });
    expect(await emails()).toHaveLength(0);
    expect(await claims()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
    expect(enqueueSend).not.toHaveBeenCalled();
  });

  it("includes legacy paid holds and review requests, without the customer-support cohort cutoff", async () => {
    vi.stubEnv("ACTIVATION_SUPPORT_FROM", "2026-10-17T10:00:00Z");
    await sandbox();
    const paid = await createTeam(db, "legacy-paid");
    const periodStart = new Date("2026-10-01T00:00:00Z");
    const periodEnd = new Date("2026-11-01T00:00:00Z");
    await db
      .update(schema.teams)
      .set({
        createdAt: old,
        plan: "starter",
        planStatus: "canceled",
        sendReviewAt: old,
        sendReviewReason: "new_sender",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        ...verifiedMonthlyBilling({ teamId: paid, periodStart, periodEnd, included: 100_000 }),
      })
      .where(eq(schema.teams.id, paid));
    await db
      .insert(schema.domains)
      .values({ teamId: paid, name: "paid.example.test", region: "us-east-1" });
    await db.insert(schema.signupRiskReviewRequests).values({
      teamId: paid,
      context: "PRIVATE OWNER private@private.test 192.0.2.77",
      requestedAt: recent,
      updatedAt: recent,
    });
    const readPayments = vi.fn(async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, "confirmed" as const])),
    );
    const result = await run({ readPayments });
    expect(result).toMatchObject({
      status: "pipeline_accepted",
      queued: true,
      summary: {
        pending: 2,
        paidAffected: 1,
        newSandbox: 1,
        newHolds: 0,
        reviewRequests: 1,
        newReviewRequests: 1,
      },
    });
    const email = required((await emails())[0]);
    expect(email).toMatchObject({
      teamId: home,
      from,
      to: ["alertas@je4ndev.com"],
      latestStatus: "queued",
      sesMessageId: null,
      tags: { mepmail_system: SIGNUP_RISK_DIGEST_KIND },
    });
    expect(email.cc).toBeNull();
    expect(email.bcc).toBeNull();
    const content = await decryptEmailBody(
      {
        ciphertext: required(email.bodyCiphertext),
        iv: required(email.bodyIv),
        wrappedDek: required(email.bodyWrappedDek),
        keyVersion: required(email.bodyKeyVersion),
      },
      keyring,
      { teamId: home, rowId: email.id },
    );
    expect(content.text?.startsWith("Pagantes afetados: 1")).toBe(true);
    expect(content.text).toContain("paid.example.test");
    expect(JSON.stringify(content)).not.toMatch(
      /PRIVATE OWNER|private@private\.test|192\.0\.2\.77|legacy-paid|new_sender/,
    );
    expect(enqueueSend).toHaveBeenCalledWith(email.id, undefined, 1);
    expect(await claims()).toHaveLength(1);
    expect((await audits())[0]?.data).toMatchObject({ emailId: email.id, paidAffected: 1 });
    // Acceptance has not fabricated provider or delivery evidence.
    expect(await db.select().from(schema.emailEvents)).toHaveLength(0);
    const [candidate] = (await listSignupRiskReviewCandidates(db, now, readPayments)).filter(
      (row) => row.teamId === paid,
    );
    expect(candidate).toMatchObject({
      paid: true,
      paidHistory: true,
      paymentStatus: "confirmed",
      commercialActive: false,
    });
  });

  it("concurrent/retried executions accept exactly one message for the day, recipient and zone", async () => {
    await sandbox();
    const results = await Promise.all([run(), run(), run()]);
    expect(results.filter((result) => result.status === "pipeline_accepted")).toHaveLength(1);
    expect(results.filter((result) => result.status === "duplicate")).toHaveLength(2);
    expect(await emails()).toHaveLength(1);
    expect(await claims()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
    expect(enqueueSend).toHaveBeenCalledTimes(1);
    // Even loss of the team-scoped ledger is reconciled by the append-only acceptance audit.
    await db.delete(schema.teamNotifications);
    expect(await run()).toMatchObject({ status: "duplicate" });
    expect(await emails()).toHaveLength(1);
    expect(await run({ now: () => new Date("2026-10-18T11:00:00Z") })).toMatchObject({
      status: "pipeline_accepted",
    });
    expect(await emails()).toHaveLength(2);
  });

  it("includes a paid legacy team whose only restriction is suspension, and counts its new hold once", async () => {
    const paid = await createTeam(db, "legacy-suspended-paid");
    const periodStart = new Date("2026-10-01T00:00:00Z");
    const periodEnd = new Date("2026-11-01T00:00:00Z");
    await db
      .update(schema.teams)
      .set({
        createdAt: old,
        suspendedAt: recent,
        suspensionReason: "manual",
        planStatus: "active",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        ...verifiedMonthlyBilling({ teamId: paid, periodStart, periodEnd, included: 100_000 }),
      })
      .where(eq(schema.teams.id, paid));
    await db
      .insert(schema.domains)
      .values({ teamId: paid, name: "suspended-paid.example.test", region: "us-east-1" });
    // No signup profile, sendReviewAt or review request exists for this legacy team.
    expect(
      await run({
        readPayments: async (ids) =>
          Object.fromEntries(ids.map((id) => [id, "confirmed" as const])),
      }),
    ).toMatchObject({
      status: "pipeline_accepted",
      summary: {
        pending: 1,
        paidAffected: 1,
        newHolds: 1,
        newSandbox: 0,
        reviewRequests: 0,
        newReviewRequests: 0,
        paidDomains: ["suspended-paid.example.test"],
      },
    });
    expect(await emails()).toHaveLength(1);
  });

  it("keeps commercial terms separate from payment proof and treats missing/failed reads as unknown", async () => {
    const teamId = await sandbox();
    const periodStart = new Date("2026-10-01T00:00:00Z");
    const periodEnd = new Date("2026-11-01T00:00:00Z");
    await db
      .update(schema.teams)
      .set({
        planStatus: "active",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        ...verifiedMonthlyBilling({ teamId, periodStart, periodEnd, included: 100_000 }),
      })
      .where(eq(schema.teams.id, teamId));
    const missing = required((await listSignupRiskReviewCandidates(db, now))[0]);
    expect(missing).toMatchObject({
      commercialActive: true,
      paid: false,
      paidHistory: false,
      paymentStatus: "unknown",
    });
    const failed = required(
      (
        await listSignupRiskReviewCandidates(db, now, async () => {
          throw new Error("synthetic provider failure");
        })
      )[0],
    );
    expect(failed).toMatchObject({ commercialActive: true, paid: false, paymentStatus: "unknown" });
    const notObserved = required(
      (
        await listSignupRiskReviewCandidates(db, now, async (ids) =>
          Object.fromEntries(ids.map((id) => [id, "not_observed" as const])),
        )
      )[0],
    );
    expect(notObserved).toMatchObject({ paid: false, paymentStatus: "not_observed" });
    // A legacy analytics event is not positive-money proof, including invoice-zero paths.
    await db.insert(schema.funnelEvents).values({
      name: "payment_succeeded",
      dedupeKey: "synthetic_invoice_zero",
      teamId,
      createdAt: old,
    });
    expect(required((await listSignupRiskReviewCandidates(db, now))[0])).toMatchObject({
      paid: false,
      paymentStatus: "unknown",
    });
  });

  it("reads provider evidence before the transaction and never calls the network reader under the lock", async () => {
    const teamId = await sandbox();
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: "cus_protected_fixture" })
      .where(eq(schema.teams.id, teamId));
    const transaction = vi.spyOn(db, "transaction");
    const readPayments = vi.fn(async (ids: string[]) => {
      expect(transaction).not.toHaveBeenCalled();
      expect(ids).toEqual(["cus_protected_fixture"]);
      return { cus_protected_fixture: "confirmed" as const };
    });
    expect(await run({ readPayments })).toMatchObject({
      status: "pipeline_accepted",
      summary: { paidAffected: 1 },
    });
    expect(readPayments).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("new customer IDs observed inside the transaction remain unknown instead of reusing another customer's proof", async () => {
    const teamId = await sandbox();
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: "cus_previous_fixture" })
      .where(eq(schema.teams.id, teamId));
    const readPayments = vi.fn(async () => {
      await db
        .update(schema.teams)
        .set({ stripeCustomerId: "cus_changed_fixture" })
        .where(eq(schema.teams.id, teamId));
      return { cus_previous_fixture: "confirmed" as const };
    });
    expect(await run({ readPayments })).toMatchObject({
      status: "pipeline_accepted",
      summary: { paidAffected: 0, paymentUnconfirmed: 1 },
    });
    expect(readPayments).toHaveBeenCalledTimes(1);
  });

  it("rechecks the clock after waiting for the day lock and refuses a run that crossed 09h", async () => {
    await sandbox();
    const readNow = vi
      .fn()
      .mockReturnValueOnce(new Date("2026-10-17T11:59:59Z"))
      .mockReturnValue(new Date("2026-10-17T12:00:00Z"));
    expect(await run({ now: readNow })).toEqual({ status: "outside_window" });
    expect(readNow).toHaveBeenCalledTimes(2);
    expect(await emails()).toHaveLength(0);
    expect(await claims()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
    expect(enqueueSend).not.toHaveBeenCalled();
  });

  it("rechecks immediately before accept when a queue or sender lookup crossed 09h", async () => {
    await sandbox();
    const readNow = vi
      .fn()
      .mockReturnValueOnce(new Date("2026-10-17T11:59:58Z"))
      .mockReturnValueOnce(new Date("2026-10-17T11:59:59Z"))
      .mockReturnValue(new Date("2026-10-17T12:00:00Z"));
    const wrap = vi.spyOn(keyring, "wrapDek");
    expect(await run({ now: readNow })).toEqual({ status: "outside_window" });
    expect(wrap).not.toHaveBeenCalled();
    expect(await emails()).toHaveLength(0);
    expect(await claims()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
    expect(enqueueSend).not.toHaveBeenCalled();
  });

  it("rolls back a tentative accept if encryption itself crosses 09h", async () => {
    await sandbox();
    let at = new Date("2026-10-17T11:59:59Z");
    const wrap = keyring.wrapDek.bind(keyring);
    vi.spyOn(keyring, "wrapDek").mockImplementation(async (dek) => {
      at = new Date("2026-10-17T12:00:00Z");
      return wrap(dek);
    });
    expect(await run({ now: () => at })).toEqual({ status: "outside_window" });
    expect(await emails()).toHaveLength(0);
    expect(await claims()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
    expect(enqueueSend).not.toHaveBeenCalled();
  });

  it("a pre-commit encryption failure leaves no claim and a natural-hour retry succeeds once", async () => {
    await sandbox();
    await expect(
      run({
        keyring: {
          wrapDek: vi.fn().mockRejectedValue(new Error("synthetic keyring failure")),
          unwrapDek: keyring.unwrapDek.bind(keyring),
        },
      }),
    ).rejects.toThrow("synthetic keyring failure");
    expect(await emails()).toHaveLength(0);
    expect(await claims()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
    expect(await run()).toMatchObject({ status: "pipeline_accepted" });
    expect(await run()).toMatchObject({ status: "duplicate" });
  });

  it("an uncertain enqueue after commit relies on reconciliation and never recreates the digest", async () => {
    await sandbox();
    vi.spyOn(console, "error").mockImplementation(() => {});
    enqueueSend.mockRejectedValue(new Error("synthetic queue failure"));
    const accepted = await run();
    expect(accepted).toMatchObject({ status: "pipeline_accepted", queued: false });
    expect(await run()).toMatchObject({ status: "duplicate" });
    expect(await emails()).toHaveLength(1);
    expect(await claims()).toHaveLength(1);
    expect(enqueueSend).toHaveBeenCalledTimes(1);
  });

  it("uses the existing suppression guard and refuses without a raw-provider fallback", async () => {
    await sandbox();
    await db.insert(schema.suppressions).values({
      teamId: home,
      email: SIGNUP_RISK_DIGEST_RECIPIENT,
      emailHash: hashRecipient(SIGNUP_RISK_DIGEST_RECIPIENT),
      reason: "manual",
    });
    await expect(run()).rejects.toThrow("pipeline_refused:all_suppressed");
    expect(await claims()).toHaveLength(0);
    expect(await emails()).toHaveLength(0);
    expect(enqueueSend).not.toHaveBeenCalled();
  });

  it("a missing verified sender or a held operational team does not create a digest", async () => {
    await sandbox();
    await expect(run({ from: "MepMail <notifications@unverified.example.test>" })).rejects.toThrow(
      "sender_unverified",
    );
    await db
      .update(schema.teams)
      .set({ sendReviewAt: recent, sendReviewReason: "new_sender" })
      .where(eq(schema.teams.id, home));
    await expect(run()).rejects.toThrow("sender_restricted");
    expect(await claims()).toHaveLength(0);
    expect(await emails()).toHaveLength(0);
  });
});
