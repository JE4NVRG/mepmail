import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { simpleParser } from "mailparser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvKeyring, type Keyring } from "../../../packages/core/src/crypto/keyring.js";
import {
  claimDueMailboxExternalAccounts,
  createMailboxExternalAccount,
  MAILBOX_EXTERNAL_RETRY_MS,
  mailboxExternalCredential,
  openMailboxExternalAccount,
  replaceMailboxExternalSecret,
  requestMailboxExternalSync,
} from "../../../packages/core/src/mailbox-external-accounts.js";
import {
  MailboxExternalOAuthError,
  mailboxExternalOAuthSecret,
  readMailboxExternalOAuthSecret,
  refreshMailboxExternalOAuthToken,
} from "../../../packages/core/src/mailbox-external-oauth.js";
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

  it("asks to sign in again only when the provider refuses the grant (a missing env retries)", async () => {
    const failing = (reason: "invalid_grant" | "unconfigured") => async () => {
      throw new MailboxExternalOAuthError(reason);
    };
    const open = async () => {
      throw new Error("IMAP must not be reached without a credential");
    };
    expect(
      await syncMailboxExternalAccount(db, keys, mailboxId, {
        mime,
        open,
        credential: failing("unconfigured"),
      }),
    ).toBe("error");
    expect(await account()).toMatchObject({ status: "error", lastError: "oauth_unconfigured" });
    expect(
      await syncMailboxExternalAccount(db, keys, mailboxId, {
        mime,
        open,
        credential: failing("invalid_grant"),
      }),
    ).toBe("auth_failed");
    expect(await account()).toMatchObject({ status: "auth_failed", lastError: "oauth_refused" });
  });
});

// ---- Recovery and reconnects (0035: connection_generation) -------------------------------

const MINUTE = 60_000;
const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

/** The person signs in again (or pastes a new app password) — what the web callback does. */
const reconnect = (secret: string, id = mailboxId) =>
  replaceMailboxExternalSecret(db, keys, { teamId, userId: "ana" }, { mailboxId: id, secret });

/** The sealed secret as the worker would open it now. */
const secretOf = async (id = mailboxId) => (await openMailboxExternalAccount(db, keys, id))!.secret;

/** An OAuth (Google) account next to the password one; its refresh token is sealed. */
async function connectOAuth(refresh = "refresh-1") {
  const { mailboxId: id } = await createMailboxExternalAccount(
    db,
    keys,
    { teamId, userId: "ana" },
    {
      address: "ana.oauth@gmail.com",
      label: "Gmail (Google)",
      servers: {
        provider: "gmail",
        imapHost: "imap.gmail.com",
        smtpHost: "smtp.gmail.com",
        smtpPort: 465,
        smtpSecurity: "tls",
        username: "ana.oauth@gmail.com",
      },
      secret: mailboxExternalOAuthSecret(refresh),
      auth: "oauth_google",
    },
  );
  return id;
}

