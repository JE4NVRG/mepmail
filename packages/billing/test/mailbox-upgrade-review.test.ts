import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { holdOnContentVerdict, screenNewSender } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type MailboxCatalog,
  type MailboxPriceTerms,
  projectMailboxSubscription,
} from "../src/mailbox.js";
import { changeMailboxPlan, manageMailboxSubscription } from "../src/mailbox-management.js";
import { PurchaseEligibilityError } from "../src/purchase-eligibility.js";
import { fakeStripe, PERIOD_START, subscription } from "./helpers.js";

const GiB = 1024 ** 3;
const solo: MailboxPriceTerms = {
  priceId: "price_review_solo",
  planCode: "solo",
  currency: "usd",
  unitAmount: 290,
  interval: "month",
  quotaScope: "team",
  includedMailboxes: 1,
  storageBytesPerMailbox: GiB,
  includedOutboundPerMailbox: 500,
  inboundDeliveriesPerPeriod: 2000,
  inboundBytesPerPeriod: GiB / 2,
  outboundBytesPerPeriod: GiB / 4,
};
const equipe: MailboxPriceTerms = {
  priceId: "price_review_equipe",
  planCode: "equipe",
  currency: "usd",
  unitAmount: 1290,
  interval: "month",
  quotaScope: "team",
  includedMailboxes: 10,
  storageBytesPerMailbox: 10 * GiB,
  includedOutboundPerMailbox: 10000,
  inboundDeliveriesPerPeriod: 10000,
  inboundBytesPerPeriod: 3 * GiB,
  outboundBytesPerPeriod: 5 * GiB,
};
const legacy: MailboxPriceTerms = {
  priceId: "price_review_legacy",
  currency: "usd",
  unitAmount: 123,
  interval: "month",
  storageBytesPerMailbox: GiB,
  includedOutboundPerMailbox: 500,
};
const catalog: MailboxCatalog = {
  livemode: false,
  checkoutPriceId: solo.priceId,
  checkoutPriceIds: [solo.priceId, equipe.priceId, legacy.priceId],
  standalonePriceIds: [solo.priceId, equipe.priceId],
  prices: [solo, equipe, legacy],
};
const now = () => new Date((PERIOD_START + 1000) * 1000);
const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
let db: Db,
  close: () => Promise<void>,
  teamId: string,
  userId: string,
  sequence = 0;
let stripe: ReturnType<typeof fakeStripe>["stripe"];
let state: ReturnType<typeof fakeStripe>["state"];
let sub: Stripe.Subscription;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  for (const name of readdirSync(extension)
    .filter((name) => name.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + name, "utf8")
      .split("--> statement-breakpoint")
      .map((value) => value.trim())
      .filter(Boolean))
      await db.execute(sql.raw(statement));
});
afterAll(async () => close());

function priceFor(terms: MailboxPriceTerms): Stripe.Price {
  return {
    ...sub.items.data[0]!.price,
    id: terms.priceId,
    currency: terms.currency,
    unit_amount: terms.unitAmount,
    billing_scheme: "per_unit",
    transform_quantity: null,
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
  } as Stripe.Price;
}
async function project(terms: MailboxPriceTerms, quantity = 1) {
  sub.items.data[0]!.price = priceFor(terms);
  sub.items.data[0]!.quantity = quantity;
  const projection = projectMailboxSubscription(sub, catalog, {
    teamId,
    customerId: `cus_mail_review_${sequence}`,
  });
  if (!projection) throw new Error("Invalid synthetic mailbox projection");
  await db
    .update(schema.mailboxSubscriptions)
    .set(projection)
    .where(eq(schema.mailboxSubscriptions.teamId, teamId));
}
function paidInvoice(): Stripe.Invoice {
  const item = sub.items.data[0]!;
  const invoiceId = `in_mail_review_${sequence}`;
  return {
    id: invoiceId,
    customer: sub.customer,
    livemode: false,
    currency: "usd",
    status: "paid",
    amount_remaining: 0,
    billing_reason: "subscription_update",
    parent: { type: "subscription_details", subscription_details: { subscription: sub.id } },
    lines: {
      has_more: false,
      data: [
        {
          id: `il_${sequence}`,
          invoice: invoiceId,
          livemode: false,
          currency: "usd",
          amount: item.price.unit_amount,
          quantity: 1,
          pricing: { type: "price_details", price_details: { price: item.price.id } },
          period: { start: item.current_period_start, end: item.current_period_end },
          parent: {
            type: "subscription_item_details",
            subscription_item_details: {
              subscription: sub.id,
              subscription_item: item.id,
              proration: true,
            },
          },
        },
      ],
    },
  } as unknown as Stripe.Invoice;
}

