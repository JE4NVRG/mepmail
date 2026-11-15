import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  acceptMailboxOutbox,
  assessMailboxReceipt,
  createMailboxAgentKey,
  createMailboxRegistry,
  EnvKeyring,
  grantMailboxRegistry,
  importMailboxMime,
  type MailboxOutboundEvidence,
  queueMailboxDraft,
  readMailboxItem,
  receiveMailboxMime,
  revokeMailboxRegistry,
  saveMailboxDraft,
  sendMailboxOutbox,
  storeMailboxListSummaries,
  updateMailboxSignature,
  withMailboxAgentAccess,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { simpleParser } from "mailparser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/mailboxes/[mailboxId]/items/[id]/attachments/[index]/route";
import { getKeyring } from "@/server/keyring";
import {
  getMailboxContent,
  getMailboxContentList,
  saveMailboxContentDraft,
} from "@/server/mailbox-content";
import { mailboxSenderHmacKey } from "@/server/mailbox-sender-key";
import { mailboxTransportMime } from "@/server/mailbox-transport";
import { mailboxesRouter } from "@/server/routers/mailboxes";
import { type Context, createCallerFactory, createContext, router } from "@/server/trpc";
import {
  prepareMailboxOptout,
  validateMailboxOptout,
} from "../../../packages/core/src/mailbox-optout";
import { decideMailboxSender } from "../../../packages/core/src/mailbox-senders";
import { seedMailboxTestService } from "./mailbox-service-fixture";

vi.mock("@/server/keyring", () => ({ getKeyring: vi.fn() }));
// Screening is off unless a test gives it a key.
vi.mock("@/server/mailbox-sender-key", () => ({ mailboxSenderHmacKey: vi.fn(() => null) }));
vi.mock("@/server/trpc", async (original) => ({
  ...(await original<typeof import("@/server/trpc")>()),
  createContext: vi.fn(),
}));
let client: PGlite,
  db: Db,
  teamId: string,
  otherTeam: string,
  mailboxId: string,
  agentId: string,
  keys: EnvKeyring;
const folder = process.env.MEPMAIL_AZURE_FIXTURE_DDL_ROOT
  ? join(process.env.MEPMAIL_AZURE_FIXTURE_DDL_ROOT, "drizzle")
  : fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = process.env.MEPMAIL_AZURE_FIXTURE_DDL_ROOT
  ? join(process.env.MEPMAIL_AZURE_FIXTURE_DDL_ROOT, "mailbox-drizzle")
  : fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const caller = createCallerFactory(router({ mailboxes: mailboxesRouter }));
function ctx(userId = "owner", extra: Partial<Context> = {}): Context {
  return {
    db,
    teamId,
    role: userId === "admin" ? "admin" : userId === "owner" ? "owner" : "member",
    session: { user: { id: userId, name: userId, email: `${userId}@example.invalid` } },
    ...extra,
  };
}
const as = (userId = "owner", extra: Partial<Context> = {}) => caller(ctx(userId, extra)).mailboxes;
const actor = () => ({ teamId, userId: "owner" });
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6iYQAAAAASUVORK5CYII=";
function mime(attachment = Buffer.from(png, "base64"), name = "private.png", type = "image/png") {
  return Buffer.from(
    `From: Pessoa <sender@example.invalid>\r\nTo: person@content.invalid\r\nReply-To: reply@example.invalid\r\nSubject: Private subject\r\nMessage-ID: <original@example.invalid>\r\nReferences: <older@example.invalid>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=local\r\n\r\n--local\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPrivate body <script>alert(1)</script>\r\n--local\r\nContent-Type: ${type}\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${attachment.toString("base64")}\r\n--local--\r\n`,
  );
}
const imported = (sourceId = "fixture:1", box = mailboxId, raw = mime()) =>
  importMailboxMime(db, keys, actor(), { mailboxId: box, sourceId, raw });
