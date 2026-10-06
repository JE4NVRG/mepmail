import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAILBOX_ACTIVITY_ACTIONS } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";

// These unrelated MIME endpoints are outside the feed contract exercised here.
vi.mock("@/server/mailbox-content", () => ({
  getMailboxContent: vi.fn(),
  getMailboxContentList: vi.fn(),
  saveMailboxContentDraft: vi.fn(),
}));
vi.mock("@/server/mailbox-transport", () => ({ mailboxTransportMime: {} }));

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let mailboxId: string;
const newestActivityId = randomUUID();
const olderActivityId = randomUUID();
const userId = "mailbox-ledger-owner";
const caller = (supportView = false) =>
  createCaller({
    db,
    teamId,
    role: "owner",
    session: {
      user: { id: userId, email: "owner@example.invalid", name: "Owner" },
      session: { id: "ledger-feed-session", createdAt: new Date() },
    },
    ...(supportView
      ? {
          supportView: {
            grantId: "11111111-1111-4111-8111-111111111111",
            expiresAt: new Date("2100-01-01T00:00:00Z"),
          },
        }
      : {}),
  });

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  // Extend the existing Main fixture with the real private mailbox DDL, in memory.
  const path = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));
  for (const name of readdirSync(path)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    await db.transaction(async (tx) => {
      for (const statement of readFileSync(path + name, "utf8").split("--> statement-breakpoint"))
        if (statement.trim()) await tx.execute(sql.raw(statement));
    });
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "1");
  vi.stubEnv("MAILBOX_PILOT_TEAM_IDS", undefined);
  vi.stubEnv("MAILBOX_PILOT_USER_IDS", undefined);
  await db
    .insert(schema.user)
    .values({ id: userId, name: "Owner", email: "owner@example.invalid", createdAt: new Date(0) });
  teamId = await createTeam(db, "private-ledger-feeds");
  const [member] = await db
    .insert(schema.teamMembers)
    .values({ teamId, userId, role: "owner" })
    .returning();
  const [domain] = await db
    .insert(schema.domains)
    .values({ teamId, name: "ledger.example.invalid", status: "verified", region: "us-east-1" })
    .returning();
  const [box] = await db
    .insert(schema.mailboxes)
    .values({
      teamId,
      domainId: domain!.id,
      address: "agent@ledger.example.invalid",
      label: "Private fixture",
      kind: "agent",
      ownerUserId: userId,
      ownerMembershipId: member!.id,
    })
    .returning();
  mailboxId = box!.id;
  await db.insert(schema.auditLog).values([
    {
      teamId,
      actorId: `user:${userId}`,
      action: "team.updated",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    {
      teamId,
      actorId: `user:${userId}`,
      action: "api_key.created",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    },
    ...Array.from({ length: 40 }, (_, n) => ({
      teamId,
      actorId: `user:${userId}`,
      action: MAILBOX_ACTIVITY_ACTIONS[n % 4]!,
      target: `mailbox:${randomUUID()}`,
      data: { mailboxId: randomUUID(), keyId: randomUUID() },
      createdAt: new Date("2026-01-03T00:00:00Z"),
    })),
    ...[
      { id: newestActivityId, createdAt: new Date("2026-01-05T00:00:00Z") },
      { id: olderActivityId, createdAt: new Date("2026-01-04T00:00:00Z") },
    ].map((row) => ({
      ...row,
      teamId,
      actorId: `user:${userId}`,
      action: "mailbox.items_listed",
      target: `mailbox:${mailboxId}`,
      data: { mailboxId, folder: "inbox", count: 0 },
    })),
  ]);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await close();
});

describe("private mailbox activity stays outside general forensic feeds", () => {
  it("excludes private facts before team pagination, including support sessions", async () => {
    for (const reader of [caller(), caller(true)]) {
      const first = await reader.audit.list({ limit: 1 });
      expect(first.items.map((row) => row.action)).toEqual(["api_key.created"]);
      expect(first.nextCursor).not.toBeNull();
      const last = await reader.audit.list({ limit: 1, cursor: first.nextCursor! });
      expect(last.items.map((row) => row.action)).toEqual(["team.updated"]);
      expect(last.nextCursor).toBeNull();
      expect(JSON.stringify([first, last])).not.toContain("mailbox:");
    }
  });
  it("excludes an operator's own private actions from console rows and totals", async () => {
    const page = await caller().console.audit.list({ limit: 1 });
    expect(page.total).toBe(2);
    expect(page.items.map((row) => row.action)).toEqual(["api_key.created"]);
    for (const action of MAILBOX_ACTIVITY_ACTIONS) {
      const filtered = await caller().console.audit.list({ action });
      expect(filtered.items).toEqual([]);
      expect(filtered.total).toBe(0);
    }
  });
  it("excludes private activity before the safety review's bounded list", async () => {
    const review = await caller().console.safety.review({ teamId });
    expect(review.audit.map((row) => row.action)).toEqual(["api_key.created", "team.updated"]);
    expect(JSON.stringify(review.audit)).not.toContain("mailbox:");
  });

  it("accepts the infinite-query forward direction and preserves owner keyset pages", async () => {
    const reader = caller();
    const first = await reader.mailboxes.activity({ mailboxId, direction: "forward", limit: 1 });
    expect(first.items.map((row) => row.id)).toEqual([newestActivityId]);
    expect(first.items[0]?.actor).toEqual({ kind: "person", label: "Owner" });
    expect(first.nextCursor?.createdAt).toMatch(/\.\d{6}Z$/);
    if (!first.nextCursor) throw new Error("Expected next-page cursor");
    const second = await reader.mailboxes.activity({
      mailboxId,
      direction: "forward",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items.map((row) => row.id)).toEqual([olderActivityId]);
    expect(second.nextCursor).toBeNull();
    // Core has a strict DTO without direction: passing transport-only fields
    // through would fail this actual router + Core call.
  });

  it("preserves strict input and private access when direction is supplied", async () => {
    await expect(
      caller(true).mailboxes.activity({ mailboxId, direction: "forward" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller().mailboxes.activity({ mailboxId: randomUUID(), direction: "forward" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller().mailboxes.activity({ mailboxId, direction: "backward" as "forward" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller().mailboxes.activity({
        mailboxId,
        direction: "forward",
        token: "synthetic override",
      } as Parameters<ReturnType<typeof caller>["mailboxes"]["activity"]>[0]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
