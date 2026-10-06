import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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
  sendMailboxOutbox,
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
import { getMailboxContent, getMailboxContentList } from "@/server/mailbox-content";
import { mailboxTransportMime } from "@/server/mailbox-transport";
import { mailboxesRouter } from "@/server/routers/mailboxes";
import { type Context, createCallerFactory, createContext, router } from "@/server/trpc";
import { seedMailboxTestService } from "./mailbox-service-fixture";

vi.mock("@/server/keyring", () => ({ getKeyring: vi.fn() }));
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
const folder = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
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
      for (const sql of readFileSync(folder + name, "utf8")
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

describe("session-authenticated mailbox content", () => {
  it("keeps Spam and quarantine out of Inbox and prevents unsafe reads, attachments and replies", async () => {
    await db
      .update(schema.domains)
      .set({ status: "verified" })
      .where(eq(schema.domains.teamId, teamId));
    const receipt = async (status: "PASS" | "FAIL", spam = "FAIL") =>
      receiveMailboxMime(
        db,
        keys,
        {
          sourceId: `safety:${status}`,
          recipients: ["person@content.invalid"],
          raw: mime(),
          assessment: assessMailboxReceipt({
            virusVerdict: { status },
            spamVerdict: { status: spam },
          }),
        },
        mailboxTransportMime,
      );
    const spam = (await receipt("PASS")).items[0]!;
    const blocked = (await receipt("FAIL")).items[0]!;
    expect((await as().items({ mailboxId: null, folder: "inbox" })).items).toHaveLength(0);
    expect((await as().items({ mailboxId: null, folder: "spam" })).items[0]).toMatchObject({
      id: spam.id,
      blocked: false,
    });
    const quarantine = await as().items({ mailboxId: null, folder: "quarantine" });
    expect(quarantine.items[0]).toMatchObject({
      id: blocked.id,
      blocked: true,
      subject: "",
      from: "",
      snippet: "",
      to: [],
      attachmentCount: 0,
      outboundSummary: null,
    });
    await expect(as().item({ mailboxId, id: blocked.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await download(blocked.id)).status).toBe(403);
    await expect(
      as().setDeliveryFolder({ mailboxId, id: blocked.id, expectedRevision: 1, folder: "inbox" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      as().saveDraft(draft({ sourceItemId: spam.id, mode: "forward" })),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const moved = await as().setDeliveryFolder({
      mailboxId,
      id: spam.id,
      expectedRevision: 1,
      folder: "inbox",
    });
    expect(moved).toMatchObject({ deliveryFolder: "inbox", revision: 2 });
    expect((await as().items({ mailboxId: null, folder: "inbox" })).items[0]?.id).toBe(spam.id);
    expect((await as().saveDraft(draft({ sourceItemId: spam.id, mode: "forward" }))).kind).toBe(
      "draft",
    );
  });
  it("filters mailbox kind before aggregating messages and reports only persisted send approval", async () => {
    await imported();
    await imported("agent:view", agentId);
    const agents = await as().items({ mailboxId: null, folder: "inbox", mailboxKind: "agent" });
    expect(agents.items).toHaveLength(1);
    expect(agents.items[0]).toMatchObject({
      mailboxId: agentId,
      mailboxKind: "agent",
      sentBy: null,
    });
    const { row } = await submittedSent();
    const item = await as().item({ mailboxId, id: row.id });
    expect(item.sentBy).toEqual({ kind: "human", label: null });
    expect(item.sendStatus).toBe("accepted");
  });
  it("unifies only readable boxes, with origin and bounded content DTOs", async () => {
    const a = await imported();
    await imported("agent:1", agentId);
    expect((await as().items({ mailboxId: null, folder: "inbox" })).items).toHaveLength(2);
    const single = await as().items({ mailboxId, folder: "inbox" });
    expect(single.items[0]).toMatchObject({
      id: a.id,
      mailboxId,
      address: "person@content.invalid",
      attachmentCount: 1,
    });
    expect(JSON.stringify(single)).not.toContain(png);
    expect((await as("admin").items({ mailboxId: null, folder: "inbox" })).items).toHaveLength(0);
    await expect(as("admin").item({ mailboxId, id: a.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      as("owner", { teamId: otherTeam }).item({ mailboxId, id: a.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("exposes text and attachment metadata without original HTML or binary payload", async () => {
    const a = await imported();
    const item = await as().item({ mailboxId, id: a.id });
    expect(item.text).toContain("<script>alert(1)</script>");
    expect(item).not.toHaveProperty("html");
    expect(item).not.toHaveProperty("raw");
    expect(item.attachments[0]).toMatchObject({
      filename: "private.png",
      image: { contentType: "image/png", width: 1, height: 1 },
    });
    const svg = await imported(
      "svg",
      mailboxId,
      mime(Buffer.from('<svg onload="alert(1)"></svg>'), "fake.png", "image/png"),
    );
    expect((await as().item({ mailboxId, id: svg.id })).attachments[0]?.image).toBeNull();
    expect((await download(svg.id, "0", mailboxId, "?preview=1")).status).toBe(404);
  });
  it("rechecks session, support, mailbox and revoked grants for every binary request", async () => {
    const a = await imported();
    vi.mocked(createContext).mockResolvedValue(ctx("owner", { session: null }));
    expect((await download(a.id)).status).toBe(401);
    vi.mocked(createContext).mockResolvedValue(
      ctx("owner", { supportView: { grantId: "support", expiresAt: new Date() } }),
    );
    expect((await download(a.id)).status).toBe(403);
    vi.mocked(createContext).mockResolvedValue(ctx("member"));
    expect((await download(a.id)).status).toBe(403);
    const grant = await grantMailboxRegistry(db, actor(), {
      mailboxId,
      userId: "member",
      permission: "read",
    });
    const response = await download(a.id);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(png, "base64"));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect((await download(a.id, "0", mailboxId, "?preview=1")).headers.get("content-type")).toBe(
      "image/png",
    );
    expect((await download(a.id, "../0")).status).toBe(404);
    expect((await download(a.id, "0", agentId)).status).toBe(403);
    await revokeMailboxRegistry(db, actor(), grant.id);
    expect((await download(a.id)).status).toBe(403);
  });
  it("captures delegated reply drafts with the mailbox sender, threading and retained/new attachments", async () => {
    const a = await imported();
    const grant = await grantMailboxRegistry(db, actor(), {
      mailboxId,
      userId: "member",
      permission: "read",
    });
    await expect(as("member").saveDraft(draft({ sourceItemId: a.id }))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await revokeMailboxRegistry(db, actor(), grant.id);
    await grantMailboxRegistry(db, actor(), { mailboxId, userId: "member", permission: "draft" });
    const saved = await as("member").saveDraft(
      draft({
        sourceItemId: a.id,
        retainedAttachments: [0],
        uploads: [
          { filename: "reply.txt", base64: Buffer.from("reply attachment").toString("base64") },
        ],
      }),
    );
    const raw = await readMailboxItem(db, keys, actor(), { mailboxId, id: saved.id });
    const parsed = await simpleParser(raw.raw);
    expect(parsed.from?.value[0]?.address).toBe("person@content.invalid");
    expect(parsed.inReplyTo).toBe("<original@example.invalid>");
    expect(parsed.references).toEqual(["<older@example.invalid>", "<original@example.invalid>"]);
    expect(parsed.attachments.map((v) => v.content)).toEqual([
      Buffer.from(png, "base64"),
      Buffer.from("reply attachment"),
    ]);
    expect((await as("member").items({ mailboxId: null, folder: "drafts" })).items[0]?.id).toBe(
      saved.id,
    );
    expect((await as().items({ mailboxId: null, folder: "sent" })).items).toHaveLength(0);
  });
  it("threads a follow-up to Sent with its observed final alias and blocks a pending alias instead of using submitted MIME headers", async () => {
    const { row, raw, sender } = await submittedSent({
      to: ["first@example.invalid", "second@example.invalid"],
      uploads: [
        { filename: "original.txt", base64: Buffer.from("original attachment").toString("base64") },
      ],
    });
    const captured = await simpleParser(raw);
    expect(await as().item({ mailboxId, id: row.id })).toMatchObject({
      messageId: captured.messageId,
      transportMessageId: null,
      replyToSentItemId: null,
      replyTo: "first@example.invalid, second@example.invalid",
    });
    await expect(as().saveDraft(draft({ sourceItemId: row.id }))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const alias = "<observed-final@email.amazonses.com>";
    await aliasEvidence(row, alias);
    const sentDetail = await as().item({ mailboxId, id: row.id });
    expect(sentDetail.transportMessageId).toBe(alias);
    const saved = await as().saveDraft(
      draft({ sourceItemId: row.id, to: sentDetail.replyTo.split(", "), retainedAttachments: [0] }),
    );
    const reply = await simpleParser(
      (await readMailboxItem(db, keys, actor(), { mailboxId, id: saved.id })).raw,
    );
    expect(reply.inReplyTo).toBe(alias);
    expect(reply.references).toBe(alias);
    expect(reply.messageId).not.toBe(captured.messageId);
    expect(reply.messageId).not.toBe(alias);
    expect(
      (Array.isArray(reply.to) ? reply.to : [reply.to!])
        .flatMap((entry) => entry.value)
        .map((entry) => entry.address),
    ).toEqual(["first@example.invalid", "second@example.invalid"]);
    expect(reply.attachments[0]!.content.toString()).toBe("original attachment");
    const updated = await as().saveDraft(
      draft({
        id: saved.id,
        sourceItemId: saved.id,
        expectedRevision: 1,
        text: "Follow-up edited",
      }),
    );
    const edited = await simpleParser(
      (await readMailboxItem(db, keys, actor(), { mailboxId, id: updated.id })).raw,
    );
    expect(edited.messageId).toBe(reply.messageId);
    expect(edited.inReplyTo).toBe(alias);
    expect(edited.references).toBe(alias);
    expect((await readMailboxItem(db, keys, actor(), { mailboxId, id: row.id })).raw).toEqual(raw);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("forwards authorized Inbox content and selected attachments in a new encrypted message without inherited thread headers", async () => {
    const sourceRaw = Buffer.from(
      mime()
        .toString()
        .replace("References:", "In-Reply-To: <direct@example.invalid>\r\nReferences:"),
    );
    const source = await imported("forward:inbox", mailboxId, sourceRaw);
    const saved = await as().saveDraft(
      draft({
        mode: "forward",
        sourceItemId: source.id,
        to: ["owner@example.invalid"],
        subject: "Fw: Private subject",
        text: "Private forwarded body",
        retainedAttachments: [0],
      }),
    );
    const raw = (await readMailboxItem(db, keys, actor(), { mailboxId, id: saved.id })).raw;
    const parsed = await simpleParser(raw);
    expect(parsed.from?.value[0]?.address).toBe("person@content.invalid");
    expect(parsed.subject).toBe("Fw: Private subject");
    expect(parsed.text).toContain("Private forwarded body");
    expect(parsed.messageId).toMatch(/^<[^<>]+@content\.invalid>$/);
    expect(parsed.messageId).not.toBe("<original@example.invalid>");
    expect(parsed.headers.has("in-reply-to")).toBe(false);
    expect(parsed.headers.has("references")).toBe(false);
    expect(parsed.attachments[0]?.content).toEqual(Buffer.from(png, "base64"));
    expect((await readMailboxItem(db, keys, actor(), { mailboxId, id: source.id })).raw).toEqual(
      sourceRaw,
    );
    const [stored] = await db
      .select()
      .from(schema.mailboxItems)
      .where(eq(schema.mailboxItems.id, saved.id));
    expect(stored?.ciphertext).not.toEqual(raw);
    expect(stored?.ciphertext.includes(Buffer.from("Private forwarded body"))).toBe(false);
    const updated = await as().saveDraft(
      draft({
        id: saved.id,
        sourceItemId: saved.id,
        expectedRevision: saved.revision,
        to: ["owner@example.invalid"],
        subject: "Fw: Private subject",
        text: "Edited forward",
        retainedAttachments: [0],
      }),
    );
    const edited = await simpleParser(
      (await readMailboxItem(db, keys, actor(), { mailboxId, id: updated.id })).raw,
    );
    expect(edited.messageId).toBe(parsed.messageId);
    expect(edited.headers.has("in-reply-to")).toBe(false);
    expect(edited.headers.has("references")).toBe(false);
    expect(edited.attachments[0]?.content).toEqual(Buffer.from(png, "base64"));
  });

  it("forwards Sent independently of its final SES alias and leaves the original send unchanged", async () => {
    const { row, raw, sender } = await submittedSent({
      uploads: [
        { filename: "sent.txt", base64: Buffer.from("Sent attachment").toString("base64") },
      ],
    });
    expect(row.providerRfcMessageId).toBeNull();
    const saved = await as().saveDraft(
      draft({
        mode: "forward",
        sourceItemId: row.id,
        to: ["owner@example.invalid"],
        retainedAttachments: [0],
      }),
    );
    const parsed = await simpleParser(
      (await readMailboxItem(db, keys, actor(), { mailboxId, id: saved.id })).raw,
    );
    expect(parsed.messageId).not.toBe((await simpleParser(raw)).messageId);
    expect(parsed.headers.has("in-reply-to")).toBe(false);
    expect(parsed.headers.has("references")).toBe(false);
    expect(parsed.attachments[0]?.content.toString()).toBe("Sent attachment");
    expect((await readMailboxItem(db, keys, actor(), { mailboxId, id: row.id })).raw).toEqual(raw);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it("requires current draft/read access to the exact source mailbox for forwarding", async () => {
    const source = await imported("forward:access");
    const input = draft({ mode: "forward", sourceItemId: source.id, retainedAttachments: [0] });
    await expect(as("admin").saveDraft(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as("owner", { teamId: otherTeam }).saveDraft(input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const readGrant = await grantMailboxRegistry(db, actor(), {
      mailboxId,
      userId: "member",
      permission: "read",
    });
    await expect(as("member").saveDraft(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await revokeMailboxRegistry(db, actor(), readGrant.id);
    const draftGrant = await grantMailboxRegistry(db, actor(), {
      mailboxId,
      userId: "member",
      permission: "draft",
    });
    expect(await as("member").saveDraft(input)).toMatchObject({ kind: "draft", mailboxId });
    await revokeMailboxRegistry(db, actor(), draftGrant.id);
    await expect(as("member").saveDraft(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      as().saveDraft(draft({ mode: "forward", mailboxId: agentId, sourceItemId: source.id })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects ambiguous forward sources and forward mode while editing an existing draft", async () => {
    const saved = await as().saveDraft(draft());
    await expect(as().saveDraft(draft({ mode: "forward" }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      as().saveDraft(draft({ mode: "forward", sourceItemId: saved.id })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      as().saveDraft(
        draft({
          mode: "forward",
          id: saved.id,
          sourceItemId: saved.id,
          expectedRevision: saved.revision,
        }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await readMailboxItem(db, keys, actor(), { mailboxId, id: saved.id })).revision).toBe(
      saved.revision,
    );
  });

  it("correlates response headers only to accepted Sent in the authorized RCPT mailbox, preferring the direct target then nearest reference", async () => {
    const first = await submittedSent();
    const second = await submittedSent();
    const firstAlias = "<first-final@email.amazonses.com>";
    const secondAlias = "<second-final@email.amazonses.com>";
    await aliasEvidence(first.row, firstAlias);
    await aliasEvidence(second.row, secondAlias);
    const raw = responseMime(secondAlias, [firstAlias]);
    const ingress = await receiveMailboxMime(
      db,
      keys,
      {
        sourceId: "trusted-reply:1",
        recipients: ["person@content.invalid"],
        raw,
      },
      mailboxTransportMime,
    );
    const received = ingress.items[0]!;
    expect(await as().item({ mailboxId, id: received.id })).toMatchObject({
      messageId: "<incoming@example.invalid>",
      transportMessageId: null,
      replyToSentItemId: second.row.id,
    });
    expect((await readMailboxItem(db, keys, actor(), { mailboxId, id: received.id })).raw).toEqual(
      raw,
    );
    const replay = await receiveMailboxMime(
      db,
      keys,
      {
        sourceId: "trusted-reply:1",
        recipients: ["person@content.invalid"],
        raw,
      },
      mailboxTransportMime,
    );
    expect(replay.items[0]).toMatchObject({ id: received.id, duplicate: true });
    const saved = await as().saveDraft(draft({ sourceItemId: received.id }));
    const reply = await simpleParser(
      (await readMailboxItem(db, keys, actor(), { mailboxId, id: saved.id })).raw,
    );
    expect(reply.inReplyTo).toBe("<incoming@example.invalid>");
    expect(reply.references).toEqual([firstAlias, secondAlias, "<incoming@example.invalid>"]);
    const fallback = await imported(
      "reply:fallback",
      mailboxId,
      responseMime("<unmatched@example.invalid>", [firstAlias, secondAlias]),
    );
    expect((await as().item({ mailboxId, id: fallback.id })).replyToSentItemId).toBe(second.row.id);
    const otherBox = await imported("reply:other-box", agentId, raw);
    expect((await as().item({ mailboxId: agentId, id: otherBox.id })).replyToSentItemId).toBeNull();
    await expect(as("member").item({ mailboxId, id: received.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      as("owner", { teamId: otherTeam }).item({ mailboxId, id: received.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const grant = await grantMailboxRegistry(db, actor(), {
      mailboxId,
      userId: "member",
      permission: "read",
    });
    expect((await as("member").item({ mailboxId, id: received.id })).replyToSentItemId).toBe(
      second.row.id,
    );
    await revokeMailboxRegistry(db, actor(), grant.id);
    await expect(as("member").item({ mailboxId, id: received.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("does not infer the final transport alias from captured or bare API reply headers", async () => {
    const { row, raw } = await submittedSent();
    const captured = await simpleParser(raw);
    for (const [index, id] of [captured.messageId!, row.providerMessageId!].entries()) {
      const incoming = await imported(`pending-alias:${index}`, mailboxId, responseMime(id));
      expect((await as().item({ mailboxId, id: incoming.id })).replyToSentItemId).toBeNull();
    }
    expect((await as().item({ mailboxId, id: row.id })).transportMessageId).toBeNull();
  });

  it("protects existing drafts from stale edits, foreign sources and inbox replacement", async () => {
    const a = await imported();
    const saved = await as().saveDraft(draft());
    const update = draft({
      id: saved.id,
      sourceItemId: saved.id,
      expectedRevision: 1,
      text: "New version",
    });
    expect((await as().saveDraft(update)).revision).toBe(2);
    await expect(as().saveDraft(update)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      as().saveDraft(draft({ id: saved.id, sourceItemId: a.id, expectedRevision: 2 })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      as().saveDraft(draft({ id: a.id, sourceItemId: a.id, expectedRevision: 1 })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      as().saveDraft(draft({ mailboxId: agentId, sourceItemId: saved.id })),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("reports acceptance for the exact submitted draft and sent copy without private outbox details", async () => {
    const { row } = await submittedSent();
    const submitted = await as().item({ mailboxId, id: row.draftId });
    expect(submitted.sendStatus).toBe("accepted");
    expect(submitted.revision).toBe(row.draftRevision);
    expect(submitted).not.toHaveProperty("providerMessageId");
    expect(submitted).not.toHaveProperty("attemptId");
    const sent = await as().item({ mailboxId, id: row.id });
    expect(sent.sendStatus).toBe("accepted");
    expect(sent.sentBy).toEqual({ kind: "human", label: null });
    expect(sent).not.toHaveProperty("providerMessageId");
    expect(sent).not.toHaveProperty("attemptId");
    expect(sent.outboundSummary).toEqual({
      totalRecipients: 1,
      delivered: 0,
      delayed: 0,
      hardBounce: 0,
      complaint: 0,
      softBounce: 0,
      rejected: 0,
      renderingFailed: 0,
      unconfirmed: 1,
      lastObservedAt: null,
    });
    expect(submitted.outboundSummary).toEqual(sent.outboundSummary);
    const listed = await as().items({ mailboxId, folder: "sent" });
    expect(listed.items[0]?.outboundSummary).toEqual(sent.outboundSummary);
    for (const result of [
      sent.outboundSummary,
      submitted.outboundSummary,
      listed.items[0]?.outboundSummary,
    ]) {
      expect(result).not.toHaveProperty("recipientHashes");
      expect(result).not.toHaveProperty("recipientHash");
      expect(result).not.toHaveProperty("outboxId");
      expect(result).not.toHaveProperty("attemptId");
      expect(result).not.toHaveProperty("messageId");
      expect(result).not.toHaveProperty("topicArn");
    }
    const inbox = await imported("status:inbox");
    const incoming = await as().item({ mailboxId, id: inbox.id });
    expect(incoming.sendStatus).toBeNull();
    expect(incoming.outboundSummary).toBeNull();
  });
  it("correlates live send status to the exact draft revision and mailbox while requiring current read access", async () => {
    await db
      .update(schema.domains)
      .set({ status: "verified" })
      .where(eq(schema.domains.teamId, teamId));
    const saved = await as().saveDraft(draft());
    const unsubmitted = await as().item({ mailboxId, id: saved.id });
    expect(unsubmitted.sendStatus).toBeNull();
    expect(unsubmitted.outboundSummary).toBeNull();
    const queued = await queueMailboxDraft(
      db,
      keys,
      actor(),
      { mailboxId, id: saved.id, expectedRevision: saved.revision },
      mailboxTransportMime,
    );
    const queuedContent = await as().item({ mailboxId, id: saved.id });
    expect(queuedContent.sendStatus).toBe("queued");
    expect(queuedContent.outboundSummary).toMatchObject({ delivered: 0, unconfirmed: 1 });
    await db
      .update(schema.mailboxOutbox)
      .set({ status: "sending", attemptId: randomUUID(), attemptedAt: new Date() })
      .where(eq(schema.mailboxOutbox.id, queued.id));
    expect((await as().item({ mailboxId, id: saved.id })).sendStatus).toBe("sending");
    for (const status of ["unknown", "failed"] as const) {
      await db
        .update(schema.mailboxOutbox)
        .set({ status })
        .where(eq(schema.mailboxOutbox.id, queued.id));
      expect((await as().item({ mailboxId, id: saved.id })).sendStatus).toBe(status);
    }
    const grant = await grantMailboxRegistry(db, actor(), {
      mailboxId,
      userId: "member",
      permission: "read",
    });
    expect((await as("member").item({ mailboxId, id: saved.id })).sendStatus).toBe("failed");
    await revokeMailboxRegistry(db, actor(), grant.id);
    await expect(as("member").item({ mailboxId, id: saved.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      as("owner", { teamId: otherTeam }).item({ mailboxId, id: saved.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as().item({ mailboxId: agentId, id: saved.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const otherDraft = await as().saveDraft(draft({ mailboxId: agentId }));
    expect((await as().item({ mailboxId: agentId, id: otherDraft.id })).sendStatus).toBeNull();
    const updated = await as().saveDraft(
      draft({
        id: saved.id,
        sourceItemId: saved.id,
        expectedRevision: saved.revision,
        text: "Next revision",
      }),
    );
    expect(updated.revision).toBe(saved.revision + 1);
    const nextRevision = await as().item({ mailboxId, id: saved.id });
    expect(nextRevision.sendStatus).toBeNull();
    expect(nextRevision.outboundSummary).toBeNull();
  });
  it("exposes only scoped recipient counts for partial, replayed and negative facts under live mailbox access", async () => {
    const { row } = await submittedSent({
      to: [
        "one@example.invalid",
        "two@example.invalid",
        "three@example.invalid",
        "four@example.invalid",
      ],
    });
    const hashes = row.recipientHashes!;
    expect(hashes).toHaveLength(4);
    await resultEvidence(row, "delivered", [hashes[0]!], "synthetic-delivery");
    await resultEvidence(row, "delivered", [hashes[0]!], "synthetic-delivery");
    await resultEvidence(row, "delayed", [hashes[1]!], "synthetic-delay");
    const partial = await as().item({ mailboxId, id: row.id });
    expect(partial.sendStatus).toBe("accepted");
    expect(partial.outboundSummary).toMatchObject({
      totalRecipients: 4,
      delivered: 1,
      delayed: 1,
      unconfirmed: 2,
    });
    expect(partial.transportMessageId).toBeNull();
    await resultEvidence(row, "complaint", [hashes[0]!], "synthetic-complaint");
    await resultEvidence(row, "hard_bounce", [hashes[2]!], "synthetic-bounce");
    const sent = await as().item({ mailboxId, id: row.id });
    expect(sent.outboundSummary).toEqual({
      totalRecipients: 4,
      delivered: 0,
      delayed: 1,
      hardBounce: 1,
      complaint: 1,
      softBounce: 0,
      rejected: 0,
      renderingFailed: 0,
      unconfirmed: 1,
      lastObservedAt: new Date("2026-10-04T12:00:00Z"),
    });
    const submitted = await as().item({ mailboxId, id: row.draftId });
    const listed = await as().items({ mailboxId: null, folder: "sent" });
    expect(submitted.outboundSummary).toEqual(sent.outboundSummary);
    expect(listed.items.find((item) => item.id === row.id)?.outboundSummary).toEqual(
      sent.outboundSummary,
    );
    const publicSummary = JSON.stringify(sent.outboundSummary);
    for (const privateValue of [...hashes, row.attemptId!, row.id, row.providerMessageId!])
      expect(publicSummary).not.toContain(privateValue);
    expect(Object.keys(sent.outboundSummary!).sort()).toEqual(
      [
        "totalRecipients",
        "delivered",
        "delayed",
        "hardBounce",
        "complaint",
        "softBounce",
        "rejected",
        "renderingFailed",
        "unconfirmed",
        "lastObservedAt",
      ].sort(),
    );
    const grant = await grantMailboxRegistry(db, actor(), {
      mailboxId,
      userId: "member",
      permission: "read",
    });
    expect((await as("member").item({ mailboxId, id: row.id })).outboundSummary).toEqual(
      sent.outboundSummary,
    );
    await revokeMailboxRegistry(db, actor(), grant.id);
    await expect(as("member").item({ mailboxId, id: row.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(as("admin").item({ mailboxId, id: row.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      as("owner", { teamId: otherTeam }).item({ mailboxId, id: row.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as().item({ mailboxId: agentId, id: row.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const otherDraft = await as().saveDraft(draft({ mailboxId: agentId }));
    expect((await as().item({ mailboxId: agentId, id: otherDraft.id })).outboundSummary).toBeNull();
    const changed = await as().saveDraft(
      draft({
        id: row.draftId,
        sourceItemId: row.draftId,
        expectedRevision: row.draftRevision,
        text: "New version, not this send",
      }),
    );
    expect((await as().item({ mailboxId, id: changed.id })).outboundSummary).toBeNull();
    expect((await as().item({ mailboxId, id: row.id })).outboundSummary).toEqual(
      sent.outboundSummary,
    );
  });
  it("does not regress delivered recipients when older delay or soft-bounce facts arrive later", async () => {
    const { row } = await submittedSent({ to: ["one@example.invalid", "two@example.invalid"] });
    const recipient = row.recipientHashes![0]!;
    await resultEvidence(row, "delivered", [recipient], "delivery-first");
    await resultEvidence(
      row,
      "delayed",
      [recipient],
      "old-delay-later",
      new Date("2026-10-04T11:00:00Z"),
      new Date("2026-10-04T13:00:00Z"),
    );
    await resultEvidence(
      row,
      "soft_bounce",
      [recipient],
      "old-soft-bounce-later",
      new Date("2026-10-04T11:30:00Z"),
      new Date("2026-10-04T14:00:00Z"),
    );
    const sent = await as().item({ mailboxId, id: row.id });
    expect(sent.outboundSummary).toMatchObject({
      totalRecipients: 2,
      delivered: 1,
      delayed: 0,
      softBounce: 0,
      unconfirmed: 1,
      lastObservedAt: new Date("2026-10-04T14:00:00Z"),
    });
    expect(sent.transportMessageId).toBeNull();
    const inbox = await imported("private-results:inbox");
    expect((await as().item({ mailboxId, id: inbox.id })).outboundSummary).toBeNull();
  });
  it("binds attachment downloads to the revision the reader saw", async () => {
    const saved = await as().saveDraft(
      draft({
        uploads: [
          { filename: "first.txt", base64: Buffer.from("first version").toString("base64") },
        ],
      }),
    );
    expect((await download(saved.id)).status).toBe(200);
    const updated = await as().saveDraft(
      draft({
        id: saved.id,
        sourceItemId: saved.id,
        expectedRevision: 1,
        uploads: [
          { filename: "second.txt", base64: Buffer.from("second version").toString("base64") },
        ],
      }),
    );
    expect(updated.revision).toBe(2);
    expect((await download(saved.id)).status).toBe(409);
    expect(
      Buffer.from(await (await download(saved.id, "0", mailboxId, "", 2)).arrayBuffer()).toString(),
    ).toBe("second version");
  });
  it("rejects header injection, malformed attachment bytes and attachment overflow", async () => {
    await expect(
      as().saveDraft(draft({ subject: "Hi\r\nBcc: other@example.invalid" })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      as().saveDraft(draft({ uploads: [{ filename: "file", base64: "not+base64" }] })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(as().saveDraft(draft({ retainedAttachments: [0] }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const a = await imported(
      "oversize",
      mailboxId,
      mime(Buffer.alloc(256 * 1024 + 1), "large.bin"),
    );
    await expect(as().item({ mailboxId, id: a.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await download(a.id)).status).toBe(422);
  });
  it("soft-trashes and restores through the API with private atomic audit and no changed MIME", async () => {
    const item = await imported();
    const before = (await readMailboxItem(db, keys, actor(), { mailboxId, id: item.id })).raw;
    const moved = await as().setTrash({
      mailboxId,
      id: item.id,
      expectedRevision: 1,
      trashed: true,
    });
    expect(moved).toMatchObject({
      revision: 2,
      changed: true,
      kind: "inbox",
      deliveryFolder: "inbox",
    });
    expect(moved.trashedAt).toBeInstanceOf(Date);
    expect((await as().items({ mailboxId, folder: "inbox" })).items).toHaveLength(0);
    expect((await as().items({ mailboxId, folder: "trash" })).items[0]).toMatchObject({
      id: item.id,
      trashedAt: moved.trashedAt,
    });
    await expect(as().saveDraft(draft({ sourceItemId: item.id }))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      as().saveDraft(draft({ sourceItemId: item.id, mode: "forward" })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      as().setTrash({ mailboxId, id: item.id, expectedRevision: 1, trashed: false }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await as().setTrash({ mailboxId, id: item.id, expectedRevision: 2, trashed: false });
    expect((await readMailboxItem(db, keys, actor(), { mailboxId, id: item.id })).raw).toEqual(
      before,
    );
    const restored = await as().item({ mailboxId, id: item.id });
    expect(restored).toMatchObject({ trashedAt: null, revision: 3 });
    const followup = await as().saveDraft(draft({ sourceItemId: item.id }));
    const reply = await simpleParser(
      (await readMailboxItem(db, keys, actor(), { mailboxId, id: followup.id })).raw,
    );
    expect(reply.inReplyTo).toBe("<original@example.invalid>");
    expect(reply.references).toEqual(["<older@example.invalid>", "<original@example.invalid>"]);
    const audit = await db.select().from(schema.auditLog);
    expect(
      audit.filter((row) => ["mailbox.item_trashed", "mailbox.item_restored"].includes(row.action)),
    ).toHaveLength(2);
    expect(JSON.stringify(audit.map((row) => row.data))).not.toContain("Private body");
  });
  it("does not expose quarantined bytes in trash and restores their original safety classification", async () => {
    const item = await imported();
    const assessment = {
      version: 1 as const,
      decision: "quarantine" as const,
      verdicts: {
        virus: "FAIL" as const,
        spam: "PASS" as const,
        spf: "PASS" as const,
        dkim: "PASS" as const,
        dmarc: "PASS" as const,
      },
      dmarcPolicy: null,
      reasons: ["virus" as const],
    };
    await db
      .update(schema.mailboxItems)
      .set({ deliveryFolder: "quarantine", inboundAssessment: assessment })
      .where(eq(schema.mailboxItems.id, item.id));
    await as().setTrash({ mailboxId, id: item.id, expectedRevision: 1, trashed: true });
    expect((await as().items({ mailboxId, folder: "trash" })).items[0]).toMatchObject({
      blocked: true,
      subject: "",
      snippet: "",
      attachmentCount: 0,
      deliveryFolder: "quarantine",
    });
    await expect(as().item({ mailboxId, id: item.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await as().setTrash({ mailboxId, id: item.id, expectedRevision: 2, trashed: false });
    expect((await as().items({ mailboxId, folder: "quarantine" })).items[0]).toMatchObject({
      blocked: true,
      deliveryFolder: "quarantine",
    });
    await expect(as().item({ mailboxId, id: item.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
  it("rolls back a soft move when its private audit append fails", async () => {
    const item = await imported();
    await client.exec(
      "CREATE FUNCTION reject_trash_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'mailbox.item_trashed' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_trash_audit_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_trash_audit_fixture();",
    );
    await expect(
      as().setTrash({ mailboxId, id: item.id, expectedRevision: 1, trashed: true }),
    ).rejects.toThrow();
    const [retained] = await db
      .select()
      .from(schema.mailboxItems)
      .where(eq(schema.mailboxItems.id, item.id));
    expect(retained).toMatchObject({ revision: 1, trashedAt: null });
  });
  it("exposes the safe HTML signature projection while preserving plaintext and captured MIME", async () => {
    const raw = Buffer.from(
      "From: sender@example.invalid\r\nTo: person@content.invalid\r\nMessage-ID: <rich@example.invalid>\r\nSubject: Rich fixture\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary=rich\r\n\r\n--rich\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOiii\r\n--\r\n--rich\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Oiii</p><p>Fixture Signature</p><script>alert(1)</script>\r\n--rich--\r\n",
    );
    const item = await imported("fixture:rich", mailboxId, raw);
    const detail = await as().item({ mailboxId, id: item.id });
    expect(detail.hasHtmlBody).toBe(true);
    expect(detail.text).not.toContain("Fixture Signature");
    expect(detail.htmlBody).toContain("Fixture Signature");
    expect(detail.htmlBody).not.toContain("script");
    expect((await readMailboxItem(db, keys, actor(), { mailboxId, id: item.id })).raw).toEqual(raw);
  });
  it("persists favorites and named folders through authenticated routes and restores ordinary placement on archive", async () => {
    const item = await imported("fixture:organized");
    const folder = await as().createFolder({ mailboxId, name: "Leads Luna" });
    await as().setStar({ mailboxId, id: item.id, expectedRevision: 1, starred: true });
    await as().setItemFolder({ mailboxId, id: item.id, expectedRevision: 2, folderId: folder.id });
    expect((await as().folders({ mailboxId }))[0]).toMatchObject({
      id: folder.id,
      name: "Leads Luna",
      revision: 1,
    });
    expect((await as().items({ mailboxId, folder: "inbox" })).items).toEqual([]);
    expect((await as().items({ mailboxId: null, folder: "favorites" })).items[0]).toMatchObject({
      id: item.id,
      folderId: folder.id,
      revision: 3,
    });
    expect(
      (await as().items({ mailboxId, folder: "custom", customFolderId: folder.id })).items[0],
    ).toMatchObject({ id: item.id, folderId: folder.id, blocked: false });
    expect((await as().item({ mailboxId, id: item.id })).starredAt).toBeInstanceOf(Date);
    const renamed = await as().updateFolder({
      mailboxId,
      id: folder.id,
      expectedRevision: 1,
      name: "Respondidos",
    });
    expect(renamed).toMatchObject({ revision: 2, name: "Respondidos" });
    await as().archiveFolder({ mailboxId, id: folder.id, expectedRevision: 2 });
    expect(await as().folders({ mailboxId })).toEqual([]);
    expect((await as().items({ mailboxId, folder: "inbox" })).items[0]).toMatchObject({
      id: item.id,
      folderId: null,
      revision: 4,
    });
    await expect(
      as().items({ mailboxId, folder: "custom", customFolderId: folder.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const activity = await as().activity({ mailboxId });
    expect(activity.items.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "mailbox.folder_created",
        "mailbox.folder_renamed",
        "mailbox.folder_archived",
        "mailbox.item_starred",
        "mailbox.item_folder_changed",
      ]),
    );
    expect(JSON.stringify(activity)).not.toContain("Leads Luna");
    expect((await readMailboxItem(db, keys, actor(), { mailboxId, id: item.id })).raw).toEqual(
      mime(),
    );
  });
  it("preserves existing bearer Inbox discovery and direct reads after a human files an agent message", async () => {
    const item = await imported("fixture:filed-agent", agentId);
    const folder = await as().createFolder({ mailboxId: agentId, name: "Agent leads" });
    await as().setItemFolder({
      mailboxId: agentId,
      id: item.id,
      expectedRevision: 1,
      folderId: folder.id,
    });
    const key = await createMailboxAgentKey(db, actor(), {
      mailboxId: agentId,
      label: "Synthetic read client",
      scopes: ["read"],
    });
    const agentList = () =>
      withMailboxAgentAccess(db, key.token, "read", ({ db: tx, actor: bearer, mailboxId: box }) =>
        getMailboxContentList(tx, bearer, { mailboxId: box, folder: "inbox" }),
      );
    const agentRead = () =>
      withMailboxAgentAccess(db, key.token, "read", ({ db: tx, actor: bearer, mailboxId: box }) =>
        getMailboxContent(tx, bearer, { mailboxId: box, id: item.id }),
      );
    expect((await as().items({ mailboxId: agentId, folder: "inbox" })).items).toEqual([]);
    expect(
      (await as().items({ mailboxId: agentId, folder: "custom", customFolderId: folder.id }))
        .items[0],
    ).toMatchObject({ id: item.id, folderId: folder.id });
    expect((await agentList()).items[0]).toMatchObject({
      id: item.id,
      folderId: folder.id,
      revision: 2,
      subject: "Private subject",
    });
    expect(await agentRead()).toMatchObject({
      id: item.id,
      text: expect.stringContaining("Private body <script>alert(1)</script>"),
      revision: 2,
    });
    await as().setDeliveryFolder({
      mailboxId: agentId,
      id: item.id,
      expectedRevision: 2,
      folder: "spam",
    });
    expect((await agentList()).items).toEqual([]);
    await expect(agentRead()).rejects.toMatchObject({ code: "forbidden" });
    await as().setDeliveryFolder({
      mailboxId: agentId,
      id: item.id,
      expectedRevision: 3,
      folder: "inbox",
    });
    await as().setTrash({ mailboxId: agentId, id: item.id, expectedRevision: 4, trashed: true });
    expect((await agentList()).items).toEqual([]);
    await expect(agentRead()).rejects.toMatchObject({ code: "forbidden" });
  });
  it("keeps named folders and favorite writes behind live owner ACL with per-box IDs", async () => {
    const item = await imported();
    const folder = await as().createFolder({ mailboxId: agentId, name: "Agent leads" });
    await expect(as("admin").folders({ mailboxId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await grantMailboxRegistry(db, actor(), { mailboxId, userId: "member", permission: "draft" });
    expect(await as("member").folders({ mailboxId })).toEqual([]);
    await expect(
      as("member").createFolder({ mailboxId, name: "Unauthorized" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      as("member").setStar({ mailboxId, id: item.id, expectedRevision: 1, starred: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      as().setItemFolder({ mailboxId, id: item.id, expectedRevision: 1, folderId: folder.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      as().items({ mailboxId: null, folder: "custom", customFolderId: folder.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      as().items({ mailboxId, folder: "inbox", customFolderId: folder.id }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("does not let favorites and custom filters bypass later Spam or quarantine classification", async () => {
    const item = await imported();
    const folder = await as().createFolder({ mailboxId, name: "Private" });
    await as().setStar({ mailboxId, id: item.id, expectedRevision: 1, starred: true });
    await as().setItemFolder({ mailboxId, id: item.id, expectedRevision: 2, folderId: folder.id });
    await as().setDeliveryFolder({ mailboxId, id: item.id, expectedRevision: 3, folder: "spam" });
    expect((await as().items({ mailboxId, folder: "favorites" })).items).toEqual([]);
    expect(
      (await as().items({ mailboxId, folder: "custom", customFolderId: folder.id })).items,
    ).toEqual([]);
    expect((await as().items({ mailboxId, folder: "spam" })).items).toHaveLength(1);
    await db
      .update(schema.mailboxItems)
      .set({
        deliveryFolder: "quarantine",
        inboundAssessment: assessMailboxReceipt({
          virusVerdict: { status: "FAIL" },
          spamVerdict: { status: "PASS" },
        }),
      })
      .where(eq(schema.mailboxItems.id, item.id));
    expect((await as().items({ mailboxId, folder: "favorites" })).items).toEqual([]);
    expect(
      (await as().items({ mailboxId, folder: "custom", customFolderId: folder.id })).items,
    ).toEqual([]);
    await expect(
      as().setItemFolder({ mailboxId, id: item.id, expectedRevision: 4, folderId: null }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as().item({ mailboxId, id: item.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
  it("rolls back favorite metadata when its private activity append fails", async () => {
    const item = await imported();
    await client.exec(
      "CREATE FUNCTION reject_star_audit_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'mailbox.item_starred' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_star_audit_fixture BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_star_audit_fixture();",
    );
    await expect(
      as().setStar({ mailboxId, id: item.id, expectedRevision: 1, starred: true }),
    ).rejects.toThrow();
    const [retained] = await db
      .select()
      .from(schema.mailboxItems)
      .where(eq(schema.mailboxItems.id, item.id));
    expect(retained).toMatchObject({ revision: 1, starredAt: null });
  });
  it("keeps the content feature off and refuses unauthenticated/support router calls", async () => {
    const a = await imported();
    vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "0");
    await expect(as().item({ mailboxId, id: a.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await download(a.id)).status).toBe(404);
    vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
    await expect(
      as("owner", { session: null }).item({ mailboxId, id: a.id }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      as("owner", { supportView: { grantId: "support", expiresAt: new Date() } }).item({
        mailboxId,
        id: a.id,
      }),
    ).rejects.toThrow();
  });
});
