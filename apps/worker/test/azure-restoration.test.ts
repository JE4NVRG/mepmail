import { randomBytes, randomUUID } from "node:crypto";
import {
  deriveUnsubscribeKey,
  EnvKeyring,
  encryptEmailBody,
  hashRecipient,
  parseSendingProviderPolicy,
  SYSTEM_MAIL_TAG,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { simpleParser } from "mailparser";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  recordAzureRecipientOptout,
  verifyAzureRecipientOptoutToken,
} from "../../../packages/core/src/azure-recipient-optout.js";
import * as azureClaims from "../../../packages/core/src/azure-send-claim.js";
import { type SendDeps, sendEmail } from "../src/handlers/send-email.js";
import { createCustomerSmtpRelay } from "../src/handlers/smtp-fallback.js";

let fixture: Awaited<ReturnType<typeof createTestDb>>;
let team: string;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const cutover = new Date(Date.now() - 60_000);
beforeAll(async () => {
  fixture = await createTestDb();
  team = await createTeam(fixture.db, "azure-worker");
});
afterAll(async () => fixture?.close());
async function seed(patch: Partial<typeof schema.emails.$inferInsert> = {}) {
  const id = randomUUID();
  const body = await encryptEmailBody(
    { html: "<p>Your verification code is 123456</p>", text: "Your verification code is 123456" },
    keyring,
    { teamId: team, rowId: id },
  );
  const [email] = await fixture.db
    .insert(schema.emails)
    .values({
      id,
      teamId: team,
      from: "Our Product <DoNotReply@example.invalid>",
      to: ["own@example.invalid"],
      subject: "Your verification code",
      latestStatus: "queued",
      bodyCiphertext: body.ciphertext,
      bodyIv: body.iv,
      bodyWrappedDek: body.wrappedDek,
      bodyKeyVersion: body.keyVersion,
      ...patch,
    })
    .returning();
  if (!email) throw new Error("seed failed");
  return email;
}
function deps(response: string) {
  const ses = vi.fn(async () => ({ messageId: "must-not-send" }));
  const smtp = vi.fn(async (_mail: { envelope: { from: string; to: string[] }; raw: Buffer }) => ({
    messageId: "<not-acs@example.invalid>",
    response,
  }));
  const value: SendDeps = {
    keyring,
    unsubscribe: {
      secretKey: deriveUnsubscribeKey(Buffer.alloc(32, 73)),
      baseUrl: "https://optout.example.invalid",
    },
    ses: { sendRaw: ses },
    fallback: { sendRaw: ses },
    relay: {
      name: "azure",
      sender: createCustomerSmtpRelay("smtp://synthetic:fixture@smtp.example.invalid", "azure", {
        sendMail: smtp,
      }),
    },
    sendingProviderPolicy: parseSendingProviderPolicy(
      JSON.stringify({
        version: 1,
        allowedTeamIds: [team],
        defaults: { transactional: "disabled", campaign: "disabled" },
        teams: { [team]: { transactional: "azure_smtp", campaign: "disabled" } },
        restoration: {
          teams: {
            [team]: { notBefore: cutover.toISOString(), senders: ["donotreply@example.invalid"] },
          },
        },
      }),
    ),
  };
  return { value, ses, smtp };
}
it("250 without ACS UUID retains claim and sealed payload; retry skips with no alternate send", async () => {
  const email = await seed();
  const d = deps("250 2.0.0 accepted");
  await expect(sendEmail(fixture.db, d.value, { emailId: email.id })).rejects.toThrow(
    "azure_smtp_accepted_without_receipt",
  );
  const [stored] = await fixture.db
    .select()
    .from(schema.emails)
    .where(eq(schema.emails.id, email.id));
  expect(stored?.sentAt).toBeInstanceOf(Date);
  expect(stored?.sesMessageId).toBeNull();
  expect(stored?.bodyCiphertext).toEqual(email.bodyCiphertext);
  expect(await sendEmail(fixture.db, d.value, { emailId: email.id })).toBe("skipped");
  expect(d.smtp).toHaveBeenCalledTimes(1);
  expect(d.ses).not.toHaveBeenCalled();
});
it("trusted receipt preserves original From and MIME and never invokes SES", async () => {
  const email = await seed();
  const receipt = randomUUID();
  const d = deps(`250 2.0.0 OK ${receipt}`);
  expect(await sendEmail(fixture.db, d.value, { emailId: email.id })).toBe("sent");
  const [stored] = await fixture.db
    .select()
    .from(schema.emails)
    .where(eq(schema.emails.id, email.id));
  expect(stored?.sesMessageId).toBe(`smtp-relay:azure:${receipt}`);
  expect(d.smtp.mock.calls[0]?.[0].envelope.from).toBe("DoNotReply@example.invalid");
  expect(d.smtp.mock.calls[0]?.[0].raw.toString()).toContain("DoNotReply@example.invalid");
  expect(d.ses).not.toHaveBeenCalled();
  const parsed = await simpleParser(d.smtp.mock.calls[0]![0].raw);
  const link = (parsed.text ?? "")
    .split(/\s+/)
    .find((s) => s.startsWith("https://optout.example.invalid/unsubscribe/recipient/"));
  expect(link).toBeDefined();
  const token = new URL(link!).pathname.split("/").at(-1)!;
  expect(verifyAzureRecipientOptoutToken(token, d.value.unsubscribe!.secretKey)).toEqual({
    teamId: team,
    recipientHash: hashRecipient(email.to[0]!),
  });
  expect(parsed.text).toContain("Stop all messages from this team");
  expect(await fixture.db.select().from(schema.contacts)).toHaveLength(0);
});
it("system tag/null domain cannot admit another From or old backlog", async () => {
  for (const patch of [
    { from: "attacker@example.invalid", tags: { [SYSTEM_MAIL_TAG]: "verify" } },
    { createdAt: new Date(cutover.getTime() - 1) },
  ]) {
    const email = await seed(patch);
    const d = deps(`250 ${randomUUID()}`);
    expect(await sendEmail(fixture.db, d.value, { emailId: email.id })).toBe("parked");
    expect(d.smtp).not.toHaveBeenCalled();
    expect(d.ses).not.toHaveBeenCalled();
    const [stored] = await fixture.db
      .select()
      .from(schema.emails)
      .where(eq(schema.emails.id, email.id));
    expect(stored?.sentAt).toBeNull();
    expect(stored?.latestStatus).toBe("queued");
  }
});

