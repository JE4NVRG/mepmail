import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mailboxManagementRequests } from "../../db/src/schema/mailbox-management-requests.js";
import type { MailboxCatalog } from "../src/mailbox.js";
import {
  MAILBOX_ADDON_GRACE_MS,
  type MailboxRepricedChange,
  mailboxCatalogFromJson,
  repriceMailboxAddOnsWithoutSending,
} from "../src/mailbox-reprice.js";

const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
const NOW = new Date("2026-11-01T12:00:00Z");
const DAY = 86_400_000;
const terms = (priceId: string, unitAmount: number, interval: "month" | "year", gib: number) => ({
  priceId,
  currency: "usd",
  unitAmount,
  interval,
  storageBytesPerMailbox: gib * 1024 ** 3,
  includedOutboundPerMailbox: gib === 1 ? 500 : 2000,
});
const CATALOG: MailboxCatalog = {
  livemode: false,
  checkoutPriceId: "price_addon_1g_month",
  checkoutPriceIds: ["price_addon_1g_month", "price_addon_10g_year"],
  standalonePriceIds: ["price_solo_month", "price_solo_year"],
  prices: [
    terms("price_addon_1g_month", 590, "month", 1),
    terms("price_addon_10g_year", 9900, "year", 10),
    terms("price_solo_month", 1290, "month", 10),
    terms("price_solo_year", 12900, "year", 10),
  ],
};

let db: Db;
let close: () => Promise<void>;
let teamId: string;

function fakeStripe(
  overrides: Partial<Stripe.Subscription> = {},
  priceId = "price_addon_1g_month",
) {
  const updates: { id: string; params: Stripe.SubscriptionUpdateParams; key?: string }[] = [];
  const stripe = {
    subscriptions: {
      retrieve: async (id: string) =>
        ({
          id,
          status: "active",
          cancel_at_period_end: false,
          cancel_at: null,
          schedule: null,
          pending_update: null,
          livemode: false,
          customer: "cus_reprice",
          items: {
            data: [
              {
                id: "si_reprice",
                quantity: 2,
                current_period_end: Math.floor((NOW.getTime() + 20 * DAY) / 1000),
                price: { id: priceId },
              },
            ],
          },
          ...overrides,
        }) as unknown as Stripe.Subscription,
      update: async (
        id: string,
        params: Stripe.SubscriptionUpdateParams,
        options?: Stripe.RequestOptions,
      ) => {
        updates.push({
          id,
          params,
          ...(options?.idempotencyKey ? { key: options.idempotencyKey } : {}),
        });
        return {} as Stripe.Subscription;
      },
      list: async () => ({}) as Stripe.ApiList<Stripe.Subscription>,
      cancel: async () => ({}) as Stripe.Subscription,
    },
  };
  return { stripe, updates };
}

async function seed(options: {
  priceId?: string;
  interval?: "month" | "year";
  sendEnded?: Date | null;
}) {
  const priceId = options.priceId ?? "price_addon_1g_month";
  await db
    .update(schema.teams)
    .set({
      plan: "free",
      planStatus: "canceled",
      stripeCustomerId: "cus_reprice",
      stripeSubscriptionId: null,
      currentPeriodStart: null,
      currentPeriodEnd:
        options.sendEnded === undefined ? new Date(NOW.getTime() - 10 * DAY) : options.sendEnded,
      sendBillingContract: null,
    })
    .where(eq(schema.teams.id, teamId));
  await db.insert(schema.mailboxSubscriptions).values({
    teamId,
    status: "active",
    seats: 2,
    storageBytesPerMailbox: 1024 ** 3,
    includedOutboundPerMailbox: 500,
    periodStart: new Date(NOW.getTime() - 10 * DAY),
    periodEnd: new Date(NOW.getTime() + 20 * DAY),
    stripeCustomerId: "cus_reprice",
    stripeSubscriptionId: "sub_reprice",
    stripeSubscriptionItemId: "si_reprice",
    stripePriceId: priceId,
    currency: "usd",
    unitAmount: 590,
    interval: options.interval ?? "month",
    livemode: false,
  });
}

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  for (const name of readdirSync(extension)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + name, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean))
      await db.execute(sql.raw(statement));
  teamId = await createTeam(db);
});
afterEach(() => close());

