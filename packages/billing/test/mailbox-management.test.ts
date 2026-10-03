import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { MailboxCatalog } from "../src/mailbox.js";
import { applyMailboxSubscription } from "../src/mailbox-lifecycle.js";
import { manageMailboxSubscription } from "../src/mailbox-management.js";
import type { BillingStripe } from "../src/stripe.js";
import { fakeStripe, PERIOD_END, PERIOD_START, subscription } from "./helpers.js";

const terms = {
  priceId: "price_mail_management_fixture",
  currency: "usd",
  unitAmount: 123,
  interval: "month" as const,
  storageBytesPerMailbox: 4096,
  includedOutboundPerMailbox: 7,
};
const catalog: MailboxCatalog = {
  livemode: false,
  checkoutPriceId: terms.priceId,
  prices: [terms],
};
const now = () => new Date((PERIOD_START + 1000) * 1000);
const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
let db: Db,
  close: () => Promise<void>,
  teamId: string,
  user: string,
  customer: string,
  sequence = 0;
let sub: Stripe.Subscription, stripe: ReturnType<typeof fakeStripe>["stripe"];
let update: Mock<BillingStripe["subscriptions"]["update"]>,
  createSchedule: Mock<BillingStripe["subscriptionSchedules"]["create"]>,
  scheduleUpdate: Mock<BillingStripe["subscriptionSchedules"]["update"]>,
  release: Mock<BillingStripe["subscriptionSchedules"]["release"]>;
let paid: boolean, schedule: Stripe.SubscriptionSchedule | null;
const run = (action: "cancel" | "resume" | "quantity" | "reconcile", seats?: number) =>
  manageMailboxSubscription({ db, stripe, now }, catalog, {
    teamId,
    userId: user,
    action,
    ...(seats !== undefined ? { seats } : {}),
  });
const plan = async () =>
  (
    await db
      .select()
      .from(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, teamId))
  )[0]!;
