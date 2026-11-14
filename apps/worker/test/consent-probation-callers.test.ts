import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  acceptEmail,
  approveProductionVolume,
  EnvKeyring,
  findInstanceOperator,
  MailboxSendDeferredError,
  observeProductionVolume,
  productionVolumeStatus,
  teamQuota,
  utcDay,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb, verifiedMonthlyBilling } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  campaignMessage,
  reviewCampaignConsent,
  submitCampaignConsent,
} from "../../../packages/core/src/campaign-consent.js";
import { processProviderEvent } from "../../../packages/core/src/process-provider-event.js";
import {
  applySenderProbationQuota,
  probationCeiling,
} from "../../../packages/core/src/sender-probation.js";
import { sendEmail } from "../src/handlers/send-email.js";
import { createMailboxContentPolicySender, createMailboxSesSender } from "../src/mailbox-sender.js";
import { syntheticCleanContentJudge } from "./fixtures/clean-content-judge.js";

let fixture: Awaited<ReturnType<typeof createTestDb>>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const promo = "Course Spotlight. Limited seats. Register for London training.";
const evidence = {
  listReference: "synthetic-list-42",
  source: "First party public registration form",
  method: "Explicit unchecked consent checkbox",
  formUrl: "https://example.test/signup",
  permissionText: "I agree to receive Example training offers.",
  permissionScope: "Example training and course invitations",
  samples: [
    { reference: "record-***42", registeredAt: "2026-01-01T12:00:00.000Z", ipAvailable: false },
  ],
};
beforeAll(async () => {
  fixture = await createTestDb();
  const path = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
  const client = (fixture.db as unknown as { $client: { exec: (sql: string) => Promise<unknown> } })
    .$client;
  for (const file of readdirSync(path)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await client.exec(readFileSync(path + file, "utf8"));
});
afterAll(async () => {
  await fixture?.close();
});
async function setup(approved = false) {
  const { db } = fixture;
  const teamId = await createTeam(db, randomUUID());
  const name = `${randomUUID()}.example.test`;
  const now = new Date();
  await db
    .update(schema.teams)
    .set({ createdAt: new Date(now.getTime() - 40 * 86400000), sendReviewClearedAt: now })
    .where(eq(schema.teams.id, teamId));
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name,
      region: "us-east-1",
      status: "verified",
      dkimSelector: "test",
      mailFromSubdomain: "send",
      dmarcPolicy: "none",
      dmarcCheckedAt: now,
      lastCheckedAt: now,
      dnsRecords: [
        { group: "verification", name: `test._domainkey.${name}`, type: "TXT", status: "found" },
        { group: "sending", name: `send.${name}`, type: "TXT", status: "found" },
        { group: "sending", name: `send.${name}`, type: "MX", status: "found" },
        { group: "dmarc", name: `_dmarc.${name}`, type: "TXT", status: "found" },
      ],
    })
    .returning();
  if (!domain) throw new Error("fixture domain missing");
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  if (!team) throw new Error("fixture team missing");
  const owner = `owner-${randomUUID()}`,
    operatorId = `operator-${randomUUID()}`;
  const dossier = approved
    ? await submitCampaignConsent(db, { teamId, actorId: owner, evidence })
    : null;
  if (dossier)
    await reviewCampaignConsent(db, {
      teamId,
      dossierId: dossier.id,
      operatorId,
      decision: "approved",
      reason: "Synthetic first party evidence reviewed",
    });
  return { teamId, domain, team, from: `service@${name}`, dossier, operatorId };
}
async function accept(f: Awaited<ReturnType<typeof setup>>, text = promo, opts = {}) {
  return acceptEmail(
    { db: fixture.db, keyring, isCloud: true, enqueueEmailSend: vi.fn() },
    { teamId: f.teamId, apiKeyId: null, billing: f.team },
    {
      from: f.from,
      to: ["recipient@example.test"],
      subject: "Message",
      text,
      domainId: f.domain.id,
    },
    opts,
  );
}
function mail(f: Awaited<ReturnType<typeof setup>>, mailboxId: string, text = promo) {
  return {
    teamId: f.teamId,
    mailboxId,
    idempotencyKey: randomUUID(),
    outboxId: randomUUID(),
    attemptId: randomUUID(),
    from: f.from,
    to: ["recipient@example.test"],
    cc: [],
    bcc: [],
    raw: Buffer.from(
      `From: ${f.from}\r\nTo: recipient@example.test\r\nSubject: Message\r\nContent-Type: text/plain\r\n\r\n${text}`,
    ),
  };
}
async function box(f: Awaited<ReturnType<typeof setup>>) {
  const [row] = await fixture.db
    .insert(schema.mailboxes)
    .values({
      teamId: f.teamId,
      domainId: f.domain.id,
      address: f.from,
      label: "Synthetic",
      kind: "person",
    })
    .returning();
  if (!row) throw new Error("fixture box missing");
  return row.id;
}
it("known training promotion is campaign without client labels; account registration/reset is not", () => {
  expect(campaignMessage({ text: promo })).toBe(true);
  expect(campaignMessage({ text: "Register your application account to finish setup." })).toBe(
    false,
  );
  expect(campaignMessage({ text: "You requested a password reset." })).toBe(false);
});
it("shared API/batch/SMTP/MCP accept cannot admit campaign before consent, including deferred batches", async () => {
  const f = await setup();
  expect(await accept(f)).toMatchObject({ ok: false, reason: "campaign_consent_required" });
  await fixture.db.transaction(async (tx) => {
    expect(await accept(f, promo, { tx, quota: "deferred" })).toMatchObject({
      ok: false,
      reason: "campaign_consent_required",
    });
  });
  expect(
    await fixture.db.select().from(schema.emails).where(eq(schema.emails.teamId, f.teamId)),
  ).toHaveLength(0);
});
it("approved admission reserves once; revocation after admission blocks SES and preserves body/claim", async () => {
  const f = await setup(true);
  const result = await accept(f);
  expect(result.ok).toBe(true);
  if (!result.ok || !f.dossier) throw new Error("fixture not accepted");
  const [before] = await fixture.db
    .select()
    .from(schema.emails)
    .where(eq(schema.emails.id, result.id));
  await reviewCampaignConsent(fixture.db, {
    teamId: f.teamId,
    dossierId: f.dossier.id,
    operatorId: f.operatorId,
    decision: "revoked",
    reason: "Synthetic permission withdrawn after queueing",
  });
  const sendRaw = vi.fn();
  expect(
    await sendEmail(
      fixture.db,
      { keyring, isCloud: true, contentJudge: syntheticCleanContentJudge, ses: { sendRaw } },
      { emailId: result.id },
    ),
  ).toBe("parked");
  expect(sendRaw).not.toHaveBeenCalled();
  const [after] = await fixture.db
    .select()
    .from(schema.emails)
    .where(eq(schema.emails.id, result.id));
  expect(after?.sentAt).toBeNull();
  expect(after?.bodyCiphertext).toEqual(before?.bodyCiphertext);
});
it("consent revoked during throttle blocks selected external relay before transport", async () => {
  const f = await setup(true);
  await fixture.db
    .update(schema.domains)
    .set({ relayEnabledAt: new Date() })
    .where(eq(schema.domains.id, f.domain.id));
  const result = await accept(f);
  if (!result.ok || !f.dossier) throw new Error("fixture not accepted");
  const sendRaw = vi.fn();
  const throttle = async () => {
    await reviewCampaignConsent(fixture.db, {
      teamId: f.teamId,
      dossierId: f.dossier!.id,
      operatorId: f.operatorId,
      decision: "revoked",
      reason: "Synthetic revoke during throttle wait",
    });
  };
  expect(
    await sendEmail(
      fixture.db,
      {
        keyring,
        isCloud: true,
        ses: { sendRaw },
        relay: { name: "synthetic", sender: { sendRaw } },
        sendingProviderPolicy: {
          version: 1,
          defaults: { campaign: "customer_smtp", transactional: "customer_smtp" },
        },
        throttle,
      },
      { emailId: result.id },
    ),
  ).toBe("parked");
  expect(sendRaw).not.toHaveBeenCalled();
});
it("password reset passes and atomic existing quota parks the 26th admission", async () => {
  const f = await setup();
  await fixture.db
    .update(schema.teams)
    .set({ sendReviewClearedAt: null, sendReviewAt: null })
    .where(eq(schema.teams.id, f.teamId));
  const results = [];
  for (let i = 0; i < 26; i++) results.push(await accept(f, "You requested a password reset."));
  expect(results.filter((r) => r.ok && !r.parked)).toHaveLength(25);
  expect(results[25]).toMatchObject({ ok: true, parked: true });
  const [counter] = await fixture.db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, f.teamId));
  expect(counter?.accepted).toBe(25);
  const first = results[0];
  if (!first?.ok) throw new Error("fixture not accepted");
  const sendRaw = vi.fn().mockResolvedValue({ messageId: "synthetic-reset" });
  expect(
    await sendEmail(
      fixture.db,
      { keyring, isCloud: true, contentJudge: syntheticCleanContentJudge, ses: { sendRaw } },
      { emailId: first.id },
    ),
  ).toBe("sent");
  expect(sendRaw).toHaveBeenCalledTimes(1);
});
it("graduation boundary requires operator ceiling, clean history and fresh actual DNS; plan cap retained", async () => {
  const input = { reviewed: true, dnsReady: true, clean: true, operatorCeiling: 1000 };
  expect(probationCeiling({ ...input, ageDays: 6.999 })).toBe(100);
  expect(probationCeiling({ ...input, ageDays: 7 })).toBe(200);
  expect(probationCeiling({ ...input, ageDays: 29.999 })).toBe(200);
  expect(probationCeiling({ ...input, ageDays: 30 })).toBe(1000);
  // A proven month-old sender graduates on its own; an operator ceiling can still
  // raise it above the ladder, and a young one cannot be lifted by the number typed.
  expect(probationCeiling({ ...input, ageDays: 90, operatorCeiling: null })).toBe(1000);
  expect(probationCeiling({ ...input, ageDays: 90, operatorCeiling: 5000 })).toBe(5000);
  expect(probationCeiling({ ...input, ageDays: 3, operatorCeiling: 5000 })).toBe(100);
  for (const key of ["reviewed", "dnsReady", "clean"] as const)
    expect(probationCeiling({ ...input, [key]: false, ageDays: 90 })).toBe(25);
  const f = await setup();
  await fixture.db
    .update(schema.teams)
    .set({ dailySendCeiling: 1000 })
    .where(eq(schema.teams.id, f.teamId));
  const quota = { kind: "day" as const, plan: "free" as const, limit: 100, dailyCeiling: 80 };
  expect(await applySenderProbationQuota(fixture.db, f.teamId, quota, true)).toMatchObject({
    limit: 100,
    dailyCeiling: 80,
  });
  expect(
    await applySenderProbationQuota(fixture.db, f.teamId, { kind: "none" }, true),
  ).toMatchObject({ dailyCeiling: 1000 });
  await fixture.db
    .update(schema.domains)
    .set({ lastCheckedAt: new Date(Date.now() - 86400001) })
    .where(eq(schema.domains.id, f.domain.id));
  expect(
    await applySenderProbationQuota(fixture.db, f.teamId, { kind: "none" }, true),
  ).toMatchObject({ dailyCeiling: 25 });
  expect(await applySenderProbationQuota(fixture.db, f.teamId, quota, false)).toEqual(quota);
  await fixture.db
    .update(schema.domains)
    .set({ lastCheckedAt: new Date() })
    .where(eq(schema.domains.id, f.domain.id));
  const [old] = await fixture.db
    .insert(schema.emails)
    .values({
      teamId: f.teamId,
      from: f.from,
      to: ["recipient@example.test"],
      subject: "Old synthetic receipt",
      createdAt: new Date(Date.now() - 60 * 86400000),
    })
    .returning();
  if (!old) throw new Error("fixture email missing");
  await fixture.db
    .insert(schema.emailEvents)
    .values({ emailId: old.id, type: "complained", occurredAt: new Date(), data: {} });
  expect(
    await applySenderProbationQuota(fixture.db, f.teamId, { kind: "none" }, true),
  ).toMatchObject({ dailyCeiling: 25 });
});
it("outer Correio SMTP and direct SES reject campaign with no consent", async () => {
  const f = await setup();
  const id = await box(f);
  const send = vi.fn();
  const clientFactory = vi.fn();
  await expect(
    createMailboxContentPolicySender(fixture.db, { send }, true).send(mail(f, id)),
  ).rejects.toBeInstanceOf(MailboxSendDeferredError);
  await expect(
    createMailboxSesSender(fixture.db, {
      isCloud: true,
      configurationSets: { "us-east-1": "private_mail" },
      clientFactory,
    }).send(mail(f, id)),
  ).rejects.toBeInstanceOf(MailboxSendDeferredError);
  expect(send).not.toHaveBeenCalled();
  expect(clientFactory).not.toHaveBeenCalled();
});
it("Correio outer/direct SES share one quota reservation; the 26th never invokes transport", async () => {
  const f = await setup();
  await fixture.db
    .update(schema.teams)
    .set({ sendReviewClearedAt: null, sendReviewAt: null })
    .where(eq(schema.teams.id, f.teamId));
  const id = await box(f);
  const send = vi.fn().mockResolvedValue({ MessageId: "synthetic-mail" });
  const direct = createMailboxSesSender(fixture.db, {
    isCloud: true,
    configurationSets: { "us-east-1": "private_mail" },
    clientFactory: () => ({ send }),
  });
  const outer = createMailboxContentPolicySender(fixture.db, direct, true);
  for (let i = 0; i < 25; i++) await outer.send(mail(f, id, "You requested a password reset."));
  await expect(outer.send(mail(f, id, "You requested a password reset."))).rejects.toBeInstanceOf(
    MailboxSendDeferredError,
  );
  expect(send).toHaveBeenCalledTimes(25);
  const [counter] = await fixture.db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, f.teamId));
  expect(counter?.accepted).toBe(25);
});
it("ambiguous worker acceptance retains claim and cannot retry transport", async () => {
  const f = await setup();
  const result = await accept(f, "You requested a password reset.");
  if (!result.ok) throw new Error("fixture not accepted");
  const sendRaw = vi
    .fn()
    .mockRejectedValue(Object.assign(new Error("synthetic timeout"), { name: "TimeoutError" }));
  const deps = {
    keyring,
    isCloud: true,
    contentJudge: syntheticCleanContentJudge,
    ses: { sendRaw },
  };
  await expect(sendEmail(fixture.db, deps, { emailId: result.id })).rejects.toThrow(
    "synthetic timeout",
  );
  expect(await sendEmail(fixture.db, deps, { emailId: result.id })).toBe("skipped");
  expect(sendRaw).toHaveBeenCalledTimes(1);
});
it("approved campaign reaches fake transport without a second reservation", async () => {
  const f = await setup(true);
  const result = await accept(f);
  if (!result.ok) throw new Error("fixture not accepted");
  const sendRaw = vi.fn().mockResolvedValue({ messageId: "synthetic-campaign" });
  expect(
    await sendEmail(
      fixture.db,
      { keyring, isCloud: true, contentJudge: syntheticCleanContentJudge, ses: { sendRaw } },
      { emailId: result.id },
    ),
  ).toBe("sent");
  const [counter] = await fixture.db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, f.teamId));
  expect(counter?.accepted).toBe(1);
  expect(sendRaw).toHaveBeenCalledTimes(1);
});
it("external SMTP receives same 25/day cap; unknown acceptance keeps its charge", async () => {
  const f = await setup();
  await fixture.db
    .update(schema.teams)
    .set({ sendReviewClearedAt: null, sendReviewAt: null })
    .where(eq(schema.teams.id, f.teamId));
  const id = await box(f);
  const send = vi.fn().mockResolvedValue({ messageId: "synthetic-external" });
  const sender = createMailboxContentPolicySender(fixture.db, { send }, true);
  for (let i = 0; i < 24; i++) await sender.send(mail(f, id, "Your password reset was requested."));
  send.mockRejectedValueOnce(new Error("synthetic unknown acceptance"));
  await expect(sender.send(mail(f, id, "Your password reset was requested."))).rejects.toThrow(
    "synthetic unknown acceptance",
  );
  await expect(
    sender.send(mail(f, id, "Your password reset was requested.")),
  ).rejects.toBeInstanceOf(MailboxSendDeferredError);
  expect(send).toHaveBeenCalledTimes(25);
});
it("direct SES rechecks revocation after throttle; explicit deferral refunds once", async () => {
  const f = await setup(true);
  const id = await box(f);
  if (!f.dossier) throw new Error("fixture dossier missing");
  const send = vi.fn();
  const sender = createMailboxSesSender(fixture.db, {
    isCloud: true,
    configurationSets: { "us-east-1": "private_mail" },
    clientFactory: () => ({ send }),
    throttle: async () => {
      await reviewCampaignConsent(fixture.db, {
        teamId: f.teamId,
        dossierId: f.dossier!.id,
        operatorId: f.operatorId,
        decision: "revoked",
        reason: "Synthetic consent revoked in throttle",
      });
    },
  });
  await expect(sender.send(mail(f, id))).rejects.toBeInstanceOf(MailboxSendDeferredError);
  expect(send).not.toHaveBeenCalled();
  const [counter] = await fixture.db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, f.teamId));
  expect(counter?.accepted).toBe(0);
});