describe("repriceMailboxAddOnsWithoutSending", () => {
  it("moves an add-on contract past Envio's grace to the standalone price at renewal, once, and tells", async () => {
    await seed({});
    const { stripe, updates } = fakeStripe();
    const notices: MailboxRepricedChange[] = [];
    const result = await repriceMailboxAddOnsWithoutSending({
      db,
      stripe,
      catalog: CATALOG,
      now: NOW,
      notify: async (change) => {
        notices.push(change);
      },
    });
    expect(result).toEqual({ checked: 1, repriced: 1 });
    expect(updates).toEqual([
      {
        id: "sub_reprice",
        params: {
          items: [{ id: "si_reprice", price: "price_solo_month" }],
          proration_behavior: "none",
        },
        key: "mailbox-reprice:sub_reprice:price_solo_month",
      },
    ]);
    expect(notices).toEqual([
      {
        teamId,
        stripeSubscriptionId: "sub_reprice",
        seats: 2,
        interval: "month",
        currency: "usd",
        fromUnitAmount: 590,
        toUnitAmount: 1290,
        effectiveAt: new Date(Math.floor((NOW.getTime() + 20 * DAY) / 1000) * 1000),
      },
    ]);
  });

  it("keeps the yearly interval on a yearly add-on", async () => {
    await seed({ priceId: "price_addon_10g_year", interval: "year" });
    const { stripe, updates } = fakeStripe({}, "price_addon_10g_year");
    await repriceMailboxAddOnsWithoutSending({ db, stripe, catalog: CATALOG, now: NOW });
    expect(updates[0]?.params.items).toEqual([{ id: "si_reprice", price: "price_solo_year" }]);
  });

  it.each([
    [
      "still inside the grace",
      { sendEnded: new Date(NOW.getTime() - MAILBOX_ADDON_GRACE_MS + DAY) },
      {},
    ],
    ["already on the standalone price", { priceId: "price_solo_month" }, {}],
    ["cancelling at period end", {}, { cancel_at_period_end: true }],
    ["under a schedule", {}, { schedule: "sub_sched_1" }],
    ["with a pending update", {}, { pending_update: {} as Stripe.Subscription.PendingUpdate }],
    [
      "no longer matching the stored price",
      {},
      { items: { data: [{ id: "si_reprice", price: { id: "price_other" } }] } },
    ],
  ] as const)("leaves it alone when %s", async (_label, seedOptions, subOverrides) => {
    await seed(seedOptions);
    const { stripe, updates } = fakeStripe(subOverrides as Partial<Stripe.Subscription>);
    const result = await repriceMailboxAddOnsWithoutSending({
      db,
      stripe,
      catalog: CATALOG,
      now: NOW,
    });
    expect(result.repriced).toBe(0);
    expect(updates).toEqual([]);
  });

  it("waits while a management request is open", async () => {
    await seed({});
    await db.insert(mailboxManagementRequests).values({
      teamId,
      action: "decrease",
      status: "scheduled",
      step: "create_schedule",
      seatsBefore: 2,
      seats: 1,
      periodStart: new Date(NOW.getTime() - 10 * DAY),
      periodEnd: new Date(NOW.getTime() + 20 * DAY),
      stripeCustomerId: "cus_reprice",
      stripeSubscriptionId: "sub_reprice",
      stripeSubscriptionItemId: "si_reprice",
      stripePriceId: "price_addon_1g_month",
      livemode: false,
      idempotencyKey: "fixture-open-request",
    });
    const { stripe, updates } = fakeStripe();
    expect(
      (await repriceMailboxAddOnsWithoutSending({ db, stripe, catalog: CATALOG, now: NOW }))
        .repriced,
    ).toBe(0);
    expect(updates).toEqual([]);
  });

  it("does nothing without standalone prices", async () => {
    await seed({});
    const { stripe, updates } = fakeStripe();
    expect(
      await repriceMailboxAddOnsWithoutSending({
        db,
        stripe,
        catalog: { ...CATALOG, standalonePriceIds: [] },
        now: NOW,
      }),
    ).toEqual({ checked: 0, repriced: 0 });
    expect(updates).toEqual([]);
  });
});

describe("mailboxCatalogFromJson", () => {
  it("reads the operator catalog only in its own Stripe mode and with known standalone prices", () => {
    const raw = JSON.stringify(CATALOG);
    expect(mailboxCatalogFromJson(raw, false)).toMatchObject({
      standalonePriceIds: ["price_solo_month", "price_solo_year"],
    });
    expect(mailboxCatalogFromJson(raw, true)).toBeNull();
    expect(
      mailboxCatalogFromJson(
        JSON.stringify({ ...CATALOG, standalonePriceIds: ["price_unknown"] }),
        false,
      ),
    ).toBeNull();
    expect(mailboxCatalogFromJson("{", false)).toBeNull();
    expect(mailboxCatalogFromJson(undefined, false)).toBeNull();
  });
});
