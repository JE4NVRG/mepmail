import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  acceptMailboxOutbox,
  createMailboxRegistry,
  EnvKeyring,
  grantMailboxRegistry,
  importMailboxMime,
  queueMailboxDraft,
  readMailboxItem,
  receiveMailboxMime,
  revokeMailboxRegistry,
  sendMailboxOutbox,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { simpleParser } from "mailparser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/mailboxes/[mailboxId]/items/[id]/attachments/[index]/route";
import { getKeyring } from "@/server/keyring";
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
  for (const name of readdirSync(folder)
    .filter((n) => n.endsWith(".sql") && n.slice(0, 4) <= "0042")
    .sort())
    for (const sql of readFileSync(folder + name, "utf8")
      .split("--> statement-breakpoint")
      .filter((s) => s.trim()))
      await client.exec(sql);
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
