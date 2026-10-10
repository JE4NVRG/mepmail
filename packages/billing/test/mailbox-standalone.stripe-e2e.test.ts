/**
 * End to end against Stripe TEST mode, skipped unless STRIPE_E2E_KEY holds a
 * test-mode key (sk_test_/rk_test_). Uses an in-memory database, never a real
 * one. Creates its own test product and prices, and archives them at the end.
 *
 *   STRIPE_E2E_KEY=... npx vitest run test/mailbox-standalone.stripe-e2e.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MailboxCatalog, MailboxPriceTerms } from "../src/mailbox.js";
import { applyMailboxSubscription, beginMailboxCheckout } from "../src/mailbox-lifecycle.js";
import { repriceMailboxAddOnsWithoutSending } from "../src/mailbox-reprice.js";

const KEY = process.env.STRIPE_E2E_KEY ?? "";
const enabled = /^(sk|rk)_test_/.test(KEY);
const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
const DAY = 86_400_000;

describe.skipIf(!enabled)("standalone Correio against Stripe test mode", () => {
  // The describe body runs even when skipped: build the client only with a key.
  const stripe = enabled ? new Stripe(KEY) : (null as unknown as Stripe);
  let db: Db;
  let close: () => Promise<void>;
  let product: Stripe.Product;
  let solo: Stripe.Price;
  let addOn: Stripe.Price;
  let catalog: MailboxCatalog;
  const subscriptions: string[] = [];
  const run = `e2e-${Date.now()}`;
  const terms = (price: Stripe.Price, gib: number, outbound: number): MailboxPriceTerms => ({
    priceId: price.id,
    currency: price.currency,
    unitAmount: price.unit_amount ?? 0,
    interval: price.recurring?.interval === "year" ? "year" : "month",
    storageBytesPerMailbox: gib * 1024 ** 3,
    includedOutboundPerMailbox: outbound,
  });
  const owner = async (teamId: string, id: string) => {
    await db.insert(schema.user).values({ id, name: id, email: `${id}@example.com` });
    await db.insert(schema.teamMembers).values({ teamId, userId: id, role: "owner" });
  };
  const subscribe = async (customer: string, price: string, teamId: string) => {
    const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer });
    await stripe.customers.update(customer, {
      invoice_settings: { default_payment_method: pm.id },
    });
    const sub = await stripe.subscriptions.create({
      customer,
      items: [{ price, quantity: 1 }],
      metadata: { mepmail_service: "mailbox", team_id: teamId },
      expand: ["items.data.price.product", "latest_invoice"],
    });
    subscriptions.push(sub.id);
    return sub;
  };

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
    product = await stripe.products.create({
      name: `MepMail Correio ${run}`,
      metadata: { mepmail_service: "mailbox" },
    });
    const meta = { mepmail_service: "mailbox", mepmail_offer: run };
    solo = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: 1290,
      recurring: { interval: "month" },
      metadata: { ...meta, storage_bytes: String(10 * 1024 ** 3) },
    });
    addOn = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      unit_amount: 590,
      recurring: { interval: "month" },
      metadata: { ...meta, storage_bytes: String(1024 ** 3) },
    });
    catalog = {
      livemode: false,
      checkoutPriceId: solo.id,
      checkoutPriceIds: [addOn.id],
      standalonePriceIds: [solo.id],
      prices: [terms(addOn, 1, 500), terms(solo, 10, 2000)],
    };
  }, 60_000);

  afterAll(async () => {
    for (const id of subscriptions) await stripe.subscriptions.cancel(id).catch(() => {});
    for (const price of [solo, addOn])
      if (price) await stripe.prices.update(price.id, { active: false }).catch(() => {});
    if (product) await stripe.products.update(product.id, { active: false }).catch(() => {});
    await close?.();
  }, 60_000);

  it("opens a real Checkout on the standalone price for a team with no Customer, then activates its contract", async () => {
    const teamId = await createTeam(db, `${run}-solo`);
    await owner(teamId, `${run}-solo-owner`);
    const opened = {
      version: 1 as const,
      capturedAt: new Date(Date.now() - DAY).toISOString(),
      members: [],
    };
    const checkout = await beginMailboxCheckout(
      { db, stripe, requirePaidSendingPlan: true, earlyAccessCohort: opened },
      catalog,
      {
        teamId,
        userId: `${run}-solo-owner`,
        seats: 1,
        successUrl: "https://mepmail.dev/mailboxes?checkout=success",
        cancelUrl: "https://mepmail.dev/mailboxes",
      },
    );
    expect(checkout.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const [team] = await db
      .select({ customer: schema.teams.stripeCustomerId })
      .from(schema.teams)
      .where(eq(schema.teams.id, teamId));
    expect(team?.customer).toMatch(/^cus_/);
    const customer = await stripe.customers.retrieve(team!.customer!);
    expect((customer as Stripe.Customer).metadata.team_id).toBe(teamId);
    const sessions = await stripe.checkout.sessions.list({ customer: team!.customer!, limit: 1 });
    expect(sessions.data[0]).toMatchObject({
      mode: "subscription",
      status: "open",
      metadata: { mepmail_service: "mailbox", team_id: teamId },
    });

    // The paid Checkout creates this subscription; the API makes the same one.
    const sub = await subscribe(team!.customer!, solo.id, teamId);
    const applied = await applyMailboxSubscription(db, sub, catalog, Math.floor(Date.now() / 1000));
    expect(applied).toMatchObject({ applied: true, teamId });
    const [plan] = await db
      .select()
      .from(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    expect(plan).toMatchObject({
      status: "active",
      seats: 1,
      stripePriceId: solo.id,
      storageBytesPerMailbox: 10 * 1024 ** 3,
      includedOutboundPerMailbox: 2000,
    });
  }, 120_000);

  it("moves a real add-on subscription to the standalone price once Envio is gone", async () => {
    const teamId = await createTeam(db, `${run}-addon`);
    await owner(teamId, `${run}-addon-owner`);
    const customer = await stripe.customers.create({ metadata: { team_id: teamId } });
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: customer.id, currentPeriodEnd: new Date(Date.now() - 10 * DAY) })
      .where(eq(schema.teams.id, teamId));
    const sub = await subscribe(customer.id, addOn.id, teamId);
    expect(
      await applyMailboxSubscription(db, sub, catalog, Math.floor(Date.now() / 1000)),
    ).toMatchObject({ applied: true });
    const result = await repriceMailboxAddOnsWithoutSending({ db, stripe, catalog });
    expect(result.repriced).toBe(1);
    const after = await stripe.subscriptions.retrieve(sub.id);
    expect(after.items.data[0]?.price.id).toBe(solo.id);
    // No proration: the period already paid is not charged again.
    const upcoming = await stripe.invoiceItems.list({ customer: customer.id, pending: true });
    expect(upcoming.data).toEqual([]);
  }, 120_000);
});
