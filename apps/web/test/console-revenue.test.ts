import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCaller } from "@/server/routers";
import { mailboxMonthlyCents } from "@/server/routers/console/revenue";

let db: Db;
let close: () => Promise<void>;
const OPERATOR = "op";
const MEMBER = "bob";

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.user).values([
    { id: OPERATOR, name: "Operator", email: "op@example.com", createdAt: new Date(0) },
    { id: MEMBER, name: "Bob", email: "bob@example.com", createdAt: new Date(1) },
  ]);
});
afterAll(() => close());
afterEach(() => vi.unstubAllEnvs());

const extension = fileURLToPath(new URL("../../../packages/db/mailbox-drizzle/", import.meta.url));

function caller(userId: string) {
  return createCaller({
    db,
    session: {
      user: { id: userId, email: `${userId}@example.com`, name: userId },
      session: { id: `s-${userId}`, createdAt: new Date() },
    },
    teamId: null,
    role: null,
  });
}

describe("mailboxMonthlyCents", () => {
  const base = { extraUnitAmount: null, includedMailboxes: 1, quotaScope: "mailbox" };
  it("multiplies a per-mailbox price by the seats", () => {
    expect(mailboxMonthlyCents({ ...base, unitAmount: 490, seats: 3, interval: "month" })).toBe(
      1470,
    );
  });
  it("prices a bundle as base plus extra mailboxes, and spreads a yearly price", () => {
    const bundle = {
      unitAmount: 1290,
      extraUnitAmount: 390,
      includedMailboxes: 10,
      quotaScope: "team",
    };
    expect(mailboxMonthlyCents({ ...bundle, seats: 10, interval: "month" })).toBe(1290);
    expect(mailboxMonthlyCents({ ...bundle, seats: 12, interval: "month" })).toBe(2070);
    expect(mailboxMonthlyCents({ ...bundle, seats: 10, interval: "year" })).toBe(108);
  });
  it("has no amount without a stored price", () => {
    expect(mailboxMonthlyCents({ ...base, unitAmount: null, seats: 2, interval: null })).toBeNull();
  });
});

describe("console.revenue.summary", () => {
  it("answers without Correio's tables when its registry is off", async () => {
    vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "false");
    const s = await caller(OPERATOR).console.revenue.summary();
    expect(s.mrr).toEqual([]);
    expect(s.paying).toEqual({ send: 0, mail: 0 });
  });

  it("sums paying Stripe subscriptions only and lists internal licenses apart", async () => {
    for (const name of readdirSync(extension)
      .filter((file) => file.endsWith(".sql"))
      .sort()) {
      for (const statement of readFileSync(extension + name, "utf8")
        .split("--> statement-breakpoint")
        .map((part) => part.trim())
        .filter(Boolean))
        await db.execute(sql.raw(statement));
    }
    vi.stubEnv("MAILBOX_REGISTRY_ENABLED", "true");
    const now = Date.now();
    const paid = await createTeam(db, "paid-mail");
    const internal = await createTeam(db, "internal-mail");
    const ended = await createTeam(db, "ended-mail");
    const row = (
      teamId: string,
      extra: Partial<typeof schema.mailboxSubscriptions.$inferInsert>,
    ) => ({
      teamId,
      status: "active" as const,
      seats: 2,
      storageBytesPerMailbox: 1_000_000,
      includedOutboundPerMailbox: 100,
      periodStart: new Date(now - 86_400_000),
      periodEnd: new Date(now + 10 * 86_400_000),
      ...extra,
    });
    await db.insert(schema.mailboxSubscriptions).values([
      row(paid, {
        stripeSubscriptionId: "sub_paid",
        stripeCustomerId: "cus_paid",
        currency: "usd",
        unitAmount: 490,
        interval: "month",
        livemode: true,
      }),
      row(internal, {}),
      row(ended, {
        status: "canceled",
        stripeSubscriptionId: "sub_ended",
        currency: "usd",
        unitAmount: 1290,
        interval: "month",
        livemode: true,
      }),
    ]);
    await db.update(schema.teams).set({ name: "Paid Co" }).where(eq(schema.teams.id, paid));

    const s = await caller(OPERATOR).console.revenue.summary();
    expect(s.mrr).toEqual([{ currency: "usd", cents: 980 }]);
    expect(s.paying).toEqual({ send: 0, mail: 1 });
    expect(s.internal).toBe(1);
    expect(s.renewals30d).toBe(1);
    expect(s.rows[0]).toMatchObject({ teamId: paid, paying: true, monthlyCents: 980 });
    expect(s.rows.find((r) => r.teamId === internal)).toMatchObject({
      source: "internal",
      paying: false,
      monthlyCents: null,
    });
    expect(s.rows.find((r) => r.teamId === ended)).toMatchObject({ paying: false });

    await expect(caller(MEMBER).console.revenue.summary()).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
