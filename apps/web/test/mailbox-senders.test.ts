import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createMailboxRegistry, EnvKeyring } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getKeyring } from "@/server/keyring";
import { mailboxSenderHmacKey } from "@/server/mailbox-sender-key";
import { mailboxSendersRouter } from "@/server/routers/mailbox-senders";
import { type Context, createCallerFactory, createContext, router } from "@/server/trpc";
import {
  isMailboxSenderBlocked,
  mailboxSenderDecisionsFor,
  normalizeMailboxSender,
} from "../../../packages/core/src/mailbox-senders";
import { mailboxSenderDecisions } from "../../../packages/db/src/schema/mailbox-sender-decisions";
import { seedMailboxTestService } from "./mailbox-service-fixture";

vi.mock("@/server/keyring", () => ({ getKeyring: vi.fn() }));
vi.mock("@/server/mailbox-sender-key", () => ({ mailboxSenderHmacKey: vi.fn() }));
vi.mock("@/server/trpc", async (original) => ({
  ...(await original<typeof import("@/server/trpc")>()),
  createContext: vi.fn(),
}));
let client: PGlite, db: Db, teamId: string, mailboxId: string, otherBox: string;
const folder = fileURLToPath(new URL("../../../packages/db/drizzle/", import.meta.url));
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
const caller = createCallerFactory(router({ senders: mailboxSendersRouter }));
const HMAC = randomBytes(32);
function ctx(userId = "owner"): Context {
  return {
    db,
    teamId,
    role: userId === "owner" ? "owner" : "member",
    session: { user: { id: userId, name: userId, email: `${userId}@example.invalid` } },
  };
}
const as = (userId = "owner") => caller(ctx(userId)).senders;
const actor = () => ({ teamId, userId: "owner" });

beforeEach(async () => {
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
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
  const [team] = await db
    .insert(schema.teams)
    .values({ name: "Senders", slug: "senders" })
    .returning();
  teamId = team!.id;
  await seedMailboxTestService(db, [teamId]);
  for (const id of ["owner", "member"])
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.invalid`, emailVerified: true });
  await db.insert(schema.teamMembers).values([
    { teamId, userId: "owner", role: "owner" },
    { teamId, userId: "member", role: "member" },
  ]);
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "senders.invalid", region: "us-east-1", status: "verified" })
    .returning();
  const box = (localPart: string) =>
    createMailboxRegistry(db, actor(), {
      domainId: domain!.id,
      localPart,
      label: localPart,
      kind: "person",
      ownerUserId: "owner",
    });
  mailboxId = (await box("person")).id;
  otherBox = (await box("other")).id;
  vi.mocked(getKeyring).mockReturnValue(new EnvKeyring(new Map([[1, randomBytes(32)]]), 1));
  vi.mocked(mailboxSenderHmacKey).mockReturnValue(HMAC);
  vi.mocked(createContext).mockImplementation(async () => ctx());
});
afterEach(async () => {
  await client.close();
  vi.unstubAllEnvs();
});

describe("sender approval", () => {
  it("keeps one answer per sender, never the address in the clear, and lists them opened", async () => {
    expect(
      await as().decide({ mailboxId, address: " Promo@Loja.Example ", decision: "block" }),
    ).toEqual({ address: "promo@loja.example", decision: "block" });
    await as().decide({ mailboxId, address: "ana@example.com", decision: "allow" });
    // Changing an answer updates the same row.
    await as().decide({ mailboxId, address: "PROMO@loja.example", decision: "allow" });
    const rows = await db.select().from(mailboxSenderDecisions);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(Buffer.from(row.senderKey)).toHaveLength(32);
      const stored = `${Buffer.from(row.addressCiphertext).toString("latin1")}${Buffer.from(row.senderKey).toString("latin1")}`;
      expect(stored).not.toContain("loja.example");
      expect(stored).not.toContain("example.com");
    }
    const listed = await as().list({ mailboxId });
    expect(listed.map(({ address, decision }) => ({ address, decision }))).toEqual([
      { address: "promo@loja.example", decision: "allow" },
      { address: "ana@example.com", decision: "allow" },
    ]);
    // Clearing forgets the sender.
    await as().decide({ mailboxId, address: "ana@example.com", decision: null });
    expect((await as().list({ mailboxId })).map((row) => row.address)).toEqual([
      "promo@loja.example",
    ]);
  });

  it("looks answers up per mailbox for listing and receipt", async () => {
    await as().decide({ mailboxId, address: "spam@bad.example", decision: "block" });
    await as().decide({ mailboxId, address: "ana@example.com", decision: "allow" });
    const decisions = await mailboxSenderDecisionsFor(db, HMAC, {
      teamId,
      mailboxId,
      addresses: ["SPAM@bad.example", "ana@example.com", "new@example.com", "not an address"],
    });
    expect(Object.fromEntries(decisions)).toEqual({
      "spam@bad.example": "block",
      "ana@example.com": "allow",
    });
    expect(
      await isMailboxSenderBlocked(db, HMAC, { teamId, mailboxId, address: "spam@bad.example" }),
    ).toBe(true);
    // The same sender in another mailbox has no answer there.
    expect(
      await isMailboxSenderBlocked(db, HMAC, {
        teamId,
        mailboxId: otherBox,
        address: "spam@bad.example",
      }),
    ).toBe(false);
  });

  it("is the owner's: others, bad input and a deployment without a key are refused", async () => {
    await expect(
      as("member").decide({ mailboxId, address: "x@example.com", decision: "block" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(as("member").list({ mailboxId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      as().decide({ mailboxId, address: "no-at-sign", decision: "block" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    vi.mocked(mailboxSenderHmacKey).mockReturnValue(null);
    await expect(
      as().decide({ mailboxId, address: "x@example.com", decision: "block" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: "screening_unavailable" });
    expect(normalizeMailboxSender("a b@example.com")).toBeNull();
    expect(normalizeMailboxSender("@example.com")).toBeNull();
  });
});