/** Google's token endpoint: a fresh access token, optionally a rotated refresh token. */
function googleTokens(answer: { access: string; refresh?: string }, onCall?: () => Promise<void>) {
  return (async () => {
    await onCall?.();
    return new Response(
      JSON.stringify({
        access_token: answer.access,
        expires_in: 3600,
        ...(answer.refresh ? { refresh_token: answer.refresh } : {}),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

const rowOf = async (id: string) =>
  (
    await db
      .select()
      .from(schema.mailboxExternalAccounts)
      .where(eq(schema.mailboxExternalAccounts.mailboxId, id))
  )[0]!;

describe("Contas externas: an account in error comes back by itself", () => {
  it("retries a provider failure at its time through the real scheduler, without reconnecting", async () => {
    const t0 = new Date("2026-10-14T10:00:00Z");
    const down = async () => {
      throw new ImapError("network");
    };
    expect(
      await syncMailboxExternalAccount(db, keys, mailboxId, { mime, open: down, now: () => t0 }),
    ).toBe("error");
    const failed = await account();
    expect(failed).toMatchObject({ status: "error", lastError: "imap_network" });
    expect(failed.nextSyncAt.getTime()).toBe(t0.getTime() + MAILBOX_EXTERNAL_RETRY_MS);

    // Not due before its retry time; due (and claimed) once the clock passes it.
    expect(await claimDueMailboxExternalAccounts(db, 50, new Date(t0.getTime() + MINUTE))).toEqual(
      [],
    );
    const later = new Date(t0.getTime() + MAILBOX_EXTERNAL_RETRY_MS + MINUTE);
    expect(await claimDueMailboxExternalAccounts(db, 50, later)).toEqual([mailboxId]);

    // The provider is back: the claimed round syncs and the account is active again.
    const state = { uidValidity: 9, messages: [msg(1), msg(2)], calls: [] as string[] };
    expect(
      await syncMailboxExternalAccount(db, keys, mailboxId, {
        mime,
        open: fakeImap(state),
        now: () => later,
      }),
    ).toBe("done");
    const back = await account();
    expect(back).toMatchObject({
      status: "active",
      lastError: null,
      connectionGeneration: 1,
      syncState: { inbox: { uidValidity: 9, lastUid: 2 } },
    });
    expect(back.lastSyncedAt?.getTime()).toBe(later.getTime());
    expect((await items()).length).toBe(2);
    expect(await secretOf()).toBe("app-password");
  });

  it("retries a missing OAuth setting once it is restored, through the scheduler, without reconnecting", async () => {
    const id = await connectOAuth("refresh-1");
    await db
      .update(schema.mailboxExternalAccounts)
      .set({ nextSyncAt: new Date("2026-10-14T09:00:00Z") })
      .where(eq(schema.mailboxExternalAccounts.mailboxId, mailboxId));
    delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const t0 = new Date("2026-10-14T10:00:00Z");
    const seen: unknown[] = [];
    const credential: typeof mailboxExternalCredential = (d, k, a) =>
      mailboxExternalCredential(d, k, a, (provider, token) =>
        refreshMailboxExternalOAuthToken(provider, token, googleTokens({ access: "access-1" })),
      );
    const state = { uidValidity: 4, messages: [msg(7)], calls: [] as string[] };
    const open = (async (config: unknown) => {
      seen.push(config);
      return fakeImap(state)();
    }) as never;

    expect(
      await syncMailboxExternalAccount(db, keys, id, { mime, open, credential, now: () => t0 }),
    ).toBe("error");
    expect(await rowOf(id)).toMatchObject({ status: "error", lastError: "oauth_unconfigured" });
    expect(seen).toEqual([]);

    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret";
    const later = new Date(t0.getTime() + MAILBOX_EXTERNAL_RETRY_MS + MINUTE);
    const claimed = await claimDueMailboxExternalAccounts(db, 50, later);
    expect(claimed).toContain(id);
    expect(
      await syncMailboxExternalAccount(db, keys, id, { mime, open, credential, now: () => later }),
    ).toBe("done");
    expect(await rowOf(id)).toMatchObject({
      status: "active",
      lastError: null,
      connectionGeneration: 1,
    });
    expect(seen).toEqual([expect.objectContaining({ accessToken: "access-1" })]);
    expect(readMailboxExternalOAuthSecret(await secretOf(id))).toBe("refresh-1");
  });

  it("lets Sincronizar agora move an account in error forward, but never one that waits for the person", async () => {
    const t0 = new Date("2026-10-14T10:00:00Z");
    await syncMailboxExternalAccount(db, keys, mailboxId, {
      mime,
      open: async () => {
        throw new ImapError("network");
      },
      now: () => t0,
    });
    await requestMailboxExternalSync(db, { teamId, userId: "ana" }, mailboxId);
    expect(await claimDueMailboxExternalAccounts(db, 50, new Date())).toEqual([mailboxId]);

    await syncMailboxExternalAccount(db, keys, mailboxId, {
      mime,
      open: async () => {
        throw new ImapError("login");
      },
    });
    expect((await account()).status).toBe("auth_failed");
    await requestMailboxExternalSync(db, { teamId, userId: "ana" }, mailboxId);
    expect(
      await claimDueMailboxExternalAccounts(
        db,
        50,
        new Date(Date.now() + 2 * MAILBOX_EXTERNAL_RETRY_MS),
      ),
    ).toEqual([]);
  });
});

describe("Contas externas: results of an old connection never land on the new one", () => {
  it("a sign-in failure that ends after a reconnect leaves the new connection active", async () => {
    const before = { uidValidity: 9, messages: [msg(1)], calls: [] as string[] };
    await syncMailboxExternalAccount(db, keys, mailboxId, { mime, open: fakeImap(before) });
    const checkpoint = (await account()).syncState;
    let reconnectedAt = 0;
    const result = await syncMailboxExternalAccount(db, keys, mailboxId, {
      mime,
      open: async () => {
        // The person pastes a new app password while this round is signing in.
        await reconnect("new-app-password");
        reconnectedAt = Date.now();
        throw new ImapError("login");
      },
    });
    expect(result).toBe("stale");
    const now = await account();
    expect(now).toMatchObject({
      status: "active",
      lastError: null,
      connectionGeneration: 2,
      syncState: checkpoint,
    });
    expect(Math.abs(now.nextSyncAt.getTime() - reconnectedAt)).toBeLessThan(5_000);
    expect(await secretOf()).toBe("new-app-password");
  });

  it("a token renewal racing a reconnect keeps the reconnected token and drops the old round", async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret";
    const id = await connectOAuth("refresh-old");
    const opened = await openMailboxExternalAccount(db, keys, id);
    // The provider answers the renewal (with a rotated token) after the person signed in again.
    const credential: typeof mailboxExternalCredential = (d, k, a) =>
      mailboxExternalCredential(d, k, a, (provider, token) =>
        refreshMailboxExternalOAuthToken(
          provider,
          token,
          googleTokens({ access: "access-old", refresh: "refresh-rotated" }, () =>
            reconnect(mailboxExternalOAuthSecret("refresh-new"), id),
          ),
        ),
      );
    const state = { uidValidity: 4, messages: [msg(1), msg(2)], calls: [] as string[] };
    expect(
      await syncMailboxExternalAccount(db, keys, id, { mime, open: fakeImap(state), credential }),
    ).toBe("stale");
    const row = await rowOf(id);
    expect(row).toMatchObject({
      status: "active",
      lastError: null,
      connectionGeneration: 2,
      syncState: {},
      lastSyncedAt: null,
    });
    expect(Buffer.from(row.secretIv).equals(Buffer.from(opened!.secretIv))).toBe(false);
    expect(readMailboxExternalOAuthSecret(await secretOf(id))).toBe("refresh-new");

    // The new connection's own round then reads the INBOX once, nothing twice.
    const fresh: typeof mailboxExternalCredential = (d, k, a) =>
      mailboxExternalCredential(d, k, a, (provider, token) => {
        expect(token).toBe("refresh-new");
        return refreshMailboxExternalOAuthToken(
          provider,
          token,
          googleTokens({ access: "access-new" }),
        );
      });
    expect(
      await syncMailboxExternalAccount(db, keys, id, {
        mime,
        open: fakeImap(state),
        credential: fresh,
      }),
    ).toBe("done");
    const stored = await db
      .select()
      .from(schema.mailboxItems)
      .where(eq(schema.mailboxItems.mailboxId, id));
    expect(stored.length).toBe(2);
    expect(await rowOf(id)).toMatchObject({
      status: "active",
      connectionGeneration: 2,
      syncState: { inbox: { uidValidity: 4, lastUid: 2 } },
    });
  });

  it("a valid renewal changes the IV but not the connection: the round that renewed writes its outcome", async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-secret";
    const id = await connectOAuth("refresh-1");
    const ivBefore = (await rowOf(id)).secretIv;
    const credential: typeof mailboxExternalCredential = (d, k, a) =>
      mailboxExternalCredential(d, k, a, (provider, token) =>
        refreshMailboxExternalOAuthToken(
          provider,
          token,
          googleTokens({ access: "access-2", refresh: "refresh-2" }),
        ),
      );
    const state = { uidValidity: 4, messages: [msg(1)], calls: [] as string[] };
    expect(
      await syncMailboxExternalAccount(db, keys, id, { mime, open: fakeImap(state), credential }),
    ).toBe("done");
    const row = await rowOf(id);
    expect(Buffer.from(row.secretIv).equals(Buffer.from(ivBefore))).toBe(false);
    expect(row).toMatchObject({
      status: "active",
      connectionGeneration: 1,
      syncState: { inbox: { uidValidity: 4, lastUid: 1 } },
    });
    expect(readMailboxExternalOAuthSecret(await secretOf(id))).toBe("refresh-2");
  });

  it("a reading round across a reconnect stops at its next checkpoint and stores nothing twice", async () => {
    const messages = Array.from({ length: 30 }, (_, index) => msg(index + 1));
    const state = { uidValidity: 9, messages, calls: [] as string[] };
    let fetches = 0;
    const racing = async () => {
      const session = await fakeImap(state)();
      return {
        ...session,
        async uidFetchMessages(uids: readonly number[]) {
          fetches += 1;
          // The person signs in again while the first batch is being read.
          if (fetches === 1) await reconnect("new-app-password");
          return session.uidFetchMessages(uids);
        },
      } as typeof session;
    };
    expect(await syncMailboxExternalAccount(db, keys, mailboxId, { mime, open: racing })).toBe(
      "stale",
    );
    expect(fetches).toBe(1);
    expect((await items()).length).toBe(25);
    expect(await account()).toMatchObject({
      status: "active",
      lastError: null,
      connectionGeneration: 2,
      syncState: {},
    });

    expect(
      await syncMailboxExternalAccount(db, keys, mailboxId, { mime, open: fakeImap(state) }),
    ).toBe("done");
    expect((await items()).length).toBe(30);
    expect(await account()).toMatchObject({
      status: "active",
      connectionGeneration: 2,
      syncState: { inbox: { uidValidity: 9, lastUid: 30 } },
    });
  });
});
