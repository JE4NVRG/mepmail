/**
 * End to end against Stripe TEST mode, skipped unless STRIPE_E2E_KEY holds a
 * test-mode key (sk_test_/rk_test_) or STRIPE_E2E_TRANSPORT=cli routes the
 * requests through the paired Stripe CLI (sandbox only). Uses an in-memory
 * database, never a real one. Creates its own test product and prices, and
 * archives them at the end.
 *
 *   STRIPE_E2E_KEY=... npx vitest run test/mailbox-standalone.stripe-e2e.test.ts
 *   STRIPE_E2E_TRANSPORT=cli npx vitest run test/mailbox-standalone.stripe-e2e.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type MailboxCatalog,
  type MailboxPriceTerms,
  mailboxIncreasePaymentConfirmed,
  projectMailboxSubscription,
} from "../src/mailbox.js";
import { applyMailboxSubscription, beginMailboxCheckout } from "../src/mailbox-lifecycle.js";
import { repriceMailboxAddOnsWithoutSending } from "../src/mailbox-reprice.js";
import { claimMailboxTrial } from "../src/mailbox-trial.js";
import { stripeCliHttpClient } from "./stripe-cli-transport.js";

const KEY = process.env.STRIPE_E2E_KEY ?? "";
const viaCli = process.env.STRIPE_E2E_TRANSPORT === "cli";
const enabled = viaCli || /^(sk|rk)_test_/.test(KEY);
const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
const DAY = 86_400_000;

describe.skipIf(!enabled)("standalone Correio against Stripe test mode", () => {
  // The describe body runs even when skipped: build the client only with a key.
  const stripe = !enabled
    ? (null as unknown as Stripe)
    : viaCli
      ? new Stripe("sk_test_via_cli", { httpClient: stripeCliHttpClient(), maxNetworkRetries: 0 })
      : new Stripe(KEY);
  let db: Db;
  let close: () => Promise<void>;
  let product: Stripe.Product;
  let solo: Stripe.Price;
  let addOn: Stripe.Price;
  let tiered: Stripe.Price;
  let catalog: MailboxCatalog;
  let tieredCatalog: MailboxCatalog;
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
    // US$12.90 with 3 mailboxes, US$3.90 each above them; R$64.90 and R$19.90 in BRL.
    tiered = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      recurring: { interval: "month" },
      billing_scheme: "tiered",
      tiers_mode: "graduated",
      tiers: [
        { up_to: 3, flat_amount: 1290, unit_amount: 0 },
        { up_to: "inf", unit_amount: 390 },
      ],
      currency_options: {
        brl: {
          tiers: [
            { up_to: 3, flat_amount: 6490, unit_amount: 0 },
            { up_to: "inf", unit_amount: 1990 },
          ],
        },
      },
      metadata: { ...meta, storage_bytes: String(10 * 1024 ** 3), included_mailboxes: "3" },
    });
    tieredCatalog = {
      livemode: false,
      checkoutPriceId: tiered.id,
      standalonePriceIds: [tiered.id],
      prices: [
        {
          priceId: tiered.id,
          currency: "usd",
          unitAmount: 1290,
          interval: "month",
          storageBytesPerMailbox: 10 * 1024 ** 3,
          includedOutboundPerMailbox: 2000,
          quotaScope: "team",
          includedMailboxes: 3,
          extraUnitAmount: 390,
          trialDays: 7,
          localCurrency: { currency: "brl", unitAmount: 6490, extraUnitAmount: 1990 },
        },
      ],
    };
  }, 60_000);

  afterAll(async () => {
    for (const id of subscriptions) await stripe.subscriptions.cancel(id).catch(() => {});
    for (const price of [solo, addOn, tiered])
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

  it("opens the tiered Correio Checkout with the 7-day trial and the card collected up front", async () => {
    const teamId = await createTeam(db, `${run}-trial`);
    await owner(teamId, `${run}-trial-owner`);
    const opened = {
      version: 1 as const,
      capturedAt: new Date(Date.now() - DAY).toISOString(),
      members: [],
    };
    const checkout = await beginMailboxCheckout(
      { db, stripe, requirePaidSendingPlan: true, earlyAccessCohort: opened },
      tieredCatalog,
      {
        teamId,
        userId: `${run}-trial-owner`,
        seats: 3,
        successUrl: "https://mepmail.dev/mailboxes?checkout=success",
        cancelUrl: "https://mepmail.dev/mailboxes",
      },
    );
    expect(checkout.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const [lease] = await db
      .select()
      .from(schema.mailboxCheckouts)
      .where(eq(schema.mailboxCheckouts.teamId, teamId));
    expect(lease).toMatchObject({
      trialDays: 7,
      seats: 3,
      quotaScope: "team",
      includedMailboxes: 3,
    });
    const session = await stripe.checkout.sessions.retrieve(lease!.stripeSessionId!);
    // Nothing is charged today: the first invoice comes when the trial ends.
    expect(session).toMatchObject({
      mode: "subscription",
      status: "open",
      payment_method_collection: "always",
      amount_total: 0,
    });
    console.log(`tiered trial checkout: ${checkout.url}`);
  }, 120_000);

  it("runs a BRL trial, ends a second trial on the same card, and bills an extra mailbox in BRL", async () => {
    const trialSub = async (teamId: string) => {
      const customer = await stripe.customers.create({ metadata: { team_id: teamId } });
      await db
        .update(schema.teams)
        .set({ stripeCustomerId: customer.id })
        .where(eq(schema.teams.id, teamId));
      const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
      const sub = await stripe.subscriptions.create({
        customer: customer.id,
        currency: "brl",
        items: [{ price: tiered.id, quantity: 3 }],
        default_payment_method: pm.id,
        trial_period_days: 7,
        trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
        metadata: { mepmail_service: "mailbox", team_id: teamId },
        expand: ["items.data.price.product", "latest_invoice", "default_payment_method"],
      });
      subscriptions.push(sub.id);
      return sub;
    };
    const first = await createTeam(db, `${run}-brl-1`);
    const sub = await trialSub(first);
    expect(sub).toMatchObject({ status: "trialing", currency: "brl" });
    expect(
      projectMailboxSubscription(sub, tieredCatalog, {
        teamId: first,
        customerId: sub.customer as string,
      }),
    ).toMatchObject({
      status: "trialing",
      seats: 3,
      quotaScope: "team",
      includedMailboxes: 3,
    });
    expect(
      await applyMailboxSubscription(db, sub, tieredCatalog, Math.floor(Date.now() / 1000)),
    ).toMatchObject({ applied: true });
    expect(await claimMailboxTrial(db, stripe, sub, first)).toBe("claimed");

    const second = await createTeam(db, `${run}-brl-2`);
    const again = await trialSub(second);
    expect(await claimMailboxTrial(db, stripe, again, second)).toBe("duplicate_card");
    const ended = await stripe.subscriptions.retrieve(again.id, { expand: ["latest_invoice"] });
    expect(ended.status).toBe("active");
    const charged = ended.latest_invoice as Stripe.Invoice;
    expect(charged).toMatchObject({ status: "paid", currency: "brl", amount_paid: 6490 });

    // A fourth mailbox on the BRL contract: one prorated debit, paid, in BRL.
    const item = ended.items.data[0]!;
    const before = Math.floor(Date.now() / 1000);
    const grown = await stripe.subscriptions.update(ended.id, {
      items: [{ id: item.id, quantity: 4 }],
      proration_behavior: "always_invoice",
      payment_behavior: "pending_if_incomplete",
      expand: ["latest_invoice", "items.data.price.product"],
    });
    const invoice = grown.latest_invoice as Stripe.Invoice;
    expect(invoice).toMatchObject({
      status: "paid",
      currency: "brl",
      billing_reason: "subscription_update",
    });
    expect(
      mailboxIncreasePaymentConfirmed(grown, {
        customerId: grown.customer as string,
        livemode: false,
        seats: 4,
        periodStart: new Date(item.current_period_start * 1000),
        periodEnd: new Date(item.current_period_end * 1000),
        previousInvoiceId: charged.id,
      }),
    ).toBe(true);
    expect(before).toBeGreaterThan(0);
  }, 180_000);
});
