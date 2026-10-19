import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import { EnvKeyring, type Keyring } from "../../../packages/core/src/crypto/keyring.js";
import {
  createMailboxExternalAccount,
  openMailboxExternalAccount,
  replaceMailboxExternalSecret,
} from "../../../packages/core/src/mailbox-external-accounts.js";
import { MailboxExternalOAuthError } from "../../../packages/core/src/mailbox-external-oauth.js";
import {
  MailboxSendDeferredError,
  MailboxSendRejectedError,
} from "../../../packages/core/src/mailbox-transport.js";
import { mailboxOutbox } from "../../../packages/db/src/schema/mailbox-transport.js";
import { createMailboxExternalAwareSender } from "../../worker/src/mailbox-external-sender.js";

/**
 * Contas externas: what a send through the provider's SMTP does with each answer. Only a
 * real refusal at sign-in stops the account; a "try later" (4xx, even reported as EAUTH)
 * keeps it connected and the send waits; a refusal seen by a send of an older connection
 * never marks the connection the person just made.
 */
let client: PGlite, db: Db, keys: Keyring, teamId: string, mailboxId: string;
const base = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const ADDRESS = "ana@gmail.com";

beforeEach(async () => {
  client = new PGlite();
  for (const name of readdirSync(base)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await client.transaction(async (tx) => {
      for (const statement of readFileSync(base + name, "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => s.trim()))
        await tx.exec(statement);
    });
  const database = drizzle(client, { schema: { ...schema, mailboxOutbox } });
  db = database as unknown as Db;
  await migrate(database, { migrationsFolder: extension, migrationsTable: "__mailbox_migrations" });
  keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
  const [team] = await db
    .insert(schema.teams)
    .values({ name: "Free", slug: "sender-free" })
    .returning();
  teamId = team!.id;
  await db
    .insert(schema.user)
    .values({ id: "ana", name: "Ana", email: "ana@example.invalid", emailVerified: true });
  await db.insert(schema.teamMembers).values({ teamId, userId: "ana", role: "owner" });
  ({ mailboxId } = await createMailboxExternalAccount(
    db,
    keys,
    { teamId, userId: "ana" },
    {
      address: ADDRESS,
      label: "Gmail",
      servers: {
        provider: "gmail",
        imapHost: "imap.gmail.com",
        smtpHost: "smtp.gmail.com",
        smtpPort: 465,
        smtpSecurity: "tls",
        username: ADDRESS,
      },
      secret: "app-password",
    },
  ));
});

const account = async () =>
  (
    await db
      .select()
      .from(schema.mailboxExternalAccounts)
      .where(eq(schema.mailboxExternalAccounts.mailboxId, mailboxId))
  )[0]!;

/** What nodemailer throws for an SMTP answer (code + responseCode), or a message id. */
type Answer = { code?: string; responseCode?: number } | "accepted";

/** A sender whose SMTP answers `answer`, after running `during` (a reconnect, say). */
function senderAnswering(answer: Answer, during?: () => Promise<void>) {
  const sent: unknown[] = [];
  const sender = createMailboxExternalAwareSender(db, keys, null, undefined, {
    lookup: (async () => [{ address: "142.250.0.109", family: 4 }]) as never,
    createTransport: (() => ({
      async sendMail(message: unknown) {
        sent.push(message);
        await during?.();
        if (answer === "accepted") return { messageId: "<ok@gmail.com>" };
        throw Object.assign(new Error("smtp"), answer);
      },
      close() {},
    })) as never,
  });
  return { sender, sent };
}

const send = (sender: ReturnType<typeof senderAnswering>["sender"]) =>
  sender.send({
    idempotencyKey: "k1",
    outboxId: "00000000-0000-4000-8000-000000000001",
    attemptId: "00000000-0000-4000-8000-000000000002",
    teamId,
    mailboxId,
    from: ADDRESS,
    to: ["leo@shop.example"],
    cc: [],
    bcc: [],
    raw: Buffer.from(
      `From: ${ADDRESS}\r\nTo: leo@shop.example\r\nSubject: Oi\r\nMessage-ID: <x@gmail.com>\r\n\r\noi\r\n`,
    ),
  });

describe("Contas externas: the provider's SMTP answers", () => {
  it("sends through the provider when it accepts", async () => {
    const { sender, sent } = senderAnswering("accepted");
    await expect(send(sender)).resolves.toEqual({ messageId: "<ok@gmail.com>" });
    expect(sent).toHaveLength(1);
    expect(await account()).toMatchObject({ status: "active", lastError: null });
  });

  it("EAUTH with 454 (try later at sign-in) defers the send and keeps the account connected", async () => {
    const { sender } = senderAnswering({ code: "EAUTH", responseCode: 454 });
    await expect(send(sender)).rejects.toBeInstanceOf(MailboxSendDeferredError);
    expect(await account()).toMatchObject({
      status: "active",
      lastError: null,
      connectionGeneration: 1,
    });
  });

  it("a 4xx for the message defers it too", async () => {
    const { sender } = senderAnswering({ code: "EMESSAGE", responseCode: 451 });
    await expect(send(sender)).rejects.toBeInstanceOf(MailboxSendDeferredError);
    expect((await account()).status).toBe("active");
  });

  it("EAUTH with 535 is a real refusal: the account waits for a new password", async () => {
    const { sender } = senderAnswering({ code: "EAUTH", responseCode: 535 });
    await expect(send(sender)).rejects.toBeInstanceOf(MailboxSendRejectedError);
    expect(await account()).toMatchObject({ status: "auth_failed", lastError: "smtp_login" });
  });

  it("a 5xx for the message fails the send without touching the account", async () => {
    const { sender } = senderAnswering({ code: "EENVELOPE", responseCode: 550 });
    await expect(send(sender)).rejects.toBeInstanceOf(MailboxSendRejectedError);
    expect(await account()).toMatchObject({ status: "active", lastError: null });
  });

  it("a refusal on an old connection retries with the new one and leaves it untouched", async () => {
    let reconnectedIv: Uint8Array | null = null;
    const { sender } = senderAnswering({ code: "EAUTH", responseCode: 535 }, async () => {
      // The person pastes a new app password while this send is signing in.
      await replaceMailboxExternalSecret(
        db,
        keys,
        { teamId, userId: "ana" },
        { mailboxId, secret: "new-app-password" },
      );
      reconnectedIv = (await account()).secretIv;
    });
    await expect(send(sender)).rejects.toBeInstanceOf(MailboxSendDeferredError);
    const now = await account();
    expect(now).toMatchObject({ status: "active", lastError: null, connectionGeneration: 2 });
    expect(Buffer.from(now.secretIv).equals(Buffer.from(reconnectedIv!))).toBe(true);
    expect((await openMailboxExternalAccount(db, keys, mailboxId))!.secret).toBe(
      "new-app-password",
    );
  });

  it("a refused grant on an old connection also retries instead of marking the new one", async () => {
    const sender = createMailboxExternalAwareSender(
      db,
      keys,
      null,
      async () => {
        await replaceMailboxExternalSecret(
          db,
          keys,
          { teamId, userId: "ana" },
          { mailboxId, secret: "new-app-password" },
        );
        throw new MailboxExternalOAuthError("invalid_grant");
      },
      { lookup: (async () => [{ address: "142.250.0.109", family: 4 }]) as never },
    );
    await expect(send(sender)).rejects.toBeInstanceOf(MailboxSendDeferredError);
    expect(await account()).toMatchObject({
      status: "active",
      lastError: null,
      connectionGeneration: 2,
    });
  });

  it("a refused grant on the current connection stops the account", async () => {
    const sender = createMailboxExternalAwareSender(
      db,
      keys,
      null,
      async () => {
        throw new MailboxExternalOAuthError("invalid_grant");
      },
      { lookup: (async () => [{ address: "142.250.0.109", family: 4 }]) as never },
    );
    await expect(send(sender)).rejects.toBeInstanceOf(MailboxSendRejectedError);
    expect(await account()).toMatchObject({ status: "auth_failed", lastError: "oauth_refused" });
  });

  it("a missing OAuth setting defers the send and keeps the account connected", async () => {
    const sender = createMailboxExternalAwareSender(
      db,
      keys,
      null,
      async () => {
        throw new MailboxExternalOAuthError("unconfigured");
      },
      { lookup: (async () => [{ address: "142.250.0.109", family: 4 }]) as never },
    );
    await expect(send(sender)).rejects.toBeInstanceOf(MailboxSendDeferredError);
    expect(await account()).toMatchObject({ status: "active", lastError: null });
  });
});
