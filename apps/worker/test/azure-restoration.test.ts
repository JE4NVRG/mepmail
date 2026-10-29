import { randomBytes, randomUUID } from "node:crypto";
import {
  EnvKeyring,
  encryptEmailBody,
  parseSendingProviderPolicy,
  SYSTEM_MAIL_TAG,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
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
