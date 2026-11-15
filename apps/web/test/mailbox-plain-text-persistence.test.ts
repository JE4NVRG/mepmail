import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  createMailboxRegistry,
  EnvKeyring,
  importMailboxMime,
  readMailboxItem,
  setMailboxSignatureLogo,
  updateMailboxSignature,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { simpleParser } from "mailparser";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { seedMailboxTestService } from "./mailbox-service-fixture";

vi.mock("../src/server/keyring", () => ({ getKeyring: vi.fn() }));
vi.mock("../src/server/mailbox-sender-key", () => ({ mailboxSenderHmacKey: () => null }));
const { getKeyring } = await import("../src/server/keyring");
const { saveMailboxContentDraft } = await import("../src/server/mailbox-content");
let client: PGlite, db: Db, teamId: string, mailboxId: string, keys: EnvKeyring;
const actor = () => ({ teamId, userId: "text-variant-owner" });
const fresh = () => ({
  mailboxId,
  expectedRevision: 0,
  to: ["recipient@example.invalid"],
  cc: ["copy@example.invalid"],
  bcc: ["blind@example.invalid"],
  subject: "Synthetic persisted variant",
  text: "Authorized structured correspondence",
  retainedAttachments: [] as number[],
  uploads: [] as { filename: string; base64: string }[],
});
const parse = (raw: Buffer) => simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
beforeAll(async () => {
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  client = new PGlite();
  const main = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
  await client.transaction(async (tx) => {
    for (const name of readdirSync(main)
      .filter((n) => n.endsWith(".sql"))
      .sort())
      for (const sql of readFileSync(main + name, "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => s.trim()))
        await tx.exec(sql);
  });
  const database = drizzle(client, { schema });
  db = database as unknown as Db;
  await migrate(database, {
    migrationsFolder: fileURLToPath(
      new URL("../../../packages/db/mailbox-drizzle/", import.meta.url),
    ),
    migrationsTable: "__mailbox_migrations",
  });
  const [team] = await db
    .insert(schema.teams)
    .values({ name: "Synthetic text variant", slug: "synthetic-text-variant" })
    .returning();
  teamId = team!.id;
  await seedMailboxTestService(db, [teamId]);
  await db.insert(schema.user).values({
    id: actor().userId,
    name: "Synthetic owner",
    email: "owner@example.invalid",
    emailVerified: true,
  });
  await db.insert(schema.teamMembers).values({ teamId, userId: actor().userId, role: "owner" });
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "text-variant.invalid", region: "us-east-1" })
    .returning();
  mailboxId = (
    await createMailboxRegistry(db, actor(), {
      domainId: domain!.id,
      localPart: "person",
      label: "Person",
      kind: "person",
      ownerUserId: actor().userId,
    })
  ).id;
  await updateMailboxSignature(db, actor(), {
    mailboxId,
    name: "Synthetic Name",
    title: "Advisor",
    company: "Synthetic Company",
    phone: "+55 11 1234-5678",
    website: "http://example.invalid/account?q=1",
    text: "Synthetic textual terms",
  });
  await setMailboxSignatureLogo(db, actor(), {
    mailboxId,
    logoUrl: "https://example.invalid/mutable-logo.png?v=1",
    width: 100,
    height: 50,
  });
  keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
  vi.mocked(getKeyring).mockReturnValue(keys);
});
afterAll(async () => {
  if (client) await client.close();
  vi.unstubAllEnvs();
});
it("text-only persistence captures a new sealed MIME without HTML or logo and retains original Inbox bytes", async () => {
  const original = Buffer.from(
    'From: sender@example.invalid\r\nReply-To: source-reply@example.invalid\r\nTo: person@text-variant.invalid\r\nMessage-ID: <original@example.invalid>\r\nReferences: <older@example.invalid>\r\nContent-Type: text/html\r\n\r\n<p>Original<img src="https://example.invalid/source.png"></p>',
  );
  const source = await importMailboxMime(db, keys, actor(), {
    mailboxId,
    sourceId: "text-variant:source",
    raw: original,
  });
  const saved = await saveMailboxContentDraft(db, actor(), {
    ...fresh(),
    messageFormat: "plain_text",
    sourceItemId: source.id,
  });
  const row = await readMailboxItem(db, keys, actor(), { mailboxId, id: saved.id });
  const mime = await parse(row.raw);
  expect(row.revision).toBe(1);
  expect(mime.html).toBe(false);
  expect(mime.attachments).toEqual([]);
  expect(mime.headers.get("content-type")).toMatchObject({ value: "text/plain" });
  expect(mime.text).toContain("Synthetic textual terms");
  expect(mime.text).toContain("http://example.invalid/account?q=1");
  expect(row.raw.toString()).not.toMatch(/text\/html|multipart\/|mutable-logo|source\.png/i);
  expect(mime.from?.value[0]?.address).toBe("person@text-variant.invalid");
  expect(mime.replyTo?.value[0]?.address ?? mime.from?.value[0]?.address).toBe(
    "person@text-variant.invalid",
  );
  expect(mime.to).toMatchObject({ value: [{ address: "recipient@example.invalid" }] });
  expect(mime.cc).toMatchObject({ value: [{ address: "copy@example.invalid" }] });
  expect(mime.bcc).toMatchObject({ value: [{ address: "blind@example.invalid" }] });
  expect(mime.inReplyTo).toBe("<original@example.invalid>");
  expect(mime.references).toContain("<older@example.invalid>");
  expect((await readMailboxItem(db, keys, actor(), { mailboxId, id: source.id })).raw).toEqual(
    original,
  );
  expect(saved).not.toHaveProperty("composition");
});
it("text-only persistence refuses converting a saved logo draft and leaves its revision/raw intact", async () => {
  const text =
    "Original words\n\n--\nSynthetic Name\nAdvisor · Synthetic Company\n+55 11 1234-5678 · example.invalid/account?q=1\nSynthetic textual terms";
  const legacy = await saveMailboxContentDraft(db, actor(), { ...fresh(), text });
  const before = await readMailboxItem(db, keys, actor(), { mailboxId, id: legacy.id });
  expect((await parse(before.raw)).html).toContain("mutable-logo");
  await expect(
    saveMailboxContentDraft(db, actor(), {
      ...fresh(),
      messageFormat: "plain_text",
      id: legacy.id,
      sourceItemId: legacy.id,
      expectedRevision: legacy.revision,
    }),
  ).rejects.toMatchObject({ code: "invalid" });
  const after = await readMailboxItem(db, keys, actor(), { mailboxId, id: legacy.id });
  expect(after.raw).toEqual(before.raw);
  expect(after.revision).toBe(before.revision);
});
