import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { EnvKeyring } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMailboxAppPassword,
  deriveMailboxAppPasswordKey,
} from "../../../packages/core/src/mailbox-app-passwords.js";
import { importMailboxMime } from "../../../packages/core/src/mailbox-private-store.js";
import { createMailboxRegistry } from "../../../packages/core/src/mailbox-registry.js";
import { createMailboxImapServer } from "../src/imap/server.js";
import { TestImapClient } from "./imap-client.js";

let db: Db;
let closeDb: () => Promise<void>;
let teamId: string;
let mailboxId: string;
let password: string;
let port: number;
let server: ReturnType<typeof createMailboxImapServer>;
const arrivals = new Set<(mailboxId: string) => void>();
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const passwordKey = deriveMailboxAppPasswordKey(randomBytes(32));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const owner = () => ({ teamId, userId: "jean" });
let minute = 0;
const mime = (name: string, body = `Body of ${name}`) =>
  Buffer.from(
    [
      `From: "${name}" <${name}@sender.test>`,
      "To: jean@box.test",
      `Subject: Assunto ${name}`,
      `Message-ID: <${name}@sender.test>`,
      "Date: Thu, 01 Oct 2026 12:00:00 +0000",
      "",
      body,
    ].join("\r\n"),
  );
const receive = (name: string, body?: string) =>
  importMailboxMime(db, keyring, owner(), {
    mailboxId,
    sourceId: `fixture:${name}`,
    raw: mime(name, body),
    history: {
      kind: "inbox",
      receivedAt: new Date(Date.UTC(2026, 9, 1, 12, minute++)),
      seen: false,
      archived: false,
    },
  });
