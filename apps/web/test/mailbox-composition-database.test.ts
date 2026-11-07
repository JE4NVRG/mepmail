import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvKeyring, type Keyring } from "../../../packages/core/src/crypto/keyring.js";
import {
  prepareMailboxOptout,
  validateMailboxOptout,
} from "../../../packages/core/src/mailbox-optout.js";
import {
  importMailboxMime,
  readMailboxItem,
  saveMailboxDraft,
} from "../../../packages/core/src/mailbox-private-store.js";
import {
  createMailboxRegistry,
  grantMailboxRegistry,
  revokeMailboxRegistry,
  updateMailboxRegistry,
} from "../../../packages/core/src/mailbox-registry.js";
import { seedMailboxTestService } from "./mailbox-service-fixture";

// Config/key injection only. Real core authority, persistence, encryption, policy,
// composition, MIME parsing and opt-out helpers are NEVER mocked in this suite.
const fixture = vi.hoisted(() => ({
  policy: "",
  master: Buffer.alloc(32, 7).toString("base64"),
  keyring: null as Keyring | null,
}));
vi.mock("@millionsend/config", async (original) => {
  const actual = await original<typeof import("@millionsend/config")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      MASTER_ENCRYPTION_KEY: fixture.master,
      get SENDING_PROVIDER_POLICY_JSON() {
        return fixture.policy;
      },
    },
    unsubscribeBaseUrl: () => "https://fixture.invalid",
  };
});
vi.mock("../src/server/keyring", () => ({ getKeyring: () => fixture.keyring }));
const { saveMailboxContentDraft, verifyMailboxDraftComposition, getMailboxContent } = await import(
  "../src/server/mailbox-content"
);

let client: PGlite, db: Db, teamId: string, mailboxId: string;
const address = "support@composition.invalid",
  recipient = "owner@example.invalid";
const owner = () => ({ teamId, userId: "composition-owner" });
const agent = () => ({ teamId, userId: "composition-member", agentAccess: true as const });
const hash = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
const folder = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));

