import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  createMailboxRegistry,
  EnvKeyring,
  grantMailboxRegistry,
  importMailboxMime,
  readMailboxItem,
  revokeMailboxRegistry,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { simpleParser } from "mailparser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/mailboxes/[mailboxId]/items/[id]/attachments/[index]/route";
import { getKeyring } from "@/server/keyring";
import { mailboxesRouter } from "@/server/routers/mailboxes";
import { type Context, createCallerFactory, createContext, router } from "@/server/trpc";

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