function invoice(
  status: "paid" | "open" | "void" = "paid",
  id = "in_management_fixture",
  seats = sub.items.data[0]!.quantity!,
) {
  const item = sub.items.data[0]!;
  return {
    id,
    object: "invoice",
    customer,
    livemode: false,
    currency: terms.currency,
    status,
    billing_reason: "subscription_update",
    amount_remaining: status === "open" ? 123 : 0,
    lines: {
      object: "list",
      has_more: false,
      data: [
        {
          id: `il_${id}`,
          object: "line_item",
          invoice: id,
          livemode: false,
          currency: terms.currency,
          amount: terms.unitAmount * seats,
          quantity: seats,
          pricing: {
            type: "price_details",
            price_details: { price: terms.priceId },
            unit_amount_decimal: Stripe.Decimal.from(terms.unitAmount),
          },
          period: { start: PERIOD_START + 1000, end: PERIOD_END },
          parent: {
            type: "subscription_item_details",
            subscription_item_details: {
              subscription: sub.id,
              subscription_item: item.id,
              proration: true,
              proration_details: null,
            },
          },
        },
      ],
    },
    parent: { type: "subscription_details", subscription_details: { subscription: sub.id } },
    hosted_invoice_url: `https://invoice.stripe.com/i/${id}`,
  } as unknown as Stripe.Invoice;
}
function subscriptionReadback(): Stripe.Subscription {
  const readback = structuredClone(sub);
  const sourceInvoice = sub.latest_invoice;
  const copiedInvoice = readback.latest_invoice;
  if (
    sourceInvoice &&
    typeof sourceInvoice === "object" &&
    copiedInvoice &&
    typeof copiedInvoice === "object"
  ) {
    // Decimal values are immutable SDK objects; structuredClone discards their methods.
    copiedInvoice.lines.data = sourceInvoice.lines.data.map((line) => ({
      ...structuredClone(line),
      pricing: line.pricing
        ? {
            ...structuredClone(line.pricing),
            unit_amount_decimal: line.pricing.unit_amount_decimal,
          }
        : null,
    }));
  }
  return readback;
}
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  for (const name of readdirSync(extension)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + name, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean))
      await db.execute(sql.raw(statement));
});
afterAll(async () => close());
beforeEach(async () => {
  sequence++;
  customer = `cus_management_${sequence}`;
  user = `management_user_${sequence}`;
  teamId = await createTeam(db, `mail-management-${sequence}`);
  await db
    .update(schema.teams)
    .set({ stripeCustomerId: customer })
    .where(eq(schema.teams.id, teamId));
  await db.insert(schema.user).values({
    id: user,
    name: "Management fixture",
    email: `management_${sequence}@example.invalid`,
  });
  await db.insert(schema.teamMembers).values({ teamId, userId: user, role: "owner" });
  ({ stripe } = fakeStripe());
  paid = true;
  schedule = null;
  sub = subscription(`sub_management_${sequence}`, customer, "active");
  sub.metadata = { mepmail_service: "mailbox" };
  sub.livemode = false;
  sub.created = PERIOD_START - 100;
  sub.cancel_at_period_end = false;
  sub.pending_update = null;
  sub.schedule = null;
  sub.collection_method = "charge_automatically";
  sub.discounts = [];
  const item = sub.items.data[0]!;
  item.quantity = 3;
  item.price = {
    ...item.price,
    id: terms.priceId,
    currency: terms.currency,
    unit_amount: terms.unitAmount,
    billing_scheme: "per_unit",
    recurring: { ...item.price.recurring!, interval_count: 1, usage_type: "licensed" },
    transform_quantity: null,
  };
  sub.latest_invoice = invoice("paid", "in_previous_fixture");
  stripe.subscriptions.retrieve = vi.fn(async () => subscriptionReadback());
  update = vi.fn(
    async (
      _id: string,
      params: Stripe.SubscriptionUpdateParams = {},
      _options?: Stripe.RequestOptions,
    ) => {
      if (params.cancel_at_period_end !== undefined) {
        sub.cancel_at_period_end = params.cancel_at_period_end;
        sub.cancel_at = params.cancel_at_period_end ? PERIOD_END : null;
      }
      if (params.items) {
        sub.latest_invoice = invoice(
          paid ? "paid" : "open",
          "in_management_fixture",
          params.items[0]!.quantity!,
        );
        if (paid) {
          sub.items.data[0]!.quantity = params.items[0]!.quantity!;
          sub.pending_update = null;
        } else
          sub.pending_update = {
            expires_at: PERIOD_END,
            subscription_items: [
              {
                id: sub.items.data[0]!.id,
                price: terms.priceId,
                quantity: params.items[0]!.quantity!,
              },
            ],
          } as unknown as Stripe.Subscription.PendingUpdate;
      }
      return subscriptionReadback();
    },
  );
  stripe.subscriptions.update = update;
  createSchedule = vi.fn(
    async (_params: Stripe.SubscriptionScheduleCreateParams, _options?: Stripe.RequestOptions) => {
      schedule = {
        id: `sched_management_${sequence}`,
        customer,
        subscription: sub.id,
        livemode: false,
        status: "active",
        end_behavior: "release",
        metadata: {},
        phases: [
          {
            start_date: PERIOD_START,
            end_date: PERIOD_END,
            items: [{ price: terms.priceId, quantity: 3 }],
            proration_behavior: "none",
          },
        ],
      } as unknown as Stripe.SubscriptionSchedule;
      sub.schedule = schedule;
      return structuredClone(schedule);
    },
  );
  scheduleUpdate = vi.fn(
    async (
      _id: string,
      params: Stripe.SubscriptionScheduleUpdateParams,
      _options?: Stripe.RequestOptions,
    ) => {
      schedule!.metadata = params.metadata as Stripe.Metadata;
      schedule!.phases = params.phases!.map((p) => ({
        ...p,
        end_date: p.end_date ?? PERIOD_END + 2592000,
      })) as unknown as Stripe.SubscriptionSchedule.Phase[];
      sub.schedule = schedule;
      return structuredClone(schedule!);
    },
  );
  release = vi.fn(async () => {
    schedule!.status = "released";
    sub.schedule = null;
    return structuredClone(schedule!);
  });
  stripe.subscriptionSchedules = {
    create: createSchedule,
    update: scheduleUpdate,
    release,
    retrieve: vi.fn(async () => structuredClone(schedule!)),
  };
  await applyMailboxSubscription(db, sub, catalog, PERIOD_START + 100);
});

