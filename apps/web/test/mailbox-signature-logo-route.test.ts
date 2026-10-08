import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createMailboxRegistry } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Context, createContext } from "@/server/trpc";
import { seedMailboxTestService } from "./mailbox-service-fixture";

interface S3Call {
  Bucket?: string;
  Key?: string;
  ContentType?: string;
}
const h = vi.hoisted(() => ({ puts: [] as S3Call[], deletes: [] as S3Call[] }));

vi.mock("@/server/trpc", async (original) => ({
  ...(await original<typeof import("@/server/trpc")>()),
  createContext: vi.fn(),
}));
vi.mock("@aws-sdk/client-s3", () => {
  class PutObjectCommand {
    constructor(public input: S3Call) {}
  }
  class DeleteObjectCommand {
    constructor(public input: S3Call) {}
  }
  class S3Client {
    async send(command: PutObjectCommand | DeleteObjectCommand): Promise<void> {
      (command instanceof PutObjectCommand ? h.puts : h.deletes).push(command.input);
    }
  }
  return { S3Client, PutObjectCommand, DeleteObjectCommand };
});

const { POST, DELETE: removeLogo } = await import("@/app/api/mailbox-signature-logo/route");

// PNG signature and IHDR: 480 x 160.
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1,
  0xe0, 0, 0, 0, 0xa0, 8, 6, 0, 0, 0,
]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const folder = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
let client: PGlite;
let db: Db;
let teamId: string;
let mailboxId: string;

function ctx(userId: string): Context {
  return {
    db,
    teamId,
    role: userId === "admin" ? "admin" : "member",
    session: { user: { id: userId, name: userId, email: `${userId}@example.invalid` } },
  } as Context;
}
const upload = (bytes: Uint8Array<ArrayBuffer>, id = mailboxId) => {
  const form = new FormData();
  form.set("mailboxId", id);
  form.set("file", new File([bytes], "logo.png", { type: "image/png" }));
  return POST(
    new Request("http://localhost/api/mailbox-signature-logo", { method: "POST", body: form }),
  );
};
const stored = async () =>
  (await db.select().from(schema.mailboxes).where(eq(schema.mailboxes.id, mailboxId)))[0]!
    .signatureProfile;

beforeEach(async () => {
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  vi.stubEnv("S3_ENDPOINT", "https://acc.r2.cloudflarestorage.com");
  vi.stubEnv("S3_ACCESS_KEY_ID", "key");
  vi.stubEnv("S3_SECRET_ACCESS_KEY", "secret");
  vi.stubEnv("S3_STORAGE_BUCKET", "ms-uploads");
  vi.stubEnv("S3_STORAGE_PUBLIC_URL", "https://cdn.example.com");
  h.puts = [];
  h.deletes = [];
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
  const [team] = await db
    .insert(schema.teams)
    .values({ name: "Signature", slug: "signature" })
    .returning();
  teamId = team!.id;
  await seedMailboxTestService(db, [teamId]);
  for (const id of ["owner", "member", "admin"])
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.invalid`, emailVerified: true });
  await db.insert(schema.teamMembers).values([
    { teamId, userId: "owner", role: "member" },
    { teamId, userId: "member", role: "member" },
    { teamId, userId: "admin", role: "admin" },
  ]);
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "sig.invalid", region: "us-east-1" })
    .returning();
  mailboxId = (
    await createMailboxRegistry(
      db,
      { teamId, userId: "admin" },
      {
        domainId: domain!.id,
        localPart: "jean",
        label: "Jean",
        kind: "person",
        ownerUserId: "owner",
      },
    )
  ).id;
});
afterEach(async () => {
  await client.close();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("/api/mailbox-signature-logo", () => {
  it("refuses a member who neither owns the mailbox nor administers the team, before storage", async () => {
    vi.mocked(createContext).mockImplementation(async () => ctx("member"));
    expect((await upload(PNG)).status).toBe(403);
    expect(
      (
        await removeLogo(
          new Request(`http://localhost/api/mailbox-signature-logo?mailboxId=${mailboxId}`, {
            method: "DELETE",
          }),
        )
      ).status,
    ).toBe(403);
    expect(h.puts).toEqual([]);
    expect(await stored()).toBeNull();
  });

  it("stores the owner's PNG per mailbox with its pixel size, and removes it", async () => {
    vi.mocked(createContext).mockImplementation(async () => ctx("owner"));
    const response = await upload(PNG);
    expect(response.status).toBe(200);
    expect(h.puts).toEqual([
      expect.objectContaining({
        Bucket: "ms-uploads",
        Key: `signature-logos/${teamId}/${mailboxId}.png`,
        ContentType: "image/png",
      }),
    ]);
    expect(await stored()).toMatchObject({
      logoUrl: expect.stringMatching(
        new RegExp(
          `^https://cdn\\.example\\.com/signature-logos/${teamId}/${mailboxId}\\.png\\?v=\\d+$`,
        ),
      ),
      logoWidth: 480,
      logoHeight: 160,
    });
    const removed = await removeLogo(
      new Request(`http://localhost/api/mailbox-signature-logo?mailboxId=${mailboxId}`, {
        method: "DELETE",
      }),
    );
    expect(removed.status).toBe(200);
    expect(h.deletes).toEqual([
      expect.objectContaining({ Key: `signature-logos/${teamId}/${mailboxId}.png` }),
    ]);
    expect(await stored()).toMatchObject({ logoUrl: null, logoWidth: null });
  });

  it("accepts only PNG or JPEG bytes, whatever the declared type", async () => {
    vi.mocked(createContext).mockImplementation(async () => ctx("admin"));
    expect((await upload(WEBP)).status).toBe(415);
    expect((await upload(new TextEncoder().encode("<svg onload=alert(1)>"))).status).toBe(415);
    expect((await upload(PNG, "not-a-uuid")).status).toBe(400);
    expect(h.puts).toEqual([]);
  });
});