const draft = (extra = {}) => ({
  mailboxId,
  expectedRevision: 0,
  to: ["reply@example.invalid"],
  subject: "Re: Private subject",
  text: "Local reply",
  retainedAttachments: [] as number[],
  uploads: [] as { filename: string; base64: string }[],
  ...extra,
});
async function submittedSent(extra = {}) {
  await db
    .update(schema.domains)
    .set({ status: "verified" })
    .where(eq(schema.domains.teamId, teamId));
  const saved = await as().saveDraft(draft(extra));
  const raw = (
    await readMailboxItem(db, keys, actor(), { mailboxId: saved.mailboxId, id: saved.id })
  ).raw;
  const queued = await queueMailboxDraft(
    db,
    keys,
    actor(),
    {
      mailboxId: saved.mailboxId,
      id: saved.id,
      expectedRevision: saved.revision,
    },
    mailboxTransportMime,
  );
  const sender = vi.fn(async () => ({ messageId: `api-${queued.id}` }));
  await sendMailboxOutbox(db, keys, queued.id, { send: sender }, mailboxTransportMime);
  const [row] = await db
    .select()
    .from(schema.mailboxOutbox)
    .where(eq(schema.mailboxOutbox.id, queued.id));
  return { row: row!, raw, sender };
}
const aliasEvidence = (row: typeof schema.mailboxOutbox.$inferSelect, rfcMessageId: string) =>
  acceptMailboxOutbox(db, row.id, {
    attemptId: row.attemptId!,
    messageId: row.providerMessageId!,
    rfcMessageId,
  });
const resultEvidence = (
  row: typeof schema.mailboxOutbox.$inferSelect,
  outcome: MailboxOutboundEvidence["outcome"],
  recipientHashes: string[],
  snsMessageId: string,
  occurredAt = new Date("2026-10-04T12:00:00Z"),
  now = occurredAt,
) =>
  acceptMailboxOutbox(db, row.id, {
    attemptId: row.attemptId!,
    messageId: row.providerMessageId!,
    outboundEvidence: {
      topicArn: "arn:aws:sns:us-east-1:123456789012:synthetic-mailbox-outcomes",
      snsMessageId,
      outcome,
      recipientHashes,
      approvedRecipientHashes: row.recipientHashes!,
      occurredAt,
    },
    now,
  });