it("Native personal CC passes campaign-disabled policy and cloud consent, unlike public Send", async () => {
  const f = await setup();
  const id = await box(f);
  const input = {
    ...mail(f, id, "Can we meet tomorrow to discuss the document?"),
    cc: ["colleague@example.test"],
  };
  input.raw = Buffer.from(
    input.raw.toString().replace("Subject:", "Cc: colleague@example.test\r\nSubject:"),
  );
  const send = vi.fn().mockResolvedValue({ messageId: "synthetic-personal-cc" });
  const azure = { send: vi.fn() };
  await createMailboxContentPolicySender(
    fixture.db,
    { send },
    true,
    { version: 1, defaults: { transactional: "ses", campaign: "disabled" } },
    azure,
  ).send(input);
  expect(send).toHaveBeenCalledTimes(1);
  expect(azure.send).not.toHaveBeenCalled();
  expect(campaignMessage({ to: input.to, cc: input.cc })).toBe(true);
  const [counter] = await fixture.db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, f.teamId));
  expect(counter?.accepted).toBe(2);
});

async function volumeFixture() {
  const f = await setup(true);
  let operator = await findInstanceOperator(fixture.db);
  if (!operator) {
    const id = randomUUID();
    await fixture.db.insert(schema.user).values({
      id,
      name: "Operator",
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: new Date(0),
    });
    operator = await findInstanceOperator(fixture.db);
  }
  if (!operator) throw new Error("missing operator");
  const id = randomUUID();
  await fixture.db
    .insert(schema.user)
    .values({ id, name: "Principal", email: `${id}@example.test`, emailVerified: true });
  await fixture.db.insert(schema.teamSignupRisk).values({
    teamId: f.teamId,
    principalUserId: id,
    level: "good",
    signals: {
      domain: "example.test",
      disposable: false,
      mx: "present",
      domainAgeDays: 100,
      catchAll: "unknown",
      randomLocal: false,
      ipKey: null,
      asn: null,
      signupsIp1h: 0,
      signupsDomain24h: 0,
      signupsAsn1h: 0,
    },
  });
  const start = new Date(Date.now() - 86400000),
    end = new Date(Date.now() + 29 * 86400000);
  const binding = verifiedMonthlyBilling({
    teamId: f.teamId,
    periodStart: start,
    periodEnd: end,
    included: 110000,
  });
  const customerId = `cus_${f.teamId}`,
    subscriptionId = `sub_${f.teamId}`;
  await fixture.db
    .update(schema.teams)
    .set({
      plan: "pro",
      overageEnabled: false,
      planStatus: "active",
      planQuota: 110000,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      ...verifiedMonthlyBilling({
        teamId: f.teamId,
        periodStart: start,
        periodEnd: end,
        included: 110000,
      }),
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      sendBillingContract: { ...binding.sendBillingContract, customerId, subscriptionId },
      billingTerms: { ...binding.billingTerms, customerId, subscriptionId },
      createdAt: new Date(),
      dailySendCeiling: 4000,
    })
    .where(eq(schema.teams.id, f.teamId));
  const [team] = await fixture.db.select().from(schema.teams).where(eq(schema.teams.id, f.teamId));
  if (!team) throw new Error("missing team");
  const oldAt = new Date(Date.now() - 2 * 86400000);
  const [historical] = await fixture.db
    .insert(schema.emails)
    .values({
      teamId: f.teamId,
      from: f.from,
      to: ["old@example.test"],
      subject: "Reviewed history",
      latestStatus: "bounced",
      createdAt: oldAt,
      sentAt: oldAt,
      sesMessageId: `old-${f.teamId}`,
    })
    .returning();
  if (!historical) throw new Error("missing history");
  await fixture.db.insert(schema.emailEvents).values({
    emailId: historical.id,
    type: "bounced",
    bounceType: "Permanent",
    occurredAt: oldAt,
    createdAt: oldAt,
    data: {},
  });
  const decision = async (overrides = {}) =>
    approveProductionVolume(fixture.db, {
      teamId: f.teamId,
      operatorId: operator.id,
      expectedEpoch: (await observeProductionVolume(fixture.db, f.teamId)).epoch,
      dailyCeiling: 4000,
      reason: "Synthetic independent review including historical outcomes",
      evidenceReference: "fixture-remediation-42",
      ...overrides,
    });
  return { ...f, team, principal: id, operatorId: operator.id, decision };
}
it("young explicit approval enqueues, sends once with CLEAN, retains 110K and UTC ledger, retry skips", async () => {
  const f = await volumeFixture();
  expect((await productionVolumeStatus(fixture.db, f.teamId)).ceiling).toBeNull();
  await f.decision();
  expect((await productionVolumeStatus(fixture.db, f.teamId)).ceiling).toBe(4000);
  expect(
    await applySenderProbationQuota(fixture.db, f.teamId, teamQuota(f.team, true), true),
  ).toMatchObject({ kind: "month", included: 110000, dailyCeiling: 4000 });
  const enqueue = vi.fn();
  const result = await acceptEmail(
    { db: fixture.db, keyring, isCloud: true, enqueueEmailSend: enqueue },
    { teamId: f.teamId, billing: f.team, apiKeyId: null },
    {
      from: f.from,
      to: ["recipient@example.test"],
      subject: "Message",
      text: promo,
      domainId: f.domain.id,
    },
  );
  expect(result).toMatchObject({ ok: true, parked: false });
  expect(enqueue).toHaveBeenCalledTimes(1);
  if (!result.ok) throw new Error("not accepted");
  const sendRaw = vi.fn().mockResolvedValue({ messageId: "synthetic-explicit-volume" });
  const deps = {
    keyring,
    isCloud: true,
    contentJudge: syntheticCleanContentJudge,
    ses: { sendRaw },
  };
  expect(await sendEmail(fixture.db, deps, { emailId: result.id })).toBe("sent");
  expect(await sendEmail(fixture.db, deps, { emailId: result.id })).toBe("skipped");
  expect(sendRaw).toHaveBeenCalledTimes(1);
  const [email] = await fixture.db
    .select()
    .from(schema.emails)
    .where(eq(schema.emails.id, result.id));
  expect(email?.sentAt).toBeInstanceOf(Date);
  const [counter] = await fixture.db
    .select()
    .from(schema.usageCounters)
    .where(eq(schema.usageCounters.teamId, f.teamId));
  const [period] = await fixture.db
    .select()
    .from(schema.usagePeriods)
    .where(eq(schema.usagePeriods.teamId, f.teamId));
  expect(counter).toMatchObject({ day: utcDay(), accepted: 1 });
  expect(period?.accepted).toBe(1);
});
it("approval denies self/forged operator/null cap/unknown principal/stale epoch and suspended state", async () => {
  const f = await volumeFixture();
  await expect(f.decision({ operatorId: f.principal })).rejects.toThrow("volume_operator_required");
  await expect(f.decision({ operatorId: "forged-reviewer" })).rejects.toThrow(
    "volume_operator_required",
  );
  await expect(f.decision({ dailyCeiling: null })).rejects.toThrow(
    "volume_finite_ceiling_required",
  );
  const epoch = (await observeProductionVolume(fixture.db, f.teamId)).epoch;
  await fixture.db
    .update(schema.teams)
    .set({ suspendedAt: new Date() })
    .where(eq(schema.teams.id, f.teamId));
  await expect(f.decision({ expectedEpoch: epoch })).rejects.toThrow("volume_stale_epoch");
  await expect(f.decision()).rejects.toThrow("volume_current_safety_or_cap_required");
  await fixture.db
    .update(schema.teams)
    .set({ suspendedAt: null })
    .where(eq(schema.teams.id, f.teamId));
  await fixture.db.delete(schema.user).where(eq(schema.user.id, f.principal));
  await expect(f.decision()).rejects.toThrow("volume_verified_principal_required");
});
it("lower cap wins; upper cap, new hold, expired DNS revoke elevated eligibility", async () => {
  const f = await volumeFixture();
  await f.decision();
  await fixture.db
    .update(schema.teams)
    .set({ dailySendCeiling: 2000 })
    .where(eq(schema.teams.id, f.teamId));
  expect((await productionVolumeStatus(fixture.db, f.teamId)).ceiling).toBe(2000);
  await fixture.db
    .update(schema.teams)
    .set({ dailySendCeiling: 5000 })
    .where(eq(schema.teams.id, f.teamId));
  expect((await productionVolumeStatus(fixture.db, f.teamId)).ceiling).toBeNull();
  await fixture.db
    .update(schema.teams)
    .set({ dailySendCeiling: 4000, sendReviewAt: new Date(Date.now() + 1) })
    .where(eq(schema.teams.id, f.teamId));
  expect((await productionVolumeStatus(fixture.db, f.teamId)).ceiling).toBeNull();
  await fixture.db
    .update(schema.teams)
    .set({ sendReviewAt: null })
    .where(eq(schema.teams.id, f.teamId));
  await fixture.db
    .update(schema.domains)
    .set({ lastCheckedAt: new Date(Date.now() - 86400001) })
    .where(eq(schema.domains.id, f.domain.id));
  expect((await productionVolumeStatus(fixture.db, f.teamId)).ceiling).toBeNull();
});
it("benign single confirmed hard bounce retains volume; complaint and late old evidence fail closed", async () => {
  const f = await volumeFixture();
  await f.decision();
  const [email] = await fixture.db
    .insert(schema.emails)
    .values({
      teamId: f.teamId,
      from: f.from,
      to: ["typo@example.test"],
      subject: "History",
      sentAt: new Date(),
      sesMessageId: "fixture-volume-history",
    })
    .returning();
  if (!email) throw new Error("missing history");
  await fixture.db.insert(schema.emailEvents).values({
    emailId: email.id,
    type: "bounced",
    bounceType: "Permanent",
    occurredAt: new Date(),
    createdAt: new Date(),
    data: {},
  });
  expect((await productionVolumeStatus(fixture.db, f.teamId)).ceiling).toBe(4000);
  await fixture.db.insert(schema.emailEvents).values({
    emailId: email.id,
    type: "complained",
    occurredAt: new Date(Date.now() - 7 * 86400000),
    createdAt: new Date(),
    data: {},
  });
  expect((await productionVolumeStatus(fixture.db, f.teamId)).ceiling).toBeNull();
});

