import { randomUUID } from "node:crypto";
import { generateApiKey, MAX_ACTIVE_API_KEYS, verifyApiKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";

// Authentication is synthetic in these router unit cases. Live membership
// enforcement is covered by the operations integration tests without this mock.
vi.mock("@/server/request-membership", async () => import("./fixtures/legacy-router-membership"));

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await close();
});

function callerFor(teamId: string, role: "owner" | "admin" | "member" = "owner") {
  return createCaller({
    db,
    session: {
      user: { id: "u1", email: "u1@example.com", name: "u1" },
      session: { id: "s1", createdAt: new Date() },
    },
    teamId,
    role,
  });
}

async function keyRow(id: string) {
  const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id));
  if (!row) throw new Error("key row missing");
  return row;
}

async function createDomain(
  teamId: string,
  name: string,
  status: "verified" | "pending" = "verified",
) {
  const [row] = await db
    .insert(schema.domains)
    .values({ teamId, name, region: "us-east-1", status })
    .returning({ id: schema.domains.id });
  if (!row) throw new Error("domain insert failed");
  return row.id;
}

describe("apiKeys.create", () => {
  it.each(["hold", "sandbox"] as const)(
    "enforces cloud %s before a dashboard full-key response",
    async (level) => {
      vi.stubEnv("IS_CLOUD", "true");
      vi.stubEnv("SIGNUP_BOT_PROTECTION", "true");
      const teamId = await createTeam(db, `restricted-${randomUUID()}`);
      const userId = randomUUID();
      await db.insert(schema.user).values({
        id: userId,
        name: "Synthetic",
        email: `${userId}@example.test`,
        emailVerified: true,
      });
      await db.insert(schema.teamSignupRisk).values({
        teamId,
        principalUserId: userId,
        level,
        reasons: ["synthetic_fixture"],
        signals: {
          domain: `${userId}.test`,
          disposable: false,
          mx: "present",
          domainAgeDays: 400,
          catchAll: "unknown",
          randomLocal: false,
          ipKey: null,
          asn: null,
          signupsIp1h: 0,
          signupsDomain24h: 0,
          signupsAsn1h: 0,
        },
      });
      const caller = callerFor(teamId);
      await expect(caller.apiKeys.create({ name: "No full credential" })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(
        await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.teamId, teamId)),
      ).toHaveLength(0);
      if (level === "sandbox") {
        const key = await caller.apiKeys.create({
          name: "Own-address test",
          permission: "sending_access",
        });
        expect(key.token).toMatch(/^ms_/);
        await expect(
          caller.apiKeys.create({ name: "Second test", permission: "sending_access" }),
        ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      } else {
        await expect(
          caller.apiKeys.create({ name: "No test credential", permission: "sending_access" }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
    },
  );
  it("forbids ordinary members from minting privileged API keys", async () => {
    const teamId = await createTeam(db, "team-a");
    await expect(
      callerFor(teamId, "member").apiKeys.create({ name: "escalation" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
  it("returns an ms_-prefixed token that verifies against the stored hash", async () => {
    const teamId = await createTeam(db, "team-a");
    const { id, token } = await callerFor(teamId).apiKeys.create({ name: "Production" });

    expect(token).toMatch(/^ms_[A-Za-z0-9_-]/);
    const row = await keyRow(id);
    expect(row.teamId).toBe(teamId);
    expect(token.startsWith(row.tokenPrefix)).toBe(true);
    expect(row.last4).toBe(token.slice(-4));
    // The secret itself is never stored — only its hash verifies the token.
    expect(row.keyHash).not.toContain(token);
    expect(verifyApiKey(token, row.keyHash)).toBe(true);
    expect(verifyApiKey(`${token}x`, row.keyHash)).toBe(false);
  });

  it("refuses to mint past the active-key cap until one is revoked", async () => {
    const teamId = await createTeam(db, "team-a");
    await db.insert(schema.apiKeys).values(
      Array.from({ length: MAX_ACTIVE_API_KEYS - 1 }, (_, i) => {
        const key = generateApiKey();
        return {
          teamId,
          name: `k${i}`,
          tokenPrefix: key.tokenPrefix,
          keyHash: key.keyHash,
          last4: key.last4,
        };
      }),
    );
    const { id } = await callerFor(teamId).apiKeys.create({ name: "last slot" });
    await expect(callerFor(teamId).apiKeys.create({ name: "one too many" })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    await callerFor(teamId).apiKeys.revoke({ id });
    await expect(callerFor(teamId).apiKeys.create({ name: "after revoke" })).resolves.toMatchObject(
      { id: expect.any(String) },
    );
  });

  it("mints tokens in the ms_ scheme", async () => {
    const teamId = await createTeam(db, "team-a");
    const { token } = await callerFor(teamId).apiKeys.create({ name: "CI" });
    expect(token).toMatch(/^ms_[A-Za-z0-9_-]{32}$/);
  });

  it("defaults to full access and any domain", async () => {
    const teamId = await createTeam(db, "team-a");
    const { id } = await callerFor(teamId).apiKeys.create({ name: "default" });
    const row = await keyRow(id);
    expect(row.permission).toBe("full_access");
    expect(row.domainId).toBeNull();
  });

  it("persists sending-only permission scoped to a verified domain", async () => {
    const teamId = await createTeam(db, "team-a");
    const domainId = await createDomain(teamId, "mail.a.example", "verified");
    const { id } = await callerFor(teamId).apiKeys.create({
      name: "sender",
      permission: "sending_access",
      domainId,
    });
    const row = await keyRow(id);
    expect(row.permission).toBe("sending_access");
    expect(row.domainId).toBe(domainId);
  });

  it("rejects an unverified domain", async () => {
    const teamId = await createTeam(db, "team-a");
    const domainId = await createDomain(teamId, "mail.a.example", "pending");
    await expect(callerFor(teamId).apiKeys.create({ name: "x", domainId })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("rejects a domain owned by another team", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const foreign = await createDomain(teamB, "mail.b.example", "verified");
    await expect(
      callerFor(teamA).apiKeys.create({ name: "x", domainId: foreign }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("apiKeys.list", () => {
  it("excludes revoked keys and other teams' keys", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const a = callerFor(teamA);
    const kept = await a.apiKeys.create({ name: "kept" });
    const revoked = await a.apiKeys.create({ name: "revoked" });
    await a.apiKeys.revoke({ id: revoked.id });
    await callerFor(teamB).apiKeys.create({ name: "other-team" });

    const listed = await a.apiKeys.list();
    expect(listed.map((k) => k.id)).toEqual([kept.id]);
  });

  it("surfaces each key's permission and scoped domain name", async () => {
    const teamId = await createTeam(db, "team-a");
    const domainId = await createDomain(teamId, "mail.a.example", "verified");
    const caller = callerFor(teamId);
    await caller.apiKeys.create({ name: "scoped", permission: "sending_access", domainId });
    await caller.apiKeys.create({ name: "full" });

    const listed = await caller.apiKeys.list();
    const scoped = listed.find((k) => k.name === "scoped");
    const full = listed.find((k) => k.name === "full");
    expect(scoped?.permission).toBe("sending_access");
    expect(scoped?.domainName).toBe("mail.a.example");
    expect(full?.permission).toBe("full_access");
    expect(full?.domainName).toBeNull();
  });
});

describe("apiKeys.revoke", () => {
  it("forbids ordinary members from revoking keys", async () => {
    const teamId = await createTeam(db, "team-a");
    const { id } = await callerFor(teamId).apiKeys.create({ name: "Production" });
    await expect(callerFor(teamId, "member").apiKeys.revoke({ id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await keyRow(id)).revokedAt).toBeNull();
  });
  it("blocks cross-team revocation", async () => {
    const teamA = await createTeam(db, "team-a");
    const teamB = await createTeam(db, "team-b");
    const { id } = await callerFor(teamA).apiKeys.create({ name: "Production" });

    await expect(callerFor(teamB).apiKeys.revoke({ id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await keyRow(id)).revokedAt).toBeNull();
  });

  it("soft-revokes: the row survives with revokedAt set", async () => {
    const teamId = await createTeam(db, "team-a");
    const caller = callerFor(teamId);
    const { id } = await caller.apiKeys.create({ name: "Production" });

    await caller.apiKeys.revoke({ id });
    expect((await keyRow(id)).revokedAt).toBeInstanceOf(Date);
    // Idempotence is not silent: revoking again reports the key as gone.
    await expect(caller.apiKeys.revoke({ id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("apiKeys.rename", () => {
  it("renames an active key (trimmed) and refuses a revoked one", async () => {
    const teamId = await createTeam(db);
    const { id } = await callerFor(teamId).apiKeys.create({ name: "old" });
    await expect(callerFor(teamId).apiKeys.rename({ id, name: " new " })).resolves.toMatchObject({
      name: "new",
    });
    expect((await keyRow(id)).name).toBe("new");
    await callerFor(teamId).apiKeys.revoke({ id });
    await expect(callerFor(teamId).apiKeys.rename({ id, name: "again" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