beforeEach(async () => {
  sequence++;
  ({ stripe, state } = fakeStripe());
  teamId = await createTeam(db, `mail-review-${sequence}`);
  userId = `mail_review_user_${sequence}`;
  const customerId = `cus_mail_review_${sequence}`;
  await db
    .update(schema.teams)
    .set({
      stripeCustomerId: customerId,
      createdAt: new Date(Date.now() - 60_000),
    })
    .where(eq(schema.teams.id, teamId));
  await db.insert(schema.user).values({
    id: userId,
    name: "Mailbox review owner",
    email: `mail-review-${sequence}@example.invalid`,
  });
  await db.insert(schema.teamMembers).values({ teamId, userId, role: "owner" });
  await db.insert(schema.domains).values({
    teamId,
    name: `mail-review-${sequence}.com`,
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  sub = subscription(`sub_mail_review_${sequence}`, customerId, "active");
  sub.metadata = { mepmail_service: "mailbox" };
  sub.livemode = false;
  sub.currency = "usd";
  sub.collection_method = "charge_automatically";
  sub.pending_update = null;
  sub.schedule = null;
  sub.items.data[0]!.price = priceFor(solo);
  sub.items.data[0]!.quantity = 1;
  state.subscriptions[sub.id] = sub;
  const projection = projectMailboxSubscription(sub, catalog, { teamId, customerId });
  if (!projection) throw new Error("Invalid Solo fixture");
  await db.insert(schema.mailboxSubscriptions).values(projection);
  stripe.subscriptions.update = async (id, params = {}) => {
    state.calls.push("subscriptions.update");
    state.updates.push([id, params]);
    for (const change of params.items ?? []) {
      const terms = catalog.prices.find((price) => price.priceId === change.price);
      if (!terms) throw new Error("Unknown synthetic mailbox price");
      sub.items.data[0]!.price = priceFor(terms);
      sub.items.data[0]!.quantity = change.quantity ?? 1;
    }
    if (params.cancel_at_period_end !== undefined)
      sub.cancel_at_period_end = params.cancel_at_period_end;
    if (params.trial_end === "now") sub.status = "active";
    if (params.proration_behavior === "always_invoice") sub.latest_invoice = paidInvoice();
    return sub;
  };
});

const upgrade = (database = db) =>
  changeMailboxPlan({ db: database, stripe, now }, catalog, {
    teamId,
    userId,
    priceId: equipe.priceId,
  });
const plan = async () =>
  (
    await db
      .select()
      .from(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, teamId))
  )[0]!;
async function online() {
  await db
    .update(schema.domains)
    .set({ name: `mail-review-${sequence}.online` })
    .where(eq(schema.domains.teamId, teamId));
}
async function contentHold() {
  expect(await holdOnContentVerdict(db, { teamId, score: 99, categories: ["phishing"] })).toBe(
    true,
  );
}

describe("Correio chargeable upgrades require current sending eligibility", () => {
  it.each([
    ["online", "domain_review"],
    ["content", "send_review"],
    ["suspended", "suspended"],
    ["paused", "guardrail_paused"],
    ["no_domain", "domain_required"],
  ] as const)(
    "rejects %s before any provider request and keeps the paid Solo contract",
    async (restriction, code) => {
      if (restriction === "online") await online();
      if (restriction === "content") await contentHold();
      if (restriction === "suspended")
        await db
          .update(schema.teams)
          .set({ suspendedAt: new Date() })
          .where(eq(schema.teams.id, teamId));
      if (restriction === "paused")
        await db.insert(schema.teamStandings).values({ teamId, guardrail: "paused" });
      if (restriction === "no_domain")
        await db
          .update(schema.domains)
          .set({ status: "pending", verifiedAt: null })
          .where(eq(schema.domains.teamId, teamId));
      const before = await plan();
      await expect(upgrade()).rejects.toMatchObject({ code });
      expect(state.calls).toEqual([]);
      expect(state.updates).toEqual([]);
      expect(await plan()).toEqual(before);
      if (restriction === "online") {
        const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
        expect(team).toMatchObject({
          sendReviewReason: "new_sender",
          sendReviewAt: expect.any(Date),
        });
      }
    },
  );

  it("does not let an unprivileged member prepare a domain hold or charge", async () => {
    await online();
    await db
      .update(schema.teamMembers)
      .set({ role: "member" })
      .where(eq(schema.teamMembers.teamId, teamId));
    await expect(upgrade()).rejects.toMatchObject({ code: "forbidden" });
    expect(state.calls).toEqual([]);
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    expect(team?.sendReviewAt).toBeNull();
  });

  it.each(["common", "approved_online"] as const)(
    "applies a paid Equipe upgrade for %s without a false block",
    async (domain) => {
      if (domain === "approved_online") {
        await online();
        await db
          .update(schema.teams)
          .set({ sendReviewClearedAt: new Date() })
          .where(eq(schema.teams.id, teamId));
      }
      await expect(upgrade()).resolves.toEqual({ planCode: "equipe", direction: "upgrade" });
      expect(state.updates).toHaveLength(1);
      expect(state.updates[0]?.[1]).toMatchObject({
        proration_behavior: "always_invoice",
        payment_behavior: "error_if_incomplete",
      });
      expect(await plan()).toMatchObject({
        planCode: "equipe",
        status: "active",
        seats: 10,
        includedOutboundPerMailbox: 10000,
      });
    },
  );

  it("still rejects phishing after the .online domain was cleared", async () => {
    await online();
    await db
      .update(schema.teams)
      .set({ sendReviewClearedAt: new Date() })
      .where(eq(schema.teams.id, teamId));
    await contentHold();
    await expect(upgrade()).rejects.toMatchObject({ code: "send_review" });
    expect(state.calls).toEqual([]);
  });

  it("ends a valid trial only when dispatching the approved paid upgrade", async () => {
    sub.status = "trialing";
    sub.trial_start = PERIOD_START;
    sub.trial_end = sub.items.data[0]!.current_period_end;
    await project(solo);
    await expect(upgrade()).resolves.toMatchObject({ direction: "upgrade" });
    expect(state.updates[0]?.[1]).toMatchObject({
      trial_end: "now",
      proration_behavior: "always_invoice",
    });
  });

  it("rechecks a hold committed after preflight before reading Stripe", async () => {
    const original = db.transaction.bind(db);
    const racing = Object.create(db) as Db;
    let injected = false;
    racing.transaction = (async (...args: Parameters<Db["transaction"]>) => {
      const value = await original(...args);
      if (!injected) {
        injected = true;
        await contentHold();
      }
      return value;
    }) as Db["transaction"];
    await expect(upgrade(racing)).rejects.toMatchObject({ code: "send_review" });
    expect(injected).toBe(true);
    expect(state.calls).toEqual([]);
    expect(await plan()).toMatchObject({ planCode: "solo", seats: 1 });
  });

  it("rechecks a guardrail changed during provider read before the prorated write", async () => {
    const original = db.transaction.bind(db);
    const racing = Object.create(db) as Db;
    let current: Db | undefined;
    racing.transaction = ((callback: Parameters<Db["transaction"]>[0]) =>
      original(async (tx) => {
        current = tx as unknown as Db;
        try {
          return await callback(tx);
        } finally {
          current = undefined;
        }
      })) as Db["transaction"];
    const retrieve = stripe.subscriptions.retrieve;
    let injected = false;
    stripe.subscriptions.retrieve = async (...args) => {
      const value = await retrieve(...args);
      if (!injected) {
        injected = true;
        if (!current) throw new Error("Expected locked provider stage");
        await current.insert(schema.teamStandings).values({ teamId, guardrail: "paused" });
      }
      return value;
    };
    await expect(upgrade(racing)).rejects.toMatchObject({ code: "guardrail_paused" });
    expect(injected).toBe(true);
    expect(state.updates).toEqual([]);
    expect(await plan()).toMatchObject({ planCode: "solo", seats: 1 });
  });

  it("preserves a no-charge downgrade while sending is under review", async () => {
    await project(equipe);
    await contentHold();
    await expect(
      changeMailboxPlan({ db, stripe, now }, catalog, { teamId, userId, priceId: solo.priceId }),
    ).resolves.toMatchObject({ direction: "downgrade" });
    expect(state.updates[0]?.[1]).toMatchObject({ proration_behavior: "none" });
    expect(await plan()).toMatchObject({ planCode: "solo", seats: 1 });
  });

  it("preserves cancellation and resume without an immediate charge while under review", async () => {
    await contentHold();
    for (const action of ["cancel", "resume"] as const)
      await expect(
        manageMailboxSubscription({ db, stripe, now }, catalog, { teamId, userId, action }),
      ).resolves.toMatchObject({ status: "confirmed" });
    expect(state.updates).toHaveLength(2);
    for (const [, params] of state.updates) expect(params.proration_behavior).toBe("none");
  });

  it("also gates a legacy seat increase before any provider request", async () => {
    await project(legacy, 2);
    await online();
    const before = await plan();
    await expect(
      manageMailboxSubscription({ db, stripe, now }, catalog, {
        teamId,
        userId,
        action: "quantity",
        seats: 3,
      }),
    ).rejects.toBeInstanceOf(PurchaseEligibilityError);
    expect(state.calls).toEqual([]);
    expect(await plan()).toEqual(before);
  });

  it("closes a known undispatched legacy increase when review appears after arming", async () => {
    await project(legacy, 2);
    const original = db.transaction.bind(db);
    const racing = Object.create(db) as Db;
    let transactions = 0;
    racing.transaction = (async (...args: Parameters<Db["transaction"]>) => {
      transactions++;
      const value = await original(...args);
      if (transactions === 3) await contentHold();
      return value;
    }) as Db["transaction"];
    await expect(
      manageMailboxSubscription({ db: racing, stripe, now }, catalog, {
        teamId,
        userId,
        action: "quantity",
        seats: 3,
      }),
    ).rejects.toMatchObject({ code: "send_review" });
    expect(state.updates).toEqual([]);
    expect(await plan()).toMatchObject({ seats: 2 });
    const [request] = await db
      .select()
      .from(schema.mailboxManagementRequests)
      .where(eq(schema.mailboxManagementRequests.teamId, teamId));
    expect(request?.status).toBe("expired");
    await expect(
      manageMailboxSubscription({ db, stripe, now }, catalog, { teamId, userId, action: "cancel" }),
    ).resolves.toMatchObject({ status: "confirmed" });
    expect(state.updates[0]?.[1]).toMatchObject({
      cancel_at_period_end: true,
      proration_behavior: "none",
    });
  });

  it("preserves a legacy seat reduction under review", async () => {
    await project(legacy, 2);
    await contentHold();
    const sentinel = new Error("STOP_AT_NO_CHARGE_REDUCTION_SCHEDULE");
    stripe.subscriptionSchedules.retrieve = async () => {
      throw new Error("No schedule to retrieve");
    };
    stripe.subscriptionSchedules.create = async () => {
      throw sentinel;
    };
    const value = await manageMailboxSubscription({ db, stripe, now }, catalog, {
      teamId,
      userId,
      action: "quantity",
      seats: 1,
    });
    expect(value.status).toBe("pending");
    expect(state.updates).toEqual([]);
    expect(await plan()).toMatchObject({ seats: 2 });
  });
});