beforeAll(async () => {
  client = new PGlite();
  await client.transaction(async (tx) => {
    for (const name of readdirSync(folder)
      .filter((n) => n.endsWith(".sql"))
      .sort())
      for (const statement of readFileSync(folder + name, "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => s.trim()))
        await tx.exec(statement);
  });
  const database = drizzle(client, { schema });
  db = database as unknown as Db;
  await migrate(database, { migrationsFolder: extension, migrationsTable: "__mailbox_migrations" });
  const teams = await db
    .insert(schema.teams)
    .values({ name: "Composition fixture", slug: "composition-contract" })
    .returning();
  teamId = teams[0]!.id;
  await seedMailboxTestService(db, [teamId]);
  for (const id of ["composition-owner", "composition-member"])
    await db
      .insert(schema.user)
      .values({ id, name: id, email: id + "@example.invalid", emailVerified: true });
  await db.insert(schema.teamMembers).values([
    { teamId, userId: "composition-owner", role: "owner" },
    { teamId, userId: "composition-member", role: "member" },
  ]);
  const domains = await db
    .insert(schema.domains)
    .values({ teamId, name: "composition.invalid", region: "us-east-1" })
    .returning();
  mailboxId = (
    await createMailboxRegistry(db, owner(), {
      domainId: domains[0]!.id,
      localPart: "support",
      label: "Fixture",
      kind: "person",
      ownerUserId: "composition-owner",
    })
  ).id;
  fixture.keyring = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
});
afterAll(async () => {
  await client?.close();
});
beforeEach(async () => {
  await grantMailboxRegistry(db, owner(), {
    mailboxId,
    userId: "composition-member",
    permission: "draft",
  });
  await updateMailboxRegistry(db, owner(), {
    mailboxId,
    signatureText: "Synthetic support signature",
  });
  fixture.policy = JSON.stringify({
    version: 1,
    paused: true,
    allowedTeamIds: [teamId],
    defaults: { transactional: "disabled", campaign: "disabled" },
    teams: { [teamId]: { transactional: "azure_smtp", campaign: "disabled" } },
    restoration: { teams: { [teamId]: { notBefore: "2026-01-01T00:00:00Z", senders: [address] } } },
  });
});
async function prepared() {
  const raw = Buffer.from(
    `From: ${recipient}\r\nTo: ${address}\r\nSubject: Real core fixture\r\nMessage-ID: <${randomUUID()}@fixture.invalid>\r\n\r\nOwned synthetic source`,
  );
  const source = await importMailboxMime(db, fixture.keyring!, owner(), {
    mailboxId,
    sourceId: "composition:" + randomUUID(),
    raw,
  });
  const input = {
    mailboxId,
    expectedRevision: 0,
    sourceItemId: source.id,
    mode: "reply" as const,
    to: [recipient],
    subject: "Re: Real core fixture",
    text: "Human text 🌎\r\nPreserve exact authored whitespace.",
    retainedAttachments: [] as number[],
    uploads: [] as { filename: string; base64: string }[],
  };
  const saved = await saveMailboxContentDraft(db, agent(), input);
  if (!("composition" in saved)) throw new Error("Real provider did not issue composition receipt");
  return { input, saved, verify: { ...input, id: saved.id, expectedRevision: saved.revision } };
}
async function rawItem(id: string) {
  return readMailboxItem(db, fixture.keyring!, owner(), { mailboxId, id });
}

describe("canonical provider/core composition with real encrypted database and signed policy footer", () => {
  it("attests exact saved MIME with real signature and deterministic mandatory opt-out while sending remains paused", async () => {
    const f = await prepared(),
      item = await rawItem(f.saved.id),
      mime = await simpleParser(item.raw);
    expect(f.saved.composition.composedMimeSha256).toBe(hash(item.raw));
    expect(mime.text).toContain("Synthetic support signature");
    const footer = await prepareMailboxOptout(
      db,
      teamId,
      [recipient],
      { baseUrl: "https://fixture.invalid", masterKey: Buffer.from(fixture.master, "base64") },
      { draftOnly: true },
    );
    expect(mime.text?.replace(/\r\n/g, "\n").trimEnd().endsWith(footer.text)).toBe(true);
    expect(mime.text?.split("Synthetic support signature")).toHaveLength(2);
    await validateMailboxOptout(
      db,
      teamId,
      [recipient],
      {
        text: mime.text!,
        html: typeof mime.html === "string" ? mime.html : null,
        headerLines: mime.headerLines,
      },
      { baseUrl: "https://fixture.invalid", masterKey: Buffer.from(fixture.master, "base64") },
    );
    expect(JSON.parse(fixture.policy).paused).toBe(true);
  });
  it("verifies an existing draft without changing raw ciphertext/revision or creating an outbox row", async () => {
    const f = await prepared();
    const before = await db
      .select()
      .from(schema.mailboxItems)
      .where(eq(schema.mailboxItems.id, f.saved.id));
    const receipt = await verifyMailboxDraftComposition(db, agent(), f.verify);
    expect(receipt).toEqual(f.saved.composition);
    const after = await db
      .select()
      .from(schema.mailboxItems)
      .where(eq(schema.mailboxItems.id, f.saved.id));
    expect(after).toEqual(before);
    expect(await db.select().from(schema.mailboxOutbox)).toHaveLength(0);
    const read = await getMailboxContent(db, agent(), { mailboxId, id: f.saved.id });
    expect(read.contentSha256).toBe(receipt.composedMimeSha256);
  });
  it("real grant revocation denies qualification rather than bypassing authority", async () => {
    const f = await prepared();
    await revokeMailboxRegistry(db, owner(), { mailboxId, userId: "composition-member" });
    await expect(verifyMailboxDraftComposition(db, agent(), f.verify)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect((await rawItem(f.saved.id)).revision).toBe(1);
  });
  it.each(["text", "html", "header", "cc", "thread", "attachment"])(
    "rejects complete MIME drift at a current revision: %s",
    async (field) => {
      const f = await prepared(),
        previous = await rawItem(f.saved.id),
        parsed = await simpleParser(previous.raw);
      const footer = await prepareMailboxOptout(
        db,
        teamId,
        [recipient],
        { baseUrl: "https://fixture.invalid", masterKey: Buffer.from(fixture.master, "base64") },
        { draftOnly: true },
      );
      const transport = nodemailer.createTransport({
        streamTransport: true,
        buffer: true,
        newline: "windows",
      });
      const changed = await transport.sendMail({
        from: address,
        to: [recipient],
        ...(field === "cc" ? { cc: ["other@example.invalid"] } : {}),
        subject: f.input.subject,
        text: parsed.text! + (field === "text" ? " changed" : ""),
        html: String(parsed.html) + (field === "html" ? "<p>changed</p>" : ""),
        headers: {
          "List-Unsubscribe": `<${footer.url}>`,
          ...(field === "header" ? { "X-Unauthorized-Header": "changed" } : {}),
        },
        messageId: parsed.messageId,
        inReplyTo: field === "thread" ? "<other@fixture.invalid>" : parsed.inReplyTo,
        references: parsed.references,
        ...(field === "attachment"
          ? { attachments: [{ filename: "extra.txt", content: "extra" }] }
          : {}),
      });
      const edited = await saveMailboxDraft(db, fixture.keyring!, owner(), {
        mailboxId,
        id: f.saved.id,
        expectedRevision: 1,
        raw: changed.message,
      });
      await expect(
        verifyMailboxDraftComposition(db, agent(), {
          ...f.verify,
          expectedRevision: edited.revision,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(await db.select().from(schema.mailboxOutbox)).toHaveLength(0);
    },
  );
});
