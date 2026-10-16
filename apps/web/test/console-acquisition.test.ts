import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";

vi.mock("@/server/queue", () => ({ getQueue: async () => ({ runCronNow: async () => {} }) }));

let db: Db;
let close: () => Promise<void>;
const network = vi.fn(() => {
  throw new Error("Console projection must not call a provider");
});
const operatorId = "operator-acquisition";
const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.user).values({
    id: operatorId,
    name: "Operator",
    email: "operator@example.test",
    createdAt: new Date(0),
  });
});
beforeEach(() => {
  network.mockClear();
  vi.stubGlobal("fetch", network);
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "false");
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(() => close());

const caller = (userId = operatorId) =>
  createCaller({
    db,
    session: {
      user: { id: userId, email: `${userId}@example.test`, name: "Fixture" },
      session: { id: `session-${userId}`, createdAt: new Date() },
    },
    teamId: null,
    role: null,
  });

async function owner(teamId: string, source?: string, createdAt = new Date("2026-01-01")) {
  const id = randomUUID();
  await db.insert(schema.user).values({ id, name: "Owner", email: `${id}@example.test` });
  await db.insert(schema.teamMembers).values({ teamId, userId: id, role: "owner", createdAt });
  if (source)
    await db.insert(schema.signupAttribution).values({
      userId: id,
      source,
      campaign: "campaign-fixture",
      medium: "post",
      landingPath: "/migrate",
    });
  return id;
}

it("projects the displayed current owner's signup and Correio from local rows on list and detail", async () => {
  for (const name of readdirSync(extension)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    for (const statement of readFileSync(extension + name, "utf8")
      .split("--> statement-breakpoint")
      .map((part) => part.trim())
      .filter(Boolean))
      await db.execute(sql.raw(statement));
  }
  vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "true");
  const teamId = await createTeam(db, `acquisition-${randomUUID()}`);
  const firstOwner = await owner(teamId, "community");
  await owner(teamId, "other-owner", new Date("2026-02-01"));
  await db
    .update(schema.teams)
    .set({ plan: "pro", planStatus: "past_due", stripeSubscriptionId: "sub_fixture_send" })
    .where(eq(schema.teams.id, teamId));
  const periodEnd = new Date("2026-11-01T00:00:00Z");
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "trialing",
    planCode: "solo",
    seats: 1,
    storageBytesPerMailbox: 1024,
    includedOutboundPerMailbox: 100,
    periodStart: new Date("2026-10-01"),
    periodEnd,
    cancelAtPeriodEnd: true,
  });
  const list = await caller().console.teams.list({});
  const row = list.items.find((entry) => entry.id === teamId);
  const detail = await caller().console.teams.detail({ id: teamId });
  expect(row).toMatchObject({
    ownerEmail: `${firstOwner}@example.test`,
    plan: "pro",
    planStatus: "past_due",
    ownerSignupAttribution: {
      source: "community",
      medium: "post",
      campaign: "campaign-fixture",
      landingPath: "/migrate",
    },
    mailboxProjectionEnabled: true,
    mailboxSubscription: { planCode: "solo", status: "trialing", cancelAtPeriodEnd: true },
  });
  expect(detail.ownerSignupAttribution).toEqual(row?.ownerSignupAttribution);
  expect(detail.mailboxSubscription).toEqual(row?.mailboxSubscription);
  expect(new Date(detail.mailboxSubscription?.periodEnd ?? "")).toEqual(periodEnd);
  expect(Object.keys(detail.ownerSignupAttribution ?? {}).sort()).toEqual(
    ["source", "medium", "campaign", "content", "term", "referrer", "landingPath"].sort(),
  );
});

it("does not assign a former owner's or another member's signup to the new owner or team", async () => {
  const teamId = await createTeam(db, `transferred-${randomUUID()}`);
  const formerOwner = await owner(teamId, "former-owner-campaign");
  await db
    .update(schema.teamMembers)
    .set({ role: "member" })
    .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, formerOwner)));
  const currentOwner = await owner(teamId);
  const detail = await caller().console.teams.detail({ id: teamId });
  expect(detail.ownerEmail).toBe(`${currentOwner}@example.test`);
  expect(detail.ownerSignupAttribution).toBeNull();
  expect(detail.mailboxSubscription).toBeNull();
});

it("keeps missing owner, missing acquisition and missing Mail distinct without fabricating legacy data", async () => {
  const teamId = await createTeam(db, `missing-${randomUUID()}`);
  const row = (await caller().console.teams.list({})).items.find((entry) => entry.id === teamId);
  expect(row).toMatchObject({
    ownerEmail: null,
    ownerSignupAttribution: null,
    mailboxSubscription: null,
    mailboxProjectionEnabled: false,
    planStatus: "none",
  });
});

it("reads a base-only installation with the optional Mail schema disabled", async () => {
  const original = db;
  const fresh = await createTestDb();
  db = fresh.db;
  try {
    await db.insert(schema.user).values({
      id: operatorId,
      name: "Operator",
      email: "operator@example.test",
      createdAt: new Date(0),
    });
    const teamId = await createTeam(db, "base-only");
    const detail = await caller().console.teams.detail({ id: teamId });
    expect(detail.mailboxSubscription).toBeNull();
    expect(detail.mailboxProjectionEnabled).toBe(false);
  } finally {
    await fresh.close();
    db = original;
  }
});

it("keeps acquisition and subscription projections behind the operator gate", async () => {
  const id = randomUUID();
  await db.insert(schema.user).values({ id, name: "Member", email: `${id}@example.test` });
  await expect(caller(id).console.teams.list({})).rejects.toMatchObject({ code: "NOT_FOUND" });
});
