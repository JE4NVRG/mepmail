import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { sql } from "drizzle-orm";
import type Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { claimMailboxTrial, mailboxTrialFingerprintHash } from "../src/mailbox-trial.js";
import { mailboxTrialDays } from "../src/mailbox-trial-eligibility.js";

const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  // Mail uses its own migration chain on top of the main baseline.
  for (const name of readdirSync(extension)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + name, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean))
      await db.execute(sql.raw(statement));
});

afterAll(async () => {
  await close();
});

async function team() {
  const [row] = await db
    .insert(schema.teams)
    .values({ name: "Trial fixture", slug: randomUUID(), plan: "free" })
    .returning();
  return row!.id;
}

function trialing(id: string, customer: string, fingerprint: string | null): Stripe.Subscription {
  return {
    id,
    status: "trialing",
    customer,
    default_payment_method: fingerprint
      ? ({ id: `pm_${id}`, type: "card", card: { fingerprint } } as Stripe.PaymentMethod)
      : null,
  } as Stripe.Subscription;
}

function stripe() {
  const update = vi.fn(async (id: string) => ({ id }) as Stripe.Subscription);
  return {
    update,
    stripe: {
      subscriptions: {
        update,
        retrieve: vi.fn(),
        list: vi.fn(),
        cancel: vi.fn(),
      },
    } as unknown as Parameters<typeof claimMailboxTrial>[1],
  };
}

describe("Correio free trial eligibility", () => {
  it("offers the trial to a team and Customer that never had Correio, and only then", async () => {
    const teamId = await team();
    expect(await mailboxTrialDays(db, { trialDays: 7 }, teamId, "cus_fresh")).toBe(7);
    expect(await mailboxTrialDays(db, { trialDays: 0 }, teamId, "cus_fresh")).toBe(0);
    expect(await mailboxTrialDays(db, { trialDays: 7 }, teamId, "cus_fresh", true)).toBe(0);
    await db.insert(schema.mailboxTrialClaims).values({
      fingerprintHash: mailboxTrialFingerprintHash("fp_used_elsewhere"),
      teamId: randomUUID(),
      stripeCustomerId: "cus_claimed",
      stripeSubscriptionId: "sub_old",
    });
    expect(await mailboxTrialDays(db, { trialDays: 7 }, teamId, "cus_claimed")).toBe(0);
    const held = await team();
    const now = Date.now();
    await db.insert(schema.mailboxSubscriptions).values({
      teamId: held,
      status: "canceled",
      seats: 0,
      storageBytesPerMailbox: 1024,
      includedOutboundPerMailbox: 10,
      periodStart: new Date(now - 7200000),
      periodEnd: new Date(now - 3600000),
      stripeSubscriptionId: "sub_ended",
    });
    expect(await mailboxTrialDays(db, { trialDays: 7 }, held, null)).toBe(0);
  });
});

describe("one Correio free trial per card", () => {
  it("claims a card once, keeps the claim idempotent and ends a second team's trial at once", async () => {
    const first = await team();
    const second = await team();
    const { stripe: client1, update } = stripe();
    expect(await claimMailboxTrial(db, client1, trialing("sub_a", "cus_a", "fp_card"), first)).toBe(
      "claimed",
    );
    expect(await claimMailboxTrial(db, client1, trialing("sub_a", "cus_a", "fp_card"), first)).toBe(
      "claimed",
    );
    expect(update).not.toHaveBeenCalled();
    expect(
      await claimMailboxTrial(db, client1, trialing("sub_b", "cus_b", "fp_card"), second),
    ).toBe("duplicate_card");
    expect(update).toHaveBeenCalledWith("sub_b", { trial_end: "now", proration_behavior: "none" });
    const [claim] = await db.select().from(schema.mailboxTrialClaims);
    expect(claim?.fingerprintHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await db.select().from(schema.mailboxTrialClaims))).not.toContain(
      "fp_card",
    );
  });

  it("ends a trial with no card and leaves a paid subscription alone", async () => {
    const teamId = await team();
    const { stripe: client1, update } = stripe();
    expect(await claimMailboxTrial(db, client1, trialing("sub_c", "cus_c", null), teamId)).toBe(
      "no_card",
    );
    expect(update).toHaveBeenCalledWith("sub_c", { trial_end: "now", proration_behavior: "none" });
    const paid = {
      ...trialing("sub_d", "cus_d", "fp_other"),
      status: "active",
    } as Stripe.Subscription;
    expect(await claimMailboxTrial(db, client1, paid, teamId)).toBe("not_trialing");
    expect(update).toHaveBeenCalledTimes(1);
  });
});