it("ACS API opt-out before claim parks transactional without sending or audience enrollment", async () => {
  const address = `before-${randomUUID()}@example.invalid`;
  const email = await seed({ to: [address] });
  const d = deps(`250 ${randomUUID()}`);
  await recordAzureRecipientOptout(fixture.db, {
    teamId: team,
    recipientHash: hashRecipient(address),
  });
  expect(await sendEmail(fixture.db, d.value, { emailId: email.id })).toBe("parked");
  const [row] = await fixture.db.select().from(schema.emails).where(eq(schema.emails.id, email.id));
  expect(row?.sentAt).toBeNull();
  expect(d.smtp).not.toHaveBeenCalled();
  expect(await fixture.db.select().from(schema.contacts)).toHaveLength(0);
});
it("ACS API post-budget opt-out preserves claim and prevents SMTP/retry", async () => {
  const address = `after-${randomUUID()}@example.invalid`;
  const email = await seed({ to: [address] });
  const d = deps(`250 ${randomUUID()}`);
  const original = azureClaims.claimAzureSend;
  const spy = vi.spyOn(azureClaims, "claimAzureSend").mockImplementation(async (...args) => {
    const result = await original(...args);
    if (result === "claimed")
      await recordAzureRecipientOptout(fixture.db, {
        teamId: team,
        recipientHash: hashRecipient(address),
      });
    return result;
  });
  try {
    expect(await sendEmail(fixture.db, d.value, { emailId: email.id })).toBe("parked");
    const [row] = await fixture.db
      .select()
      .from(schema.emails)
      .where(eq(schema.emails.id, email.id));
    expect(row?.sentAt).toBeInstanceOf(Date);
    expect(row?.sesMessageId).toBeNull();
    expect(d.smtp).not.toHaveBeenCalled();
    expect(await sendEmail(fixture.db, d.value, { emailId: email.id })).toBe("skipped");
    const audit = await fixture.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.teamId, team));
    expect(
      audit.some(
        (a) => a.action === "sending.azure_optout_held_after_claim" && a.data?.emailId === email.id,
      ),
    ).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
it("ACS API no opt-out configuration keeps the sealed payload unclaimed", async () => {
  const email = await seed();
  const d = deps(`250 ${randomUUID()}`);
  delete d.value.unsubscribe;
  expect(await sendEmail(fixture.db, d.value, { emailId: email.id })).toBe("parked");
  const [row] = await fixture.db.select().from(schema.emails).where(eq(schema.emails.id, email.id));
  expect(row?.sentAt).toBeNull();
  expect(row?.bodyCiphertext).toEqual(email.bodyCiphertext);
  expect(d.smtp).not.toHaveBeenCalled();
});
it("ACS API shared multi-recipient MIME remains retained rather than leaking recipient capabilities", async () => {
  const email = await seed({ to: ["one@example.invalid", "two@example.invalid"] });
  const d = deps(`250 ${randomUUID()}`);
  expect(await sendEmail(fixture.db, d.value, { emailId: email.id })).toBe("parked");
  expect(d.smtp).not.toHaveBeenCalled();
  const [row] = await fixture.db.select().from(schema.emails).where(eq(schema.emails.id, email.id));
  expect(row?.sentAt).toBeNull();
  expect(row?.bodyCiphertext).toEqual(email.bodyCiphertext);
});
