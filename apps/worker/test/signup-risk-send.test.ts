import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  EnvKeyring,
  encryptEmailBody,
  type Keyring,
  MailboxSendDeferredError,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { type SendDeps, type SesSender, sendEmail } from "../src/handlers/send-email.js";
import { createMailboxSesSender } from "../src/mailbox-sender.js";

let db: Db;
let close: () => Promise<void>;
const signals = {
  domain: "worker-signup.example.test",
  disposable: false,
  mx: "present" as const,
  domainAgeDays: 500,
  catchAll: "unknown" as const,
  randomLocal: false,
  ipKey: null,
  asn: null,
  signupsIp1h: 0,
  signupsDomain24h: 0,
  signupsAsn1h: 0,
};

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const extension = fileURLToPath(
    new URL("../../../packages/db/mailbox-drizzle/", import.meta.url),
  );
  for (const file of readdirSync(extension)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    await db.transaction(async (tx) => {
      for (const statement of readFileSync(extension + file, "utf8").split(
        "--> statement-breakpoint",
      ))
        if (statement.trim()) await tx.execute(sql.raw(statement));
    });
  }
});
afterAll(() => close());

async function fixture(level: "sandbox" | "good" | "hold" | "legacy" = "sandbox") {
  const userId = randomUUID();
  const principal = `${userId}@example.test`;
  const teamId = await createTeam(db, `worker-signup-${userId}`);
  await db.insert(schema.user).values({
    id: userId,
    name: "Synthetic worker principal",
    email: principal,
    emailVerified: true,
  });
  if (level !== "legacy")
    await db
      .insert(schema.teamSignupRisk)
      .values({ teamId, principalUserId: userId, level, signals });
  const [domain] = await db
    .insert(schema.domains)
    .values({
      teamId,
      name: `${userId}.example.test`,
      status: "verified",
      verifiedAt: new Date(),
      region: "us-east-1",
      sesConfigurationSet: "synthetic-config",
    })
    .returning({ id: schema.domains.id, name: schema.domains.name });
  if (!domain) throw new Error("synthetic worker domain missing");
  const real = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  const unwrap = vi.fn((wrapped: Buffer, version: number) => real.unwrapDek(wrapped, version));
  const keyring: Keyring = { wrapDek: (dek) => real.wrapDek(dek), unwrapDek: unwrap };
  const sendRaw = vi.fn(async (_input: Parameters<SesSender["sendRaw"]>[0]) => ({
    messageId: `synthetic-${randomUUID()}`,
  }));
  const deps: SendDeps = { keyring, ses: { sendRaw }, isCloud: true };
  const insert = async (
    to = ["external@example.test"],
    overrides: Partial<typeof schema.emails.$inferInsert> = {},
  ) => {
    const body = await encryptEmailBody({ text: "Synthetic body only", html: null }, real);
    const [row] = await db
      .insert(schema.emails)
      .values({
        teamId,
        domainId: domain.id,
        from: `Fixture <sender@${domain.name}>`,
        to,
        subject: "Synthetic worker send",
        latestStatus: "queued",
        bodyCiphertext: body.ciphertext,
        bodyIv: body.iv,
        bodyWrappedDek: body.wrappedDek,
        bodyKeyVersion: body.keyVersion,
        ...overrides,
      })
      .returning({ id: schema.emails.id });
    if (!row) throw new Error("synthetic worker email missing");
    return row.id;
  };
  return { teamId, principal, domain, deps, unwrap, sendRaw, insert };
}

async function expectParked(emailId: string) {
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
  expect(row).toMatchObject({ latestStatus: "queued_quota", sentAt: null, sesMessageId: null });
}

it.each(["sandbox", "hold"] as const)(
  "a queued external email under %s parks before decryption or any provider",
  async (level) => {
    const f = await fixture(level);
    const emailId = await f.insert();
    expect(await sendEmail(db, f.deps, { emailId })).toBe("parked");
    expect(f.unwrap).not.toHaveBeenCalled();
    expect(f.sendRaw).not.toHaveBeenCalled();
    await expectParked(emailId);
    // A duplicate queue delivery cannot turn a parked row into a send.
    expect(await sendEmail(db, f.deps, { emailId })).toBe("skipped");
    expect(f.sendRaw).not.toHaveBeenCalled();
  },
);

it("a verified sandbox self-test reaches the synthetic SES provider once", async () => {
  const f = await fixture();
  const emailId = await f.insert([f.principal]);
  expect(await sendEmail(db, f.deps, { emailId })).toBe("sent");
  expect(f.unwrap).toHaveBeenCalledOnce();
  expect(f.sendRaw).toHaveBeenCalledOnce();
  expect(f.sendRaw.mock.calls[0]?.[0].to).toEqual([f.principal]);
});

it("a hold introduced during throttle parks on the ordinary SES path", async () => {
  const f = await fixture("good");
  const emailId = await f.insert();
  const deps: SendDeps = {
    ...f.deps,
    throttle: async () => {
      await db
        .update(schema.teams)
        .set({ sendReviewAt: new Date(), sendReviewReason: "content" })
        .where(eq(schema.teams.id, f.teamId));
    },
  };
  expect(await sendEmail(db, deps, { emailId })).toBe("parked");
  expect(f.unwrap).toHaveBeenCalledOnce();
  expect(f.sendRaw).not.toHaveBeenCalled();
  await expectParked(emailId);
});

