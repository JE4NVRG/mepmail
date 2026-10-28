import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { acceptEmail, EnvKeyring, MailboxSendDeferredError } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  campaignMessage,
  reviewCampaignConsent,
  submitCampaignConsent,
} from "../../../packages/core/src/campaign-consent.js";
import {
  applySenderProbationQuota,
  probationCeiling,
} from "../../../packages/core/src/sender-probation.js";
import { sendEmail } from "../src/handlers/send-email.js";
import { createMailboxContentPolicySender, createMailboxSesSender } from "../src/mailbox-sender.js";

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
      { keyring, isCloud: true, ses: { sendRaw } },
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
      { keyring, isCloud: true, ses: { sendRaw } },
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
  expect(probationCeiling({ ...input, ageDays: 90, operatorCeiling: null })).toBe(25);
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
  const deps = { keyring, isCloud: true, ses: { sendRaw } };
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
      { keyring, isCloud: true, ses: { sendRaw } },
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
