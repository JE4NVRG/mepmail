import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import {
  assessMailboxReceipt,
  createMailboxAgentKey,
  createMailboxRegistry,
  createMailboxTeamAgentKey,
  EnvKeyring,
  receiveMailboxMime,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { simpleParser } from "mailparser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedMailboxTestService } from "./mailbox-service-fixture";

// Real database, private store, MIME builder and the real public agent routes.
const h = vi.hoisted(() => ({ db: null as unknown, keys: null as unknown }));
vi.mock("@millionsend/db", async (original) => ({
  ...(await original<typeof import("@millionsend/db")>()),
  getDb: () => h.db,
}));
vi.mock("@/server/keyring", () => ({ getKeyring: () => h.keys }));
vi.mock("@/server/mailbox-search-key", () => ({ mailboxSearchKey: () => null }));
vi.mock("@/server/mailbox-sender-key", () => ({ mailboxSenderHmacKey: () => null }));

const { GET: itemsGet } = await import("@/app/api/mailbox-agent/items/route");
const { GET: attachmentGet } = await import("@/app/api/mailbox-agent/attachments/route");
const { POST: draftsPost } = await import("@/app/api/mailbox-agent/drafts/route");

const base = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const mail = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
let client: PGlite, db: Db, teamId: string, foreignTeamId: string;
let token: string, foreignToken: string;
const keys = new EnvKeyring(new Map([[1, randomBytes(32)]]), 1);
const owner = () => ({ teamId, userId: "owner" });
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fileA = randomBytes(3000);
const fileB = randomBytes(5000);
const bigFile = randomBytes(300 * 1024);

const headers = (mailbox: string, bearer = token) => ({
  authorization: `Bearer ${bearer}`,
  "mepmail-mailbox": mailbox,
});
async function read(id: string, mailbox = "a@att.invalid", bearer = token) {
  const res = await itemsGet(
    new Request(`http://localhost/api/mailbox-agent/items?id=${id}`, {
      headers: headers(mailbox, bearer),
    }),
  );
  return {
    status: res.status,
    body: (await res.json()) as {
      id: string;
      revision: number;
      attachments: { index: number; filename: string; bytes: number }[];
    },
  };
}
async function download(
  q: { id: string; revision: number; index: number },
  mailbox = "a@att.invalid",
  bearer = token,
) {
  const res = await attachmentGet(
    new Request(
      `http://localhost/api/mailbox-agent/attachments?id=${q.id}&revision=${q.revision}&index=${q.index}`,
      { headers: headers(mailbox, bearer) },
    ),
  );
  return {
    status: res.status,
    bytes: res.ok ? new Uint8Array(await res.arrayBuffer()) : null,
    sha: res.headers.get("x-mepmail-attachment-sha256"),
    disposition: res.headers.get("content-disposition"),
    type: res.headers.get("content-type"),
  };
}
async function draft(body: Record<string, unknown>, mailbox = "a@att.invalid") {
  const res = await draftsPost(
    new Request("http://localhost/api/mailbox-agent/drafts", {
      method: "POST",
      headers: { ...headers(mailbox), "content-type": "application/json" },
      body: JSON.stringify({
        to: ["someone@example.com"],
        subject: "Anexos",
        text: "Segue.",
        retainedAttachments: [],
        uploads: [],
        ...body,
      }),
    }),
  );
  return { status: res.status, body: (await res.json()) as { id: string; revision: number } };
}
const mime: Parameters<typeof receiveMailboxMime>[3] = {
  async parse(raw) {
    const parsed = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true });
    return {
      from: parsed.from?.value[0]?.address ?? "",
      to: ["a@att.invalid"],
      cc: [],
      bcc: [],
      attachmentBytes: parsed.attachments.map((a) => a.content.length),
    };
  },
};
function received(files: { name: string; bytes: Buffer }[]) {
  const parts = files
    .map(
      (f) =>
        `--b\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="${f.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${f.bytes.toString("base64").replace(/.{76}/g, "$&\r\n")}\r\n`,
    )
    .join("");
  return Buffer.from(
    `From: cliente@example.com\r\nTo: a@att.invalid\r\nSubject: Documentos\r\nMessage-ID: <docs-${randomBytes(4).toString("hex")}@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nVeja os anexos.\r\n${parts}--b--\r\n`,
  );
}
async function receive(files: { name: string; bytes: Buffer }[], virus: "PASS" | "FAIL" = "PASS") {
  const result = await receiveMailboxMime(
    db,
    keys,
    {
      sourceId: `att:${randomBytes(6).toString("hex")}`,
      recipients: ["a@att.invalid"],
      raw: received(files),
      assessment: assessMailboxReceipt({
        virusVerdict: { status: virus },
        spamVerdict: { status: "PASS" },
      }),
    },
    mime,
  );
  return result.items[0]!.id;
}