it("a profile switching from good to sandbox during throttle blocks the final SES claim", async () => {
  const f = await fixture("good");
  const emailId = await f.insert();
  const deps: SendDeps = {
    ...f.deps,
    throttle: async () => {
      await db
        .update(schema.teamSignupRisk)
        .set({ level: "sandbox" })
        .where(eq(schema.teamSignupRisk.teamId, f.teamId));
    },
  };
  expect(await sendEmail(db, deps, { emailId })).toBe("parked");
  expect(f.unwrap).toHaveBeenCalledOnce();
  expect(f.sendRaw).not.toHaveBeenCalled();
  await expectParked(emailId);
});

it("an already claimed legacy row is never resent", async () => {
  const f = await fixture("legacy");
  const claimedAt = new Date("2026-10-01T00:00:00Z");
  const emailId = await f.insert(undefined, { sentAt: claimedAt });
  expect(await sendEmail(db, f.deps, { emailId })).toBe("skipped");
  expect(f.sendRaw).not.toHaveBeenCalled();
  const [row] = await db.select().from(schema.emails).where(eq(schema.emails.id, emailId));
  expect(row?.sentAt).toEqual(claimedAt);
});

it("an untouched legacy team retains its normal worker send path", async () => {
  const f = await fixture("legacy");
  const emailId = await f.insert();
  expect(await sendEmail(db, f.deps, { emailId })).toBe("sent");
  expect(f.sendRaw).toHaveBeenCalledOnce();
});

it.each([false, undefined])(
  "self-host sends with isCloud=%s keep the API's unrestricted path despite a cloud risk row",
  async (isCloud) => {
    const f = await fixture("hold");
    const emailId = await f.insert();
    const { isCloud: _cloud, ...deps } = f.deps;
    const selfHost: SendDeps = isCloud === undefined ? deps : { ...deps, isCloud };
    expect(await sendEmail(db, selfHost, { emailId })).toBe("sent");
    expect(f.sendRaw).toHaveBeenCalledOnce();
  },
);

it("rejects a cleared risk record without a non-null review reason", async () => {
  const f = await fixture();
  await expect(
    db
      .update(schema.teamSignupRisk)
      .set({ clearedAt: new Date(), clearedBy: "synthetic-operator", clearedReason: null })
      .where(eq(schema.teamSignupRisk.teamId, f.teamId)),
  ).rejects.toThrow();
  const [risk] = await db
    .select()
    .from(schema.teamSignupRisk)
    .where(eq(schema.teamSignupRisk.teamId, f.teamId));
  expect(risk).toMatchObject({ clearedAt: null, clearedBy: null, clearedReason: null });
});

it.each(["hold", "sandbox"] as const)(
  "Correio refuses SES when %s is introduced during tenant association",
  async (restriction) => {
    const f = await fixture("good");
    const from = `sender@${f.domain.name}`;
    const [box] = await db
      .insert(schema.mailboxes)
      .values({
        teamId: f.teamId,
        domainId: f.domain.id,
        address: from,
        label: "Synthetic risk mailbox",
        kind: "person",
      })
      .returning({ id: schema.mailboxes.id });
    if (!box) throw new Error("synthetic risk mailbox missing");
    await db
      .update(schema.teams)
      .set({ sesTenantName: "signup-risk-fixture" })
      .where(eq(schema.teams.id, f.teamId));
    await db
      .update(schema.domains)
      .set({ sesTenantAssociatedAt: new Date(), sesTenantConfigSet: "synthetic-config" })
      .where(eq(schema.domains.id, f.domain.id));
    const commands: string[] = [];
    const send = vi.fn(
      async (command: {
        constructor: { name: string };
      }): Promise<{
        MessageId?: string;
        TenantArn?: string;
      }> => {
        const name = command.constructor.name;
        commands.push(name);
        if (name === "CreateTenantCommand")
          return { TenantArn: "arn:aws:ses:us-east-1:123456789012:tenant/signup-risk-fixture" };
        if (name === "CreateTenantResourceAssociationCommand") {
          if (restriction === "hold")
            await db
              .update(schema.teams)
              .set({ sendReviewAt: new Date(), sendReviewReason: "content" })
              .where(eq(schema.teams.id, f.teamId));
          else
            await db
              .update(schema.teamSignupRisk)
              .set({ level: "sandbox" })
              .where(eq(schema.teamSignupRisk.teamId, f.teamId));
          return {};
        }
        return { MessageId: "synthetic-must-not-send" };
      },
    );
    const sender = createMailboxSesSender(db, {
      configurationSets: { "us-east-1": "private_mail_fixture" },
      tenants: true,
      clientFactory: () => ({ send }),
    });
    await expect(
      sender.send({
        idempotencyKey: randomUUID(),
        outboxId: randomUUID(),
        attemptId: randomUUID(),
        teamId: f.teamId,
        mailboxId: box.id,
        from,
        to: ["external@example.test"],
        cc: [],
        bcc: [],
        raw: Buffer.from(
          `From: ${from}\r\nTo: external@example.test\r\nSubject: Synthetic only\r\n\r\nSynthetic body`,
        ),
      }),
    ).rejects.toBeInstanceOf(MailboxSendDeferredError);
    expect(commands).toContain("CreateTenantCommand");
    expect(commands).toContain("CreateTenantResourceAssociationCommand");
    expect(commands).not.toContain("SendEmailCommand");
  },
);