describe("Mail self-service with provider fake and real optional SQL", () => {
  it("cancels at period end, resumes, keeps quantity and the verified event watermark", async () => {
    expect(await run("cancel")).toMatchObject({ status: "confirmed" });
    expect(await plan()).toMatchObject({
      status: "active",
      seats: 3,
      cancelAtPeriodEnd: true,
      lastEventCreated: PERIOD_START + 100,
    });
    expect(update.mock.calls[0]![1]).toEqual({
      cancel_at_period_end: true,
      proration_behavior: "none",
    });
    expect(await run("cancel")).toMatchObject({ status: "confirmed" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(await run("resume")).toMatchObject({ status: "confirmed" });
    expect((await plan()).cancelAtPeriodEnd).toBe(false);
    expect(update.mock.calls[1]![2]).toHaveProperty("idempotencyKey");
  });
  it("refuses resume after the period and never resurrects a terminal subscription", async () => {
    sub.cancel_at_period_end = true;
    sub.items.data[0]!.current_period_end = PERIOD_START + 999;
    await expect(run("resume")).rejects.toMatchObject({ code: "expired" });
    expect(update).not.toHaveBeenCalled();
    sub.status = "canceled";
    await expect(run("resume")).rejects.toMatchObject({ code: "expired" });
  });
  it("keeps seats while payment is pending and releases them only after invoice paid readback", async () => {
    paid = false;
    expect(await run("quantity", 5)).toMatchObject({
      status: "pending",
      paymentUrl: "https://invoice.stripe.com/i/in_management_fixture",
    });
    expect((await plan()).seats).toBe(3);
    expect(update.mock.calls[0]![1]).toMatchObject({
      payment_behavior: "pending_if_incomplete",
      proration_behavior: "always_invoice",
      items: [{ id: sub.items.data[0]!.id, price: terms.priceId, quantity: 5 }],
    });
    await run("reconcile");
    expect(update).toHaveBeenCalledTimes(1);
    expect((await plan()).seats).toBe(3);
    sub.pending_update = null;
    sub.items.data[0]!.quantity = 5;
    sub.latest_invoice = invoice("paid");
    expect(await run("reconcile")).toMatchObject({ status: "confirmed" });
    expect((await plan()).seats).toBe(5);
    expect(update).toHaveBeenCalledTimes(1);
  });
  it("does not grant an increased quantity from an unpaid webhook snapshot", async () => {
    paid = false;
    await run("quantity", 5);
    sub.items.data[0]!.quantity = 5;
    sub.pending_update = null;
    expect((await applyMailboxSubscription(db, sub, catalog, PERIOD_START + 200)).applied).toBe(
      false,
    );
    expect((await plan()).seats).toBe(3);
    sub.latest_invoice = invoice("paid");
    await applyMailboxSubscription(db, sub, catalog, PERIOD_START + 201);
    expect((await plan()).seats).toBe(5);
  });
  it("rejects invoice ownership/mode/subscription mismatch even when marked paid", async () => {
    paid = false;
    await run("quantity", 5);
    sub.items.data[0]!.quantity = 5;
    sub.pending_update = null;
    for (const mutation of [
      (i: Stripe.Invoice) => {
        i.customer = "cus_other";
      },
      (i: Stripe.Invoice) => {
        i.livemode = true;
      },
      (i: Stripe.Invoice) => {
        i.parent!.subscription_details!.subscription = "sub_other";
      },
    ]) {
      const i = invoice("paid");
      mutation(i);
      sub.latest_invoice = i;
      await run("reconcile");
      expect((await plan()).seats).toBe(3);
    }
    expect(update).toHaveBeenCalledTimes(1);
  });
  it.each([
    "missing_lines",
    "incomplete_lines",
    "duplicate_debit",
    "credit",
    "zero_debit",
    "credited_debit",
    "invoice",
    "item",
    "price",
    "quantity",
    "currency",
    "unit_amount",
    "period",
    "proration_date",
  ])("never grants or offers payment for incompatible increase evidence: %s", async (field) => {
    paid = false;
    await run("quantity", 5);
    sub.items.data[0]!.quantity = 5;
    sub.pending_update = null;
    const evidence = invoice("paid"),
      line = evidence.lines.data[0]!;
    if (field === "missing_lines") evidence.lines.data = [];
    if (field === "incomplete_lines") evidence.lines.has_more = true;
    if (field === "duplicate_debit") evidence.lines.data.push({ ...line });
    if (field === "credit") line.amount = -123;
    if (field === "zero_debit") line.amount = 0;
    if (field === "credited_debit")
      line.parent!.subscription_item_details!.proration_details = {
        credited_items: { invoice: "in_credit_source", invoice_line_items: ["il_credit_source"] },
      };
    if (field === "invoice") line.invoice = "in_other";
    if (field === "item") line.parent!.subscription_item_details!.subscription_item = "si_other";
    if (field === "price") line.pricing!.price_details!.price = "price_other";
    if (field === "quantity") line.quantity = 3;
    if (field === "currency") line.currency = "eur";
    if (field === "unit_amount") {
      if (!line.pricing) throw new Error("Expected pricing on the increase debit fixture");
      line.pricing.unit_amount_decimal = Stripe.Decimal.from(999);
    }
    if (field === "period") line.period.end = PERIOD_END - 1;
    if (field === "proration_date") line.period.start++;
    sub.latest_invoice = evidence;
    expect(await run("reconcile")).toMatchObject({ status: "pending", paymentUrl: null });
    expect((await plan()).seats).toBe(3);
    expect(update).toHaveBeenCalledTimes(1);
    evidence.status = "open";
    expect(await run("reconcile")).toMatchObject({ status: "pending", paymentUrl: null });
  });
  it("does not bind an unrelated invoice after an unknown increase write and later accepts the exact debit without replay", async () => {
    stripe.subscriptions.update = vi.fn(async () => {
      throw new Error("unknown request");
    });
    await run("quantity", 5);
    sub.items.data[0]!.quantity = 5;
    sub.latest_invoice = invoice("open", "in_unrelated_fixture", 3);
    expect(await run("reconcile")).toMatchObject({ status: "pending", paymentUrl: null });
    const [pending] = await db
      .select()
      .from(schema.mailboxManagementRequests)
      .where(eq(schema.mailboxManagementRequests.teamId, teamId));
    expect(pending!.stripeInvoiceId).toBeNull();
    expect((await plan()).seats).toBe(3);
    sub.latest_invoice = invoice("paid", "in_exact_recovered_fixture", 5);
    expect(await run("reconcile")).toMatchObject({ status: "confirmed" });
    expect((await plan()).seats).toBe(5);
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
  });
  it("reads a lost successful increase response without sending another financial update", async () => {
    const write = stripe.subscriptions.update;
    stripe.subscriptions.update = vi.fn(
      async (...args: Parameters<BillingStripe["subscriptions"]["update"]>) => {
        await write(...args);
        throw new Error("lost response");
      },
    );
    expect(await run("quantity", 5)).toMatchObject({ status: "pending" });
    expect((await plan()).seats).toBe(3);
    expect(await run("reconcile")).toMatchObject({ status: "confirmed" });
    expect((await plan()).seats).toBe(5);
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
  });
  it("keeps a fully unknown write blocked, with no wall-clock expiry or replay", async () => {
    stripe.subscriptions.update = vi.fn(async () => {
      throw new Error("unknown request");
    });
    await run("quantity", 5);
    await run("reconcile");
    await run("quantity", 5);
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect((await plan()).seats).toBe(3);
    await expect(run("quantity", 6)).rejects.toMatchObject({ code: "conflict" });
  });
  it("schedules a reduction at renewal without changing the current grant", async () => {
    expect(await run("quantity", 2)).toMatchObject({
      status: "scheduled",
      scheduledSeats: 2,
      effectiveAt: new Date(PERIOD_END * 1000),
    });
    expect((await plan()).seats).toBe(3);
    expect(update).not.toHaveBeenCalled();
    expect(createSchedule.mock.calls[0]![0]).toEqual({ from_subscription: sub.id });
    expect(scheduleUpdate.mock.calls[0]![1]).toMatchObject({
      proration_behavior: "none",
      phases: [
        { end_date: PERIOD_END, items: [{ price: terms.priceId, quantity: 3 }] },
        {
          start_date: PERIOD_END,
          items: [{ price: terms.priceId, quantity: 2 }],
          proration_behavior: "none",
        },
      ],
    });
    sub.items.data[0]!.quantity = 2;
    sub.items.data[0]!.current_period_start = PERIOD_END;
    sub.items.data[0]!.current_period_end = PERIOD_END + 2592000;
    await applyMailboxSubscription(db, sub, catalog, PERIOD_END + 1);
    expect((await plan()).seats).toBe(2);
    expect(
      (
        await db
          .select()
          .from(schema.mailboxManagementRequests)
          .where(eq(schema.mailboxManagementRequests.teamId, teamId))
      )[0]!.status,
    ).toBe("confirmed");
  });
  it("cancellation releases only its known future reduction and preserves current quantity", async () => {
    await run("quantity", 2);
    expect(await run("cancel")).toMatchObject({ status: "confirmed" });
    expect(release).toHaveBeenCalledTimes(1);
    expect((await plan()).seats).toBe(3);
    expect((await plan()).cancelAtPeriodEnd).toBe(true);
  });
  it("preserves an unknown third schedule phase instead of releasing it with its own reduction", async () => {
    await run("quantity", 2);
    schedule!.phases.push({
      ...structuredClone(schedule!.phases[1]!),
      start_date: PERIOD_END + 2592000,
      end_date: PERIOD_END + 5184000,
    });
    sub.schedule = schedule;
    await expect(run("cancel")).rejects.toMatchObject({ code: "conflict" });
    expect(release).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(schedule!.phases).toHaveLength(3);
  });
  it("does not confirm a lost configuration response after an unknown phase was added", async () => {
    const write = stripe.subscriptionSchedules.update;
    stripe.subscriptionSchedules.update = vi.fn(
      async (...args: Parameters<BillingStripe["subscriptionSchedules"]["update"]>) => {
        await write(...args);
        throw new Error("lost schedule response");
      },
    );
    await run("quantity", 2);
    schedule!.phases.push({
      ...structuredClone(schedule!.phases[1]!),
      start_date: PERIOD_END + 2592000,
      end_date: PERIOD_END + 5184000,
    });
    sub.schedule = schedule;
    expect(await run("reconcile")).toMatchObject({ status: "pending", scheduledSeats: null });
    expect(stripe.subscriptionSchedules.update).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });
  it("expires a terminal contract's scheduled reduction without deleting its history", async () => {
    await run("quantity", 2);
    const [before] = await db
      .select()
      .from(schema.mailboxManagementRequests)
      .where(eq(schema.mailboxManagementRequests.teamId, teamId));
    sub.status = "canceled";
    sub.schedule = null;
    await applyMailboxSubscription(db, sub, catalog, PERIOD_START + 200);
    const [after] = await db
      .select()
      .from(schema.mailboxManagementRequests)
      .where(eq(schema.mailboxManagementRequests.id, before!.id));
    expect(after).toMatchObject({
      id: before!.id,
      status: "expired",
      seats: 2,
      stripeSubscriptionId: sub.id,
      stripeScheduleId: before!.stripeScheduleId,
    });
    expect(await run("reconcile")).toMatchObject({ status: "expired", scheduledSeats: null });
    expect(release).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
  it("closes an unknown schedule attempt only after authoritative terminal readback, without replay", async () => {
    const write = stripe.subscriptionSchedules.create;
    stripe.subscriptionSchedules.create = vi.fn(
      async (...args: Parameters<BillingStripe["subscriptionSchedules"]["create"]>) => {
        await write(...args);
        throw new Error("lost schedule id");
      },
    );
    await run("quantity", 2);
    sub.status = "canceled";
    sub.schedule = null;
    await applyMailboxSubscription(db, sub, catalog, PERIOD_START + 200);
    const [history] = await db
      .select()
      .from(schema.mailboxManagementRequests)
      .where(eq(schema.mailboxManagementRequests.teamId, teamId));
    expect(history).toMatchObject({
      status: "expired",
      action: "decrease",
      seats: 2,
      stripeScheduleId: null,
    });
    expect(await run("reconcile")).toMatchObject({ status: "expired", scheduledSeats: null });
    expect(stripe.subscriptionSchedules.create).toHaveBeenCalledTimes(1);
    expect(scheduleUpdate).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
  it("does not dispatch a prepared financial intent after the subscription becomes terminal", async () => {
    await db.insert(schema.mailboxManagementRequests).values({
      teamId,
      createdBy: user,
      action: "increase",
      status: "prepared",
      step: "update",
      seatsBefore: 3,
      seats: 5,
      periodStart: new Date(PERIOD_START * 1000),
      periodEnd: new Date(PERIOD_END * 1000),
      stripeCustomerId: customer,
      stripeSubscriptionId: sub.id,
      stripeSubscriptionItemId: sub.items.data[0]!.id,
      stripePriceId: terms.priceId,
      livemode: false,
      idempotencyKey: `prepared_terminal:${teamId}`,
      previousInvoiceId: "in_previous_fixture",
      createdAt: now(),
    });
    sub.status = "canceled";
    sub.items.data[0]!.quantity = 5;
    expect(await run("reconcile")).toMatchObject({ status: "expired" });
    const [history] = await db
      .select()
      .from(schema.mailboxManagementRequests)
      .where(eq(schema.mailboxManagementRequests.teamId, teamId));
    expect(history).toMatchObject({ status: "expired", action: "increase", seats: 5 });
    expect(update).not.toHaveBeenCalled();
    expect(createSchedule).not.toHaveBeenCalled();
    expect((await plan()).status).toBe("canceled");
  });
  it("reconciles only management history belonging to the team's current contract", async () => {
    await run("quantity", 2);
    const previous = sub.id;
    // A legacy stale scheduled row must not describe a later verified purchase.
    await db
      .update(schema.mailboxSubscriptions)
      .set({ status: "canceled" })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    sub.id = `${previous}_replacement`;
    sub.created++;
    sub.items.data[0]!.id = `si_${sub.id}`;
    sub.schedule = null;
    await applyMailboxSubscription(db, sub, catalog, PERIOD_START + 200);
    expect(await run("reconcile")).toEqual({
      status: "confirmed",
      scheduledSeats: null,
      effectiveAt: null,
      paymentUrl: null,
    });
    const [history] = await db
      .select()
      .from(schema.mailboxManagementRequests)
      .where(eq(schema.mailboxManagementRequests.teamId, teamId));
    expect(history).toMatchObject({
      stripeSubscriptionId: previous,
      status: "scheduled",
      seats: 2,
    });
  });
  it("recovers a lost schedule-configuration response through exact readback", async () => {
    const write = stripe.subscriptionSchedules.update;
    stripe.subscriptionSchedules.update = vi.fn(
      async (...args: Parameters<BillingStripe["subscriptionSchedules"]["update"]>) => {
        await write(...args);
        throw new Error("lost schedule response");
      },
    );
    expect(await run("quantity", 2)).toMatchObject({ status: "pending" });
    expect(await run("reconcile")).toMatchObject({ status: "scheduled", scheduledSeats: 2 });
    expect(stripe.subscriptionSchedules.update).toHaveBeenCalledTimes(1);
    expect((await plan()).seats).toBe(3);
  });
  it("leaves an unknown schedule creation without a proven ID pending", async () => {
    const write = stripe.subscriptionSchedules.create;
    stripe.subscriptionSchedules.create = vi.fn(
      async (...args: Parameters<BillingStripe["subscriptionSchedules"]["create"]>) => {
        await write(...args);
        throw new Error("lost schedule id");
      },
    );
    await run("quantity", 2);
    expect(await run("reconcile")).toMatchObject({ status: "pending" });
    expect(stripe.subscriptionSchedules.create).toHaveBeenCalledTimes(1);
    expect(scheduleUpdate).not.toHaveBeenCalled();
  });
  it("refuses foreign schedules and a missing schedule reader before writes", async () => {
    sub.schedule = "sched_other";
    await expect(run("quantity", 2)).rejects.toMatchObject({ code: "conflict" });
    sub.schedule = null;
    delete stripe.subscriptionSchedules.retrieve;
    await expect(run("quantity", 2)).rejects.toMatchObject({ code: "unavailable" });
    expect(createSchedule).not.toHaveBeenCalled();
  });
  it("rejects nonempty phase taxes before configuring a reduction", async () => {
    const create = stripe.subscriptionSchedules.create;
    stripe.subscriptionSchedules.create = vi.fn(
      async (...args: Parameters<BillingStripe["subscriptionSchedules"]["create"]>) => {
        await create(...args);
        schedule!.phases[0]!.items[0]!.tax_rates = ["txr_fixture"] as unknown as Stripe.TaxRate[];
        return structuredClone(schedule!);
      },
    );
    expect(await run("quantity", 2)).toMatchObject({ status: "pending" });
    expect(scheduleUpdate).not.toHaveBeenCalled();
    expect((await plan()).seats).toBe(3);
  });
  it("rejects changed phase dates before configuring a reduction", async () => {
    const create = stripe.subscriptionSchedules.create;
    stripe.subscriptionSchedules.create = vi.fn(
      async (...args: Parameters<BillingStripe["subscriptionSchedules"]["create"]>) => {
        await create(...args);
        schedule!.phases[0]!.end_date = PERIOD_END - 1;
        return structuredClone(schedule!);
      },
    );
    expect(await run("quantity", 2)).toMatchObject({ status: "pending" });
    expect(scheduleUpdate).not.toHaveBeenCalled();
  });
  it("closes a known void increase invoice after renewal replaces latest_invoice", async () => {
    paid = false;
    await run("quantity", 5);
    const expired = invoice("void");
    sub.pending_update = null;
    sub.latest_invoice = {
      ...invoice("paid", "in_renewal_fixture"),
      billing_reason: "subscription_cycle",
    };
    sub.items.data[0]!.current_period_start = PERIOD_END;
    sub.items.data[0]!.current_period_end = PERIOD_END + 2592000;
    stripe.invoices = {
      retrieve: vi.fn(async (id) => {
        expect(id).toBe(expired.id);
        return expired;
      }),
    };
    expect(await run("reconcile")).toMatchObject({ status: "expired", paymentUrl: null });
    expect(update).toHaveBeenCalledTimes(1);
    expect(
      (
        await db
          .select()
          .from(schema.mailboxManagementRequests)
          .where(eq(schema.mailboxManagementRequests.teamId, teamId))
      )[0]!.stripeInvoiceId,
    ).toBe(expired.id);
  });
  it("preserves meaningful phase metadata and declines automatic tax before creating a schedule", async () => {
    sub.automatic_tax = { enabled: true } as Stripe.Subscription.AutomaticTax;
    await expect(run("quantity", 2)).rejects.toMatchObject({ code: "unavailable" });
    expect(createSchedule).not.toHaveBeenCalled();
    sub.automatic_tax = { enabled: false } as Stripe.Subscription.AutomaticTax;
    const create = stripe.subscriptionSchedules.create;
    stripe.subscriptionSchedules.create = vi.fn(
      async (...args: Parameters<BillingStripe["subscriptionSchedules"]["create"]>) => {
        await create(...args);
        schedule!.phases[0]!.metadata = { existing: "preserved" };
        return structuredClone(schedule!);
      },
    );
    expect(await run("quantity", 2)).toMatchObject({ status: "scheduled" });
    expect(
      scheduleUpdate.mock.calls[0]![1].phases!.every((p) => p.metadata?.existing === "preserved"),
    ).toBe(true);
  });
  it.each(["customer", "livemode", "service", "price"])(
    "rejects a wrong %s before mutation",
    async (field) => {
      if (field === "customer") sub.customer = "cus_other";
      if (field === "livemode") sub.livemode = true;
      if (field === "service") sub.metadata = { mepmail_service: "send" };
      if (field === "price") sub.items.data[0]!.price.id = "price_other";
      await expect(run("cancel")).rejects.toMatchObject({ code: "unavailable" });
      expect(update).not.toHaveBeenCalled();
    },
  );
  it("rechecks role/suspension/internal-license ownership before provider mutation", async () => {
    await db
      .update(schema.teamMembers)
      .set({ role: "member" })
      .where(eq(schema.teamMembers.teamId, teamId));
    await expect(run("cancel")).rejects.toMatchObject({ code: "forbidden" });
    await db
      .update(schema.teamMembers)
      .set({ role: "owner" })
      .where(eq(schema.teamMembers.teamId, teamId));
    await db.update(schema.teams).set({ suspendedAt: now() }).where(eq(schema.teams.id, teamId));
    await expect(run("cancel")).rejects.toMatchObject({ code: "forbidden" });
    await db.update(schema.teams).set({ suspendedAt: null }).where(eq(schema.teams.id, teamId));
    await db
      .update(schema.mailboxSubscriptions)
      .set({ stripeSubscriptionId: null })
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    await expect(run("cancel")).rejects.toMatchObject({ code: "unavailable" });
    expect(update).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, 10001])("rejects invalid seats %s before readback", async (seats) => {
    const reads = stripe.subscriptions.retrieve as ReturnType<typeof vi.fn>;
    reads.mockClear();
    await expect(run("quantity", seats)).rejects.toMatchObject({ code: "invalid" });
    expect(reads).not.toHaveBeenCalled();
  });
});
