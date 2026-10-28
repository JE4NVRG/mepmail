import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EnvKeyring, encryptEmailBody, MailboxSendDeferredError } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { sendEmail } from "../src/handlers/send-email.js";
import { createMailboxContentPolicySender, createMailboxSesSender } from "../src/mailbox-sender.js";

let fixture: Awaited<ReturnType<typeof createTestDb>>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const phishing =
  '<p>Spotify: verify your account and update payment</p><a href="https://outside.example/pay?token=PRIVATE">Continue</a>';
beforeAll(async () => {
  fixture = await createTestDb();
  const extension = fileURLToPath(
    new URL("../../../packages/db/mailbox-drizzle/", import.meta.url),
  );
  for (const file of readdirSync(extension)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const client = (
      fixture.db as unknown as {
        $client: {
          transaction: (
            fn: (tx: { exec: (sql: string) => Promise<unknown> }) => Promise<void>,
          ) => Promise<void>;
        };
      }
    ).$client;
    await client.transaction(async (tx) => {
      await tx.exec(readFileSync(extension + file, "utf8"));
    });
  }
});
afterAll(async () => {
  await fixture?.close();
});
async function team(slug: string) {
  const { db } = fixture;
  const teamId = await createTeam(db, slug);
  await db
    .update(schema.teams)
    .set({ createdAt: new Date("2025-01-01"), sendReviewClearedAt: new Date("2026-01-01") })
    .where(eq(schema.teams.id, teamId));
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: `${slug}.example`,
      region: "us-east-1",
      status: "verified",
      sesConfigurationSet: "campaigns",
    })
    .returning();
  return { teamId, domain: domain! };
}
it("worker holds original HTML before SES/SMTP, claim or body purge, including forged system tags", async () => {
  const { db } = fixture;
  const { teamId, domain } = await team("worker-policy");
  const body = await encryptEmailBody({ html: phishing, text: null }, keyring);
  const [email] = await db
    .insert(schema.emails)
    .values({
      teamId,
      domainId: domain.id,
      from: "News <news@worker-policy.example>",
      to: ["r@example.com"],
      subject: "Notice",
      tags: { system_mail: "password_reset" },
      bodyCiphertext: body.ciphertext,
      bodyIv: body.iv,
      bodyWrappedDek: body.wrappedDek,
      bodyKeyVersion: body.keyVersion,
    })
    .returning();
  const sendRaw = vi.fn();
  expect(
    await sendEmail(db, { keyring, isCloud: true, ses: { sendRaw } }, { emailId: email!.id }),
  ).toBe("parked");
  expect(sendRaw).not.toHaveBeenCalled();
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, email!.id));
  expect(row?.sentAt).toBeNull();
  expect(Buffer.from(row!.bodyCiphertext!)).toEqual(body.ciphertext);
  expect(row?.sesMessageId).toBeNull();
});
function mail(teamId: string, mailboxId: string = randomUUID(), html = phishing) {
  return {
    teamId,
    mailboxId,
    idempotencyKey: randomUUID(),
    outboxId: randomUUID(),
    attemptId: randomUUID(),
    from: "news@mail-policy.example",
    to: ["r@example.com"],
    cc: [],
    bcc: [],
    raw: Buffer.from(
      `From: News <news@mail-policy.example>\r\nTo: r@example.com\r\nSubject: Notice\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`,
    ),
  };
}
it("outer Correio router blocks external SMTP before invoking any downstream transport", async () => {
  const { db } = fixture;
  const { teamId } = await team("outer-policy");
  const send = vi.fn();
  await expect(
    createMailboxContentPolicySender(db, { send }, true).send(mail(teamId)),
  ).rejects.toBeInstanceOf(MailboxSendDeferredError);
  expect(send).not.toHaveBeenCalled();
});
it("direct Correio SES sender blocks forged content before constructing a client", async () => {
  const { db } = fixture;
  const { teamId, domain } = await team("mail-policy");
  const [box] = await db
    .insert(schema.mailboxes)
    .values({
      teamId,
      domainId: domain.id,
      address: "news@mail-policy.example",
      label: "News",
      kind: "person",
    })
    .returning();
  const clientFactory = vi.fn();
  const sender = createMailboxSesSender(db, {
    isCloud: true,
    configurationSets: { "us-east-1": "private_mail" },
    clientFactory,
  });
  await expect(sender.send(mail(teamId, box!.id))).rejects.toBeInstanceOf(MailboxSendDeferredError);
  expect(clientFactory).not.toHaveBeenCalled();
});
it("policy failures defer Correio without dispatch and self-host stays compatible", async () => {
  const { db } = fixture;
  const send = vi.fn().mockResolvedValue({ messageId: "fixture" });
  const input = mail(randomUUID(), randomUUID(), "x".repeat(2_000_001));
  await expect(
    createMailboxContentPolicySender(db, { send }, true).send(input),
  ).rejects.toBeInstanceOf(MailboxSendDeferredError);
  expect(send).not.toHaveBeenCalled();
  await expect(createMailboxContentPolicySender(db, { send }, false).send(input)).resolves.toEqual({
    messageId: "fixture",
  });
  expect(send).toHaveBeenCalledTimes(1);
});
it("operator provider kill switch and unknown adapter park before dispatch without a claim", async () => {
  const { db } = fixture;
  const { teamId, domain } = await team("routing-policy");
  const body = await encryptEmailBody(
    { html: "<p>Your receipt</p>", text: "Your receipt" },
    keyring,
  );
  for (const sendingProviderPolicy of [
    { version: 1 as const, paused: true },
    { version: 1 as const, defaults: { transactional: "unconfigured" } },
    { version: 1 as const, defaults: { transactional: "customer_smtp" } },
  ]) {
    const [email] = await db
      .insert(schema.emails)
      .values({
        teamId,
        domainId: domain.id,
        from: "News <news@routing-policy.example>",
        to: ["r@example.com"],
        subject: "Receipt",
        bodyCiphertext: body.ciphertext,
        bodyIv: body.iv,
        bodyWrappedDek: body.wrappedDek,
        bodyKeyVersion: body.keyVersion,
      })
      .returning();
    const sendRaw = vi.fn();
    expect(
      await sendEmail(
        db,
        { keyring, isCloud: true, ses: { sendRaw }, sendingProviderPolicy },
        { emailId: email!.id },
      ),
    ).toBe("parked");
    expect(sendRaw).not.toHaveBeenCalled();
    const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, email!.id));
    expect(row?.sentAt).toBeNull();
  }
});

it("legitimate account mail traverses Correio policy without leaking its token", async () => {
  const { db } = fixture;
  const send = vi.fn().mockResolvedValue({ messageId: "fixture-own-mail" });
  const input = mail(
    (await team("legitimate-policy")).teamId,
    randomUUID(),
    '<p>MepMail password reset: reset your password</p><a href="https://mepmail.app/reset?token=PRIVATE">Reset</a>',
  );
  await expect(createMailboxContentPolicySender(db, { send }, true).send(input)).resolves.toEqual({
    messageId: "fixture-own-mail",
  });
});
