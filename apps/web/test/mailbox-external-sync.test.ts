import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { simpleParser } from "mailparser";
import { beforeEach, describe, expect, it } from "vitest";
import { EnvKeyring, type Keyring } from "../../../packages/core/src/crypto/keyring.js";
import { createMailboxExternalAccount } from "../../../packages/core/src/mailbox-external-accounts.js";
import {
  ImapError,
  type ImapImportSession,
  type ImapMessage,
} from "../../../packages/core/src/mailbox-imap-client.js";
import type { MailboxTransportMimeAdapter } from "../../../packages/core/src/mailbox-transport.js";
import { mailboxOutbox } from "../../../packages/db/src/schema/mailbox-transport.js";
import { syncMailboxExternalAccount } from "../../worker/src/handlers/mailbox-external-sync.js";

let client: PGlite, db: Db, keys: Keyring, teamId: string, mailboxId: string;
const base = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const mime: MailboxTransportMimeAdapter = {
  async parse(raw) {
    const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
    return {
      from: parsed.from?.value[0]?.address ?? "",
      to: [],
      attachmentBytes: parsed.attachments.map((a) => a.content.length),
    };
  },
};
const msg = (uid: number, seen = false): ImapMessage => ({
  uid,
  flags: seen ? ["\\Seen"] : [],
  internalDate: new Date(Date.now() - 60_000),
  raw: Buffer.from(
    `From: sender${uid}@shop.example\r\nTo: ana@gmail.com\r\nSubject: Message ${uid}\r\nMessage-ID: <m${uid}@shop.example>\r\nContent-Type: text/plain\r\n\r\nbody ${uid}\r\n`,
  ),
});

/** A provider INBOX: messages by UID under one UIDVALIDITY, read-only like EXAMINE. */
function fakeImap(state: { uidValidity: number; messages: ImapMessage[]; calls: string[] }) {
  return async (): Promise<ImapImportSession> =>
    ({
      async examine(name: string) {
        state.calls.push(`examine ${name}`);
        return { exists: state.messages.length, uidValidity: state.uidValidity, uidNext: null };
      },
      async uidSearchSince() {
        state.calls.push("since");
        return state.messages.map((m) => m.uid);
      },
      async uidSearchAfter(after: number) {
        state.calls.push(`after ${after}`);
        return state.messages.map((m) => m.uid).filter((uid) => uid > after);
      },
      async uidFetchSizes(uids: readonly number[]) {
        return new Map(uids.map((uid) => [uid, 200]));
      },
      async uidFetchMessages(uids: readonly number[]) {
        return state.messages.filter((m) => uids.includes(m.uid));
      },
      async logout() {},
      async list() {
        return [];
      },
      async fetchHeaders() {
        return [];
      },
    }) as unknown as ImapImportSession;
}

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
    .values({ name: "Free", slug: "sync-free" })
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
      address: "ana@gmail.com",
      label: "Gmail",
      servers: {
        provider: "gmail",
        imapHost: "imap.gmail.com",
        smtpHost: "smtp.gmail.com",
        smtpPort: 465,
        smtpSecurity: "tls",
        username: "ana@gmail.com",
      },
      secret: "app-password",
    },
  ));
});

const items = () =>
  db.select().from(schema.mailboxItems).where(eq(schema.mailboxItems.mailboxId, mailboxId));
const account = async () =>
  (
    await db
      .select()
      .from(schema.mailboxExternalAccounts)
      .where(eq(schema.mailboxExternalAccounts.mailboxId, mailboxId))
  )[0]!;

describe("Contas externas: syncing the provider's INBOX", () => {
  it("takes the recent mail first, then only what is new, never twice", async () => {
    const state = { uidValidity: 9, messages: [msg(1, true), msg(2)], calls: [] as string[] };
    expect(
      await syncMailboxExternalAccount(db, keys, mailboxId, { mime, open: fakeImap(state) }),
    ).toBe("done");
    expect((await items()).length).toBe(2);
    expect((await account()).syncState).toEqual({ inbox: { uidValidity: 9, lastUid: 2 } });
    expect(state.calls).toEqual(["examine INBOX", "since"]);
    const read = (await items()).find((item) => item.seenAt !== null);
    expect(read).toBeTruthy();

    state.messages.push(msg(3));
    state.calls.length = 0;
    await syncMailboxExternalAccount(db, keys, mailboxId, { mime, open: fakeImap(state) });
    expect(state.calls).toEqual(["examine INBOX", "after 2"]);
    expect((await items()).length).toBe(3);

    // The provider renumbers the folder: the same messages (Message-ID) are not stored again.
    state.uidValidity = 10;
    state.messages = [msg(1), msg(2), msg(3)].map((m, index) => ({ ...m, uid: 100 + index }));
    state.calls.length = 0;
    await syncMailboxExternalAccount(db, keys, mailboxId, { mime, open: fakeImap(state) });
    expect(state.calls).toEqual(["examine INBOX", "since"]);
    expect((await items()).length).toBe(3);
    expect((await account()).syncState).toEqual({ inbox: { uidValidity: 10, lastUid: 102 } });
  });

  it("stops on a refused password until the person replaces it", async () => {
    const result = await syncMailboxExternalAccount(db, keys, mailboxId, {
      mime,
      open: async () => {
        throw new ImapError("login");
      },
    });
    expect(result).toBe("auth_failed");
    expect(await account()).toMatchObject({ status: "auth_failed", lastError: "imap_login" });
  });
});