beforeEach(async () => {
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  vi.stubEnv("MAILBOX_AGENT_RATE_LIMIT_PER_MINUTE", "100000");
  vi.stubEnv("MASTER_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  client = new PGlite();
  for (const name of readdirSync(base)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    await client.transaction(async (tx) => {
      for (const statement of readFileSync(base + name, "utf8")
        .split("--> statement-breakpoint")
        .filter((part) => part.trim()))
        await tx.exec(statement);
    });
  const database = drizzle(client, { schema });
  db = database as unknown as Db;
  h.db = db;
  h.keys = keys;
  await migrate(database, { migrationsFolder: mail, migrationsTable: "__mailbox_migrations" });
  const teams = await db
    .insert(schema.teams)
    .values([
      { name: "Att", slug: "att" },
      { name: "Other", slug: "att-other" },
    ])
    .returning();
  teamId = teams[0]!.id;
  foreignTeamId = teams[1]!.id;
  await seedMailboxTestService(db, [teamId, foreignTeamId]);
  for (const id of ["owner", "foreign"])
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.invalid`, emailVerified: true });
  await db.insert(schema.teamMembers).values([
    { teamId, userId: "owner", role: "owner" },
    { teamId: foreignTeamId, userId: "foreign", role: "owner" },
  ]);
  const domains = await db
    .insert(schema.domains)
    .values([
      { teamId, name: "att.invalid", region: "us-east-1", status: "verified" },
      {
        teamId: foreignTeamId,
        name: "att-foreign.invalid",
        region: "us-east-1",
        status: "verified",
      },
    ])
    .returning();
  const box = async (actor: { teamId: string; userId: string }, domainId: string, local: string) =>
    (
      await createMailboxRegistry(db, actor, {
        domainId,
        localPart: local,
        label: local,
        kind: "person",
        ownerUserId: actor.userId,
      })
    ).id;
  const boxA = await box(owner(), domains[0]!.id, "a");
  const boxB = await box(owner(), domains[0]!.id, "b");
  const foreignBox = await box({ teamId: foreignTeamId, userId: "foreign" }, domains[1]!.id, "x");
  token = (
    await createMailboxTeamAgentKey(db, owner(), {
      label: "Docs agent",
      mailboxIds: [boxA, boxB],
      scopes: ["read", "draft"],
    })
  ).token;
  foreignToken = (
    await createMailboxAgentKey(
      db,
      { teamId: foreignTeamId, userId: "foreign" },
      {
        mailboxId: foreignBox,
        label: "Foreign",
      },
    )
  ).token;
});
afterEach(async () => {
  await client.close();
  vi.unstubAllEnvs();
});

describe("agent attachments", () => {
  it("downloads a received attachment byte for byte, bound to its message revision", async () => {
    const id = await receive([
      { name: "contrato.pdf", bytes: fileA },
      { name: "planilha.xlsx", bytes: fileB },
    ]);
    const message = await read(id);
    expect(message.status).toBe(200);
    expect(message.body.attachments.map((a) => [a.index, a.filename, a.bytes])).toEqual([
      [0, "contrato.pdf", 3000],
      [1, "planilha.xlsx", 5000],
    ]);
    const revision = message.body.revision;
    const second = await download({ id, revision, index: 1 });
    expect(second).toMatchObject({
      status: 200,
      type: "application/octet-stream",
      sha: sha(fileB),
    });
    expect(Buffer.from(second.bytes!).equals(fileB)).toBe(true);
    expect(second.disposition).toContain("planilha.xlsx");
    // Another revision or index is never another file.
    expect((await download({ id, revision: revision + 1, index: 1 })).status).toBe(409);
    expect((await download({ id, revision, index: 7 })).status).toBe(404);
    expect(
      (
        await attachmentGet(
          new Request(
            `http://localhost/api/mailbox-agent/attachments?id=${id}&revision=1&index=x`,
            { headers: headers("a@att.invalid") },
          ),
        )
      ).status,
    ).toBe(400);
  });

  it("keeps attachments inside the mailbox and the tenant, and never serves quarantine", async () => {
    const id = await receive([{ name: "a.pdf", bytes: fileA }]);
    const { revision } = (await read(id)).body;
    // The same id through another mailbox of the credential, or another tenant's key.
    expect((await download({ id, revision, index: 0 }, "b@att.invalid")).status).toBe(404);
    expect(
      (await download({ id, revision, index: 0 }, "x@att-foreign.invalid", foreignToken)).status,
    ).toBe(404);
    expect((await download({ id, revision, index: 0 }, "a@att.invalid", foreignToken)).status).toBe(
      403,
    );
    const held = await receive([{ name: "virus.exe", bytes: fileB }], "FAIL");
    expect([403, 404]).toContain((await download({ id: held, revision: 1, index: 0 })).status);
    expect([403, 404]).toContain((await read(held)).status);
  });

  it("composes, edits and forwards with exactly the files chosen", async () => {
    // New draft with two uploads.
    const created = await draft({
      expectedRevision: 0,
      uploads: [
        { filename: "a.bin", base64: fileA.toString("base64") },
        { filename: "b.bin", base64: fileB.toString("base64") },
      ],
    });
    expect(created.status).toBe(200);
    const first = await read(created.body.id);
    expect(first.body.attachments.map((a) => [a.filename, a.bytes])).toEqual([
      ["a.bin", 3000],
      ["b.bin", 5000],
    ]);
    // Edit keeping only b, as its own source.
    const edited = await draft({
      id: created.body.id,
      sourceItemId: created.body.id,
      expectedRevision: first.body.revision,
      text: "Só o segundo.",
      retainedAttachments: [1],
    });
    expect(edited.status).toBe(200);
    const after = await read(created.body.id);
    expect(after.body.attachments.map((a) => a.filename)).toEqual(["b.bin"]);
    const kept = await download({ id: created.body.id, revision: after.body.revision, index: 0 });
    expect(kept.sha).toBe(sha(fileB));
    // A stale edit is refused and leaves the draft's files as they were.
    expect(
      (
        await draft({
          id: created.body.id,
          sourceItemId: created.body.id,
          expectedRevision: first.body.revision,
          retainedAttachments: [],
        })
      ).status,
    ).toBe(409);
    expect((await read(created.body.id)).body.attachments.map((a) => a.filename)).toEqual([
      "b.bin",
    ]);
    // Forward a received message keeping its second file and adding one.
    const inbound = await receive([
      { name: "um.pdf", bytes: fileA },
      { name: "dois.pdf", bytes: fileB },
    ]);
    const extra = randomBytes(700);
    const forwarded = await draft({
      expectedRevision: 0,
      sourceItemId: inbound,
      mode: "forward",
      retainedAttachments: [1],
      uploads: [{ filename: "nota.txt", base64: extra.toString("base64") }],
    });
    expect(forwarded.status).toBe(200);
    const fwd = await read(forwarded.body.id);
    expect(fwd.body.attachments.map((a) => [a.filename, a.bytes])).toEqual([
      ["dois.pdf", 5000],
      ["nota.txt", 700],
    ]);
    const shas = await Promise.all(
      [0, 1].map(
        async (index) =>
          (await download({ id: forwarded.body.id, revision: fwd.body.revision, index })).sha,
      ),
    );
    expect(shas).toEqual([sha(fileB), sha(extra)]);
  });

  it("refuses files over the limits and sources from another mailbox", async () => {
    const tooBig = await draft({
      expectedRevision: 0,
      uploads: [{ filename: "big.bin", base64: bigFile.toString("base64") }],
    });
    expect([400, 413]).toContain(tooBig.status);
    const many = await draft({
      expectedRevision: 0,
      uploads: Array.from({ length: 11 }, (_, i) => ({
        filename: `${i}.txt`,
        base64: Buffer.from("x").toString("base64"),
      })),
    });
    expect(many.status).toBe(400);
    const inbound = await receive([{ name: "grande.zip", bytes: bigFile }]);
    expect(
      (
        await draft({
          expectedRevision: 0,
          sourceItemId: inbound,
          mode: "forward",
          retainedAttachments: [0],
        })
      ).status,
    ).toBe(400);
    // A source from mailbox A cannot be forwarded from mailbox B.
    const fromA = await receive([{ name: "a.pdf", bytes: fileA }]);
    expect([403, 404]).toContain(
      (
        await draft(
          { expectedRevision: 0, sourceItemId: fromA, mode: "forward", retainedAttachments: [0] },
          "b@att.invalid",
        )
      ).status,
    );
  });
});
