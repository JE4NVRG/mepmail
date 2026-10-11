import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { simpleParser } from "mailparser";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EnvKeyring } from "../../../packages/core/src/crypto/keyring.js";
import { saveMailboxDraft } from "../../../packages/core/src/mailbox-private-store.js";
import { createMailboxRegistry } from "../../../packages/core/src/mailbox-registry.js";
import {
  type MailboxOutboxSender,
  type MailboxTransportMimeAdapter,
  queueMailboxDraft,
  sendMailboxOutbox,
} from "../../../packages/core/src/mailbox-transport.js";
import { mailboxOutbox } from "../../../packages/db/src/schema/mailbox-transport.js";

/*
 * The same send journeys as mailbox-send-interruption.test.ts, on a real PostgreSQL
 * with a connection pool, where two requests truly overlap (PGlite runs one at a
 * time). Opt-in: MEPMAIL_RACE_PG_URL names a throwaway server; each run makes and
 * drops its own database. The release gate runs it on a local container.
 */
const url = process.env.MEPMAIL_RACE_PG_URL;
// postgres-js, the production driver: a dependency of @millionsend/db, not of this app.
type Sql = {
  unsafe: (query: string) => Promise<unknown>;
  begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
  end: () => Promise<void>;
  options: { serializers: Record<number, (value: unknown) => unknown> };
};
const postgres = createRequire(
  fileURLToPath(new URL("../../../packages/db/package.json", import.meta.url)),
)("postgres") as (url: string, options: Record<string, unknown>) => Sql;
const ROUNDS = 12;
const base = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
const mime: MailboxTransportMimeAdapter = {
  async parse(raw) {
    const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
    const list = (v: typeof parsed.to) =>
      (Array.isArray(v) ? v : v ? [v] : [])
        .flatMap((entry) => entry.value)
        .map((entry) => entry.address!)
        .filter(Boolean);
    return {
      from: parsed.from?.value[0]?.address ?? "",
      to: list(parsed.to),
      cc: list(parsed.cc),
      bcc: list(parsed.bcc),
      attachmentBytes: [],
    };
  },
};
const message = (body: string) =>
  Buffer.from(
    `From: person@race.invalid\r\nTo: customer@example.invalid\r\nSubject: Race\r\n\r\n${body}\r\n`,
  );

describe.skipIf(!url)("Mail send races on PostgreSQL", () => {
  const name = `race_${randomBytes(6).toString("hex")}`;
  let admin: Sql;
  let sql: Sql;
  let db: Db;
  let teamId: string;
  let mailboxId: string;
  const owner = () => ({ teamId, userId: "owner" });

  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${name}`);
    const target = new URL(url!);
    target.pathname = `/${name}`;
    sql = postgres(target.toString(), { max: 8, prepare: false, onnotice: () => {} });
    // As packages/db's client does: raw sql`` Dates reach the wire as ISO text.
    for (const oid of [1184, 1114, 1082])
      sql.options.serializers[oid] = (value) =>
        value instanceof Date ? value.toISOString() : value;
    for (const file of readdirSync(base)
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await sql.begin(async (tx) => {
        for (const statement of readFileSync(base + file, "utf8")
          .split("--> statement-breakpoint")
          .filter((s) => s.trim()))
          await tx.unsafe(statement);
      });
    const database = drizzle(sql as never, { schema: { ...schema, mailboxOutbox } });
    db = database as unknown as Db;
    await migrate(database, {
      migrationsFolder: extension,
      migrationsTable: "__mailbox_migrations",
    });
    teamId = (await db.insert(schema.teams).values({ name: "Race", slug: "race" }).returning())[0]!
      .id;
    await db
      .insert(schema.user)
      .values({ id: "owner", name: "owner", email: "owner@example.invalid", emailVerified: true });
    await db.insert(schema.teamMembers).values({ teamId, userId: "owner", role: "owner" });
    await db.insert(schema.mailboxSubscriptions).values({
      teamId,
      status: "active",
      seats: 2,
      storageBytesPerMailbox: 64 * 1024 * 1024,
      includedOutboundPerMailbox: 1000,
      periodStart: new Date(Date.now() - 86400000),
      periodEnd: new Date(Date.now() + 86400000),
    });
    const [domain] = await db
      .insert(schema.domains)
      .values({ teamId, name: "race.invalid", status: "verified", region: "us-east-1" })
      .returning();
    mailboxId = (
      await createMailboxRegistry(db, owner(), {
        domainId: domain!.id,
        localPart: "person",
        label: "Person",
        kind: "person",
        ownerUserId: "owner",
      })
    ).id;
  }, 120_000);
  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`drop database if exists ${name} with (force)`);
    await admin?.end();
  });

  const draft = (body: string) =>
    saveMailboxDraft(db, keys, owner(), { mailboxId, expectedRevision: 0, raw: message(body) });
  const queue = (id: string, expectedRevision = 1) =>
    queueMailboxDraft(db, keys, owner(), { mailboxId, id, expectedRevision }, mime);
  const outboxesOf = async (draftId: string) =>
    (await db.select().from(mailboxOutbox)).filter((row) => row.draftId === draftId);

  it("overlapping submissions of one revision answer with one outbox, never an error", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const item = await draft(`parallel ${round}`);
      const answers = await Promise.allSettled(Array.from({ length: 6 }, () => queue(item.id)));
      const refused = answers.filter((answer) => answer.status === "rejected");
      expect(refused, String((refused[0] as PromiseRejectedResult | undefined)?.reason)).toEqual(
        [],
      );
      const ids = answers.map(
        (answer) => (answer as PromiseFulfilledResult<{ id: string }>).value.id,
      );
      expect(new Set(ids).size).toBe(1);
      expect(await outboxesOf(item.id)).toHaveLength(1);
    }
  }, 120_000);

  it("a save from another tab racing the send never yields two sendable revisions", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const item = await draft(`tabs ${round}`);
      const [sent, saved] = await Promise.allSettled([
        queue(item.id),
        saveMailboxDraft(db, keys, owner(), {
          mailboxId,
          id: item.id,
          expectedRevision: 1,
          raw: message(`tab B ${round}`),
        }),
      ]);
      // Exactly one of them wins: the send of revision 1 or the new revision 2.
      expect([sent.status, saved.status].sort()).toEqual(["fulfilled", "rejected"]);
      if (saved.status === "fulfilled") {
        // The send lost: revision 2 is a fresh, unsent draft.
        expect(await outboxesOf(item.id)).toHaveLength(0);
      } else {
        await expect(queue(item.id, 2)).rejects.toMatchObject({ code: "conflict" });
        expect(await outboxesOf(item.id)).toHaveLength(1);
      }
    }
  }, 120_000);

  it("two workers on one outbox call the provider once", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const admitted = await queue((await draft(`workers ${round}`)).id);
      const capture = vi.fn<MailboxOutboxSender["send"]>(async (input) => ({
        messageId: `provider-${input.outboxId}`,
      }));
      await Promise.all([
        sendMailboxOutbox(db, keys, admitted.id, { send: capture }, mime),
        sendMailboxOutbox(db, keys, admitted.id, { send: capture }, mime),
      ]);
      expect(capture).toHaveBeenCalledTimes(1);
    }
  }, 120_000);
});