function responseMime(inReplyTo: string, refs: string[] = []) {
  return Buffer.from(
    `From: external@example.invalid\r\nTo: forged-visible@other.invalid\r\nSubject: Re: Local reply\r\nMessage-ID: <incoming@example.invalid>\r\nIn-Reply-To: ${inReplyTo}\r\nReferences: ${refs.join(" ")}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nExternal response fixture\r\n`,
  );
}
async function download(id: string, index = "0", box = mailboxId, query = "", revision = 1) {
  return GET(
    new Request(
      `http://127.0.0.1:3186/api/mailboxes/${box}/items/${id}/attachments/${index}?revision=${revision}${query ? `&${query.slice(1)}` : ""}`,
    ),
    { params: Promise.resolve({ mailboxId: box, id, index }) },
  );
}
beforeEach(async () => {
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  client = new PGlite();
  await client.transaction(async (tx) => {
    for (const name of readdirSync(folder)
      .filter((n) => n.endsWith(".sql"))
      .sort())
      for (const sql of readFileSync(join(folder, name), "utf8")
        .split("--> statement-breakpoint")
        .filter((s) => s.trim()))
        await tx.exec(sql);
  });
  const database = drizzle(client, { schema });
  db = database as unknown as Db;
  await migrate(database, { migrationsFolder: extension, migrationsTable: "__mailbox_migrations" });
  const teams = await db
    .insert(schema.teams)
    .values([
      { name: "Content", slug: "content" },
      { name: "Other", slug: "content-other" },
    ])
    .returning();
  teamId = teams[0]!.id;
  otherTeam = teams[1]!.id;
  await seedMailboxTestService(db, [teamId, otherTeam]);
  for (const id of ["owner", "member", "admin", "outsider"])
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.invalid`, emailVerified: true });
  await db.insert(schema.teamMembers).values([
    { teamId, userId: "owner", role: "owner" },
    { teamId, userId: "member", role: "member" },
    { teamId, userId: "admin", role: "admin" },
    { teamId: otherTeam, userId: "outsider", role: "owner" },
  ]);
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "content.invalid", region: "us-east-1" })
    .returning();
  mailboxId = (
    await createMailboxRegistry(db, actor(), {
      domainId: domain!.id,
      localPart: "person",
      label: "Person",
      kind: "person",
      ownerUserId: "owner",
    })
  ).id;
  agentId = (
    await createMailboxRegistry(db, actor(), {
      domainId: domain!.id,
      localPart: "agent",
      label: "Agent",
      kind: "agent",
      ownerUserId: "owner",
    })
  ).id;
  keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
  vi.mocked(getKeyring).mockReturnValue(keys);
  vi.mocked(createContext).mockImplementation(async () => ctx());
});
afterEach(async () => {
  await client.close();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("Native server UI contract", () => {
  it("Cloud draft classification grants no dispatch or semantic approval", async () => {
    vi.stubEnv("IS_CLOUD", "true");
    const saved = await as().saveDraft(draft({ messageFormat: "plain_text" }));
    const item = await as().item({ mailboxId, id: saved.id });
    expect(item.draftMessageFormat).toBe("plain_text");
    expect(item.sendStatus).toBeNull();
    expect(await db.select().from(schema.mailboxOutbox)).toEqual([]);
  });

  it("tRPC preserves explicit format through persistence and authoritative readback", async () => {
    const saved = await as().saveDraft(draft({ messageFormat: "plain_text" }));
    const row = await readMailboxItem(db, keys, actor(), { mailboxId, id: saved.id });
    const mime = await simpleParser(row.raw, { skipTextToHtml: true });
    expect(mime.headers.get("content-type")).toMatchObject({ value: "text/plain" });
    expect(mime.html).toBe(false);
    expect(row.revision).toBe(saved.revision);
    const read = await as().item({ mailboxId, id: saved.id });
    expect(read.draftMessageFormat).toBe("plain_text");
    expect(read.revision).toBe(saved.revision);
    expect(read.text).toContain("Local reply");
    expect(read.to).toEqual(["reply@example.invalid"]);
    expect((await readMailboxItem(db, keys, actor(), { mailboxId, id: saved.id })).raw).toEqual(
      row.raw,
    );
  });
  it("preserves default formatted legacy editing, attachments and revision conflicts", async () => {
    const saved = await as().saveDraft(
      draft({ html: "<p>Legacy formatted</p>", uploads: [{ filename: "a.txt", base64: "YQ==" }] }),
    );
    const read = await as().item({ mailboxId, id: saved.id });
    expect(read.draftMessageFormat).toBe("formatted");
    expect(read.draftHtml).toContain("Legacy formatted");
    expect(read.attachments).toHaveLength(1);
    const edit = draft({
      id: saved.id,
      sourceItemId: saved.id,
      expectedRevision: saved.revision,
      html: "<p>Edited legacy</p>",
      retainedAttachments: [0],
    });
    const changed = await as().saveDraft(edit);
    expect(changed.revision).toBe(2);
    await expect(as().saveDraft(edit)).rejects.toMatchObject({ code: "CONFLICT" });
    const after = await as().item({ mailboxId, id: saved.id });
    expect(after.draftMessageFormat).toBe("formatted");
    expect(after.attachments).toHaveLength(1);
  });
  it("classifies missing, malformed, unsupported MIME as unknown without restamping", async () => {
    for (const body of [
      "\r\nLegacy body",
      "Content-Type: text/plain; broken\r\n\r\nBad",
      "Content-Type: application/octet-stream\r\n\r\nData",
      "Content-Type: text/plain\r\nContent-Type: text/html\r\n\r\nAmbiguous",
      "Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nTruncated",
    ]) {
      const raw = Buffer.from(
        "From: person@content.invalid\r\nTo: recipient@example.invalid\r\n" + body,
      );
      const saved = await saveMailboxDraft(db, keys, actor(), {
        mailboxId,
        expectedRevision: 0,
        raw,
      });
      expect((await as().item({ mailboxId, id: saved.id })).draftMessageFormat).toBe("unknown");
      const after = await readMailboxItem(db, keys, actor(), { mailboxId, id: saved.id });
      expect(after.raw).toEqual(raw);
      expect(after.revision).toBe(1);
    }
    const received = await imported();
    expect((await as().item({ mailboxId, id: received.id })).draftMessageFormat).toBeNull();
  });
  it("retains authenticated and cross-tenant fences and incompatible-format refusal", async () => {
    await expect(
      as("owner", { session: null }).saveDraft(draft({ messageFormat: "plain_text" })),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      as("owner", { teamId: otherTeam }).saveDraft(draft({ messageFormat: "plain_text" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      as().saveDraft(draft({ messageFormat: "plain_text", html: "" })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const saved = await as().saveDraft(draft());
    const before = await readMailboxItem(db, keys, actor(), { mailboxId, id: saved.id });
    await expect(
      as().saveDraft(
        draft({
          messageFormat: "plain_text",
          id: saved.id,
          sourceItemId: saved.id,
          expectedRevision: saved.revision,
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await readMailboxItem(db, keys, actor(), { mailboxId, id: saved.id })).raw).toEqual(
      before.raw,
    );
  });
});