const signedIn = async () => {
  const client = await TestImapClient.open(port);
  const login = await client.send(`LOGIN jean@box.test "${password}"`);
  expect(login.status).toMatch(/OK/);
  return client;
};

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  for (const file of readdirSync(extension)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + file, "utf8").split(
      "--> statement-breakpoint",
    ))
      if (statement.trim()) await db.execute(sql.raw(statement));
  teamId = await createTeam(db, "imap-team");
  await db.insert(schema.user).values({ id: "jean", name: "Jean", email: "jean@example.test" });
  await db.insert(schema.teamMembers).values({ teamId, userId: "jean", role: "owner" });
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "box.test", region: "us-east-1", status: "verified" })
    .returning();
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "active",
    seats: 3,
    storageBytesPerMailbox: 50 * 1024 * 1024,
    includedOutboundPerMailbox: 100,
    periodStart: new Date(Date.now() - 86400000),
    periodEnd: new Date(Date.now() + 29 * 86400000),
  });
  mailboxId = (
    await createMailboxRegistry(db, owner(), {
      domainId: domain!.id,
      localPart: "jean",
      label: "Jean",
      kind: "person",
      ownerUserId: "jean",
    })
  ).id;
  password = (
    await createMailboxAppPassword(db, passwordKey, owner(), { mailboxId, label: "Thunderbird" })
  ).password;
  await receive("ana", "Proposta comercial para o projeto Atlas");
  await receive("bruno");
  server = createMailboxImapServer({
    db,
    keyring,
    passwordKey,
    recentlySent: (_mailbox, key) => key === "never",
    onArrival: (listener) => {
      arrivals.add(listener);
      return () => arrivals.delete(listener);
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
});

describe("IMAP with an app password", () => {
  it("signs in only with the mailbox address and an app password", async () => {
    const client = await TestImapClient.open(port);
    expect((await client.send("CAPABILITY")).text).not.toMatch(/CONDSTORE|QUOTA/);
    expect((await client.send('LOGIN jean@box.test "aaaa bbbb cccc dddd"')).status).toMatch(
      /NO \[AUTHENTICATIONFAILED\]/,
    );
    expect((await client.send(`LOGIN outro@box.test "${password}"`)).status).toMatch(/NO/);
    expect((await client.send(`LOGIN jean@box.test "${password}"`)).status).toMatch(/OK/);
    client.close();
  });

  it("lists the Correio's folders with their special uses", async () => {
    const client = await signedIn();
    const list = await client.send('LIST "" "*"');
    expect(list.text).toMatch(/\* LIST \([^)]*\) "\/" "?INBOX"?/);
    expect(list.text).toMatch(/\\Sent[^\r\n]*"?Sent"?/);
    expect(list.text).toMatch(/\\Drafts[^\r\n]*"?Drafts"?/);
    expect(list.text).toMatch(/\\Junk[^\r\n]*"?Junk"?/);
    expect(list.text).toMatch(/\\Trash[^\r\n]*"?Trash"?/);
    expect(list.text).toMatch(/\\Archive[^\r\n]*"?Archive"?/);
    const status = await client.send("STATUS INBOX (MESSAGES UNSEEN UIDNEXT)");
    expect(status.text).toMatch(/MESSAGES 2/);
    expect(status.text).toMatch(/UNSEEN 2/);
    client.close();
  });

  it("selects, fetches, marks read, searches and stars like the web does", async () => {
    const client = await signedIn();
    const select = await client.send("SELECT INBOX");
    expect(select.text).toMatch(/\* 2 EXISTS/);
    expect(select.text).toMatch(/UIDVALIDITY \d+/);
    const headers = await client.send(
      "UID FETCH 1:* (UID FLAGS RFC822.SIZE ENVELOPE BODYSTRUCTURE)",
    );
    expect(headers.text).toMatch(/UID 1 /);
    expect(headers.text).toMatch(/Assunto ana/);
    expect(headers.text).toMatch(/"ana" NIL "ana" "sender\.test"/);
    // Headers alone do not mark it read; BODY[] does, in the Correio too.
    let [ana] = await db
      .select()
      .from(schema.mailboxItems)
      .where(isNotNull(schema.mailboxItems.sourceId));
    expect(ana?.seenAt).toBeNull();
    const body = await client.send("UID FETCH 1 (BODY[])");
    expect(body.text).toContain("Proposta comercial para o projeto Atlas");
    expect(body.text).toMatch(/FLAGS \(\\Seen\)/);
    [ana] = await db
      .select()
      .from(schema.mailboxItems)
      .where(and(eq(schema.mailboxItems.sourceId, "fixture:ana")));
    expect(ana?.seenAt).toBeInstanceOf(Date);

    const search = await client.send("UID SEARCH UNSEEN");
    expect(search.text).toMatch(/\* SEARCH 2\r\n/);
    const text = await client.send('UID SEARCH BODY "Atlas"');
    expect(text.text).toMatch(/\* SEARCH 1\r\n/);

    expect((await client.send("UID STORE 2 +FLAGS (\\Flagged)")).text).toMatch(
      /FLAGS \(\\Flagged\)/,
    );
    const [bruno] = await db
      .select()
      .from(schema.mailboxItems)
      .where(eq(schema.mailboxItems.sourceId, "fixture:bruno"));
    expect(bruno?.starredAt).toBeInstanceOf(Date);
    client.close();
  });

  it("moves to Archive and Trash (EXPUNGE), and Trash keeps what a mail app deletes", async () => {
    const client = await signedIn();
    await client.send("SELECT INBOX");
    const move = await client.send("UID MOVE 1 Archive");
    expect(move.status).toMatch(/OK \[COPYUID \d+ 1 1\]/);
    expect(move.text).toMatch(/\* 1 EXPUNGE/);
    const archived = await client.send("STATUS Archive (MESSAGES)");
    expect(archived.text).toMatch(/MESSAGES 1/);

    await client.send("UID STORE 2 +FLAGS.SILENT (\\Deleted)");
    const expunge = await client.send("EXPUNGE");
    expect(expunge.text).toMatch(/\* 1 EXPUNGE/);
    const [bruno] = await db
      .select()
      .from(schema.mailboxItems)
      .where(eq(schema.mailboxItems.sourceId, "fixture:bruno"));
    expect(bruno?.trashedAt).toBeInstanceOf(Date);

    await client.send("SELECT Trash");
    await client.send("UID STORE 1 +FLAGS.SILENT (\\Deleted)");
    await client.send("EXPUNGE");
    expect((await client.send("STATUS Trash (MESSAGES)")).text).toMatch(/MESSAGES 1/);
    expect((await client.send("UID MOVE 1 Sent")).status).toMatch(/NO \[CANNOT\]/);
    client.close();
  });

  it("appends drafts and imported mail, and tells an IDLE client about new mail at once", async () => {
    const client = await signedIn();
    const draft = await client.send("APPEND Drafts (\\Seen)", mime("rascunho"));
    expect(draft.status).toMatch(/OK \[APPENDUID \d+ 1\]/);
    const [saved] = await db
      .select()
      .from(schema.mailboxItems)
      .where(
        and(eq(schema.mailboxItems.mailboxId, mailboxId), eq(schema.mailboxItems.kind, "draft")),
      );
    expect(saved).toBeDefined();

    await client.send("SELECT INBOX");
    const pushed = client.idle(/\* \d+ EXISTS/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await receive("carla");
    for (const listener of arrivals) listener(mailboxId);
    expect(await pushed).toMatch(/\* 1 EXISTS/);
    const fetch = await client.send("UID FETCH 3 (ENVELOPE)");
    expect(fetch.text).toMatch(/Assunto carla/);
    client.close();
  });

  it("behind the host's proxy, reads the client's address from the PROXY header", async () => {
    const proxied = createMailboxImapServer({ db, keyring, passwordKey, proxyProtocol: true });
    await new Promise<void>((resolve) => proxied.listen(0, "127.0.0.1", resolve));
    const proxiedPort = (proxied.server.address() as AddressInfo).port;
    try {
      const client = await TestImapClient.open(
        proxiedPort,
        "PROXY TCP4 203.0.113.9 127.0.0.1 51000 993\r\n",
      );
      expect((await client.send(`LOGIN jean@box.test "${password}"`)).status).toMatch(/OK/);
      client.close();
    } finally {
      await new Promise<void>((resolve) => proxied.close(() => resolve()));
    }
  });

  it("answers OK to the copy of a mail just sent (no APPENDUID) and keeps serving", async () => {
    // 2026-10-12: Outlook saved its Sent copy right after sending over SMTP; the answer had
    // no APPENDUID info, imap-core threw and the whole process (relay included) went down.
    const justSent = createMailboxImapServer({
      db,
      keyring,
      passwordKey,
      recentlySent: () => true,
    });
    await new Promise<void>((resolve) => justSent.listen(0, "127.0.0.1", resolve));
    const justSentPort = (justSent.server.address() as AddressInfo).port;
    try {
      const client = await TestImapClient.open(justSentPort);
      expect((await client.send(`LOGIN jean@box.test "${password}"`)).status).toMatch(/OK/);
      const append = await client.send(
        "APPEND Sent (\\Seen)",
        mime("saida", "Enviada pelo Outlook"),
      );
      expect(append.status).toMatch(/^T\d+ OK/);
      expect(append.status).not.toMatch(/APPENDUID/);
      // The same connection and a new one still get answers.
      expect((await client.send("NOOP")).status).toMatch(/OK/);
      const other = await TestImapClient.open(justSentPort);
      expect((await other.send(`LOGIN jean@box.test "${password}"`)).status).toMatch(/OK/);
      other.close();
      client.close();
    } finally {
      await new Promise<void>((resolve) => justSent.close(() => resolve()));
    }
  });

  it("ends a session when its password is revoked", async () => {
    const client = await signedIn();
    await db.update(schema.mailboxAppPasswords).set({ revokedAt: new Date() });
    const again = await TestImapClient.open(port);
    expect((await again.send(`LOGIN jean@box.test "${password}"`)).status).toMatch(/NO/);
    again.close();
    client.close();
  });
});