it("approved volume cannot overshoot the monthly last unit under concurrent acceptance", async () => {
  const f = await volumeFixture();
  await f.decision();
  if (!f.team.currentPeriodStart) throw new Error("missing financial period");
  await fixture.db
    .insert(schema.usagePeriods)
    .values({ teamId: f.teamId, periodStart: f.team.currentPeriodStart, accepted: 109999 });
  const results = await Promise.all([
    accept(f, "You requested a password reset."),
    accept(f, "You requested a password reset."),
  ]);
  expect(results.filter((v) => v.ok && !v.parked)).toHaveLength(1);
  expect(results.filter((v) => !v.ok && v.reason === "monthly_quota_exceeded")).toHaveLength(1);
  const [period] = await fixture.db
    .select()
    .from(schema.usagePeriods)
    .where(eq(schema.usagePeriods.teamId, f.teamId));
  expect(period?.accepted).toBe(110000);
});
it("real ingestion preserves benign bounce eligibility and permanently revokes late complaint", async () => {
  const f = await volumeFixture();
  await f.decision();
  const sesMessageId = `provider-${f.teamId}`;
  await fixture.db.insert(schema.emails).values({
    teamId: f.teamId,
    from: f.from,
    to: ["outcome@example.test"],
    subject: "Outcome",
    sentAt: new Date(),
    sesMessageId,
  });
  await processProviderEvent(
    fixture.db,
    {
      eventType: "Bounce",
      sesMessageId,
      occurredAt: new Date().toISOString(),
      data: {},
      bounce: { bounceType: "Permanent", recipients: ["outcome@example.test"] },
    },
    { snsMessageId: randomUUID() },
  );
  expect((await productionVolumeStatus(fixture.db, f.teamId)).ceiling).toBe(4000);
  await processProviderEvent(
    fixture.db,
    {
      eventType: "Complaint",
      sesMessageId,
      occurredAt: new Date(Date.now() - 3 * 86400000).toISOString(),
      data: {},
      complaint: { recipients: ["outcome@example.test"] },
    },
    { snsMessageId: randomUUID() },
  );
  expect((await productionVolumeStatus(fixture.db, f.teamId)).ceiling).toBeNull();
  const [email] = await fixture.db
    .select()
    .from(schema.emails)
    .where(eq(schema.emails.sesMessageId, sesMessageId));
  expect(email?.latestStatus).toBe("complained");
});

it("explicit young volume lifts only the unreviewed 200 recipient screen", async () => {
  const f = await volumeFixture();
  await fixture.db
    .update(schema.teams)
    .set({ sendReviewClearedAt: null })
    .where(eq(schema.teams.id, f.teamId));
  await f.decision();
  const { screenNewSender } = await import("@millionsend/core");
  expect(
    await screenNewSender(fixture.db, { teamId: f.teamId, from: f.from, recipients: 201 }),
  ).toBe(false);
});
