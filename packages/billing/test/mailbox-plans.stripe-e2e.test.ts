/**
 * Correio plans (Solo, Duo, Equipe) end to end against Stripe TEST mode, skipped unless
 * STRIPE_E2E_KEY holds a test-mode key or STRIPE_E2E_TRANSPORT=cli routes the requests
 * through the paired Stripe CLI (sandbox only). In-memory database; its own test product
 * and prices, archived at the end.
 *
 *   STRIPE_E2E_TRANSPORT=cli npx vitest run test/mailbox-plans.stripe-e2e.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MailboxCatalog, type MailboxPriceTerms } from "../src/mailbox.js";
import { applyMailboxSubscription, beginMailboxCheckout } from "../src/mailbox-lifecycle.js";
import { changeMailboxPlan } from "../src/mailbox-management.js";
import { claimMailboxTrial } from "../src/mailbox-trial.js";
import { stripeCliHttpClient } from "./stripe-cli-transport.js";

const KEY = process.env.STRIPE_E2E_KEY ?? "";
const viaCli = process.env.STRIPE_E2E_TRANSPORT === "cli";
const enabled = viaCli || /^(sk|rk)_test_/.test(KEY);
const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
const DAY = 86_400_000;
const GiB = 1024 ** 3;
// atlas-pricing-plan-contract.json (Jean, 2026-10-10).
const PLANS = [
  {
    code: "solo",
    usd: 290,
    brl: 1490,
    boxes: 1,
    storage: GiB,
    out: 500,
    inn: 2000,
    outB: GiB / 4,
    inB: GiB / 2,
  },
  {
    code: "duo",
    usd: 590,
    brl: 2990,
    boxes: 3,
    storage: 3 * GiB,
    out: 2000,
    inn: 5000,
    outB: GiB,
    inB: 1.5 * GiB,
  },
  {
    code: "equipe",
    usd: 1290,
    brl: 6490,
    boxes: 10,
    storage: 10 * GiB,
    out: 6000,
    inn: 10000,
    outB: 3 * GiB,
    inB: 3 * GiB,
  },
] as const;
type Code = (typeof PLANS)[number]["code"];

describe.skipIf(!enabled)("Correio plans against Stripe test mode", () => {
  const stripe = !enabled
    ? (null as unknown as Stripe)
    : viaCli
      ? new Stripe("sk_test_via_cli", { httpClient: stripeCliHttpClient(), maxNetworkRetries: 0 })
      : new Stripe(KEY);
  let db: Db;
  let close: () => Promise<void>;
  let product: Stripe.Product;
  const prices = {} as Record<Code, Stripe.Price>;
  // The offer sold before the plans (US$12.90 for 3 mailboxes, US$3.90 each above).
  let legacy: Stripe.Price;
  let catalog: MailboxCatalog;
  const subscriptions: string[] = [];
  const run = `plans-${Date.now()}`;
  const opened = () => ({
    version: 1 as const,
    capturedAt: new Date(Date.now() - DAY).toISOString(),
    members: [],
  });
  const forPlan = (code: Code): MailboxCatalog => ({
    ...catalog,
    checkoutPriceId: prices[code].id,
  });
  // A customer user: the team owner, not a MepMail operator.
  const team = async (name: string) => {
    const teamId = await createTeam(db, `${run}-${name}`);
    const userId = `${run}-${name}-owner`;
    await db
      .insert(schema.user)
      .values({ id: userId, name: userId, email: `${userId}@example.com` });
    await db.insert(schema.teamMembers).values({ teamId, userId, role: "owner" });
    return { teamId, userId };
  };
  const row = async (teamId: string) =>
    (
      await db
        .select()
        .from(schema.mailboxSubscriptions)
        .where(eq(schema.mailboxSubscriptions.teamId, teamId))
    )[0];
  const subscribe = async (
    teamId: string,
    code: Code,
    options: { currency?: "usd" | "brl"; trial?: boolean } = {},
  ) => {
    const customer = await stripe.customers.create({ metadata: { team_id: teamId } });
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: customer.id })
      .where(eq(schema.teams.id, teamId));
    const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: pm.id },
    });
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      ...(options.currency ? { currency: options.currency } : {}),
      items: [{ price: prices[code].id, quantity: 1 }],
      default_payment_method: pm.id,
      ...(options.trial
        ? {
            trial_period_days: 7,
            trial_settings: { end_behavior: { missing_payment_method: "cancel" as const } },
          }
        : {}),
      metadata: { mepmail_service: "mailbox", team_id: teamId },
      expand: ["items.data.price.product", "latest_invoice", "default_payment_method"],
    });
    subscriptions.push(sub.id);
    return sub;
  };
  const expected = (code: Code) => {
    const p = PLANS.find((x) => x.code === code)!;
    return {
      planCode: code,
      quotaScope: "team",
      seats: p.boxes,
      includedMailboxes: p.boxes,
      storageBytesPerMailbox: p.storage,
      includedOutboundPerMailbox: p.out,
      inboundDeliveriesPerPeriod: p.inn,
      inboundBytesPerPeriod: p.inB,
      outboundBytesPerPeriod: p.outB,
    };
  };
  const now = () => Math.floor(Date.now() / 1000);

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
    const terms: MailboxPriceTerms[] = [];
    for (const p of PLANS) {
      prices[p.code] = await stripe.prices.create({
        product: product.id,
        currency: "usd",
        unit_amount: p.usd,
        recurring: { interval: "month" },
        currency_options: { brl: { unit_amount: p.brl } },
        metadata: { mepmail_service: "mailbox", mepmail_offer: run, mepmail_plan: p.code },
      });
      terms.push({
        priceId: prices[p.code].id,
        currency: "usd",
        unitAmount: p.usd,
        interval: "month",
        planCode: p.code,
        quotaScope: "team",
        includedMailboxes: p.boxes,
        storageBytesPerMailbox: p.storage,
        includedOutboundPerMailbox: p.out,
        inboundDeliveriesPerPeriod: p.inn,
        inboundBytesPerPeriod: p.inB,
        outboundBytesPerPeriod: p.outB,
        trialDays: 7,
        localCurrency: { currency: "brl", unitAmount: p.brl },
      });
    }
    legacy = await stripe.prices.create({
      product: product.id,
      currency: "usd",
      recurring: { interval: "month" },
      billing_scheme: "tiered",
      tiers_mode: "graduated",
      tiers: [
        { up_to: 3, flat_amount: 1290, unit_amount: 0 },
        { up_to: "inf", unit_amount: 390 },
      ],
      metadata: { mepmail_service: "mailbox", mepmail_offer: run },
    });
    // Historical terms stay approved for the contracts sold with them; not for sale.
    terms.push({
      priceId: legacy.id,
      currency: "usd",
      unitAmount: 1290,
      interval: "month",
      storageBytesPerMailbox: 10 * GiB,
      includedOutboundPerMailbox: 2000,
      quotaScope: "team",
      includedMailboxes: 3,
      extraUnitAmount: 390,
    });
    catalog = {
      livemode: false,
      checkoutPriceId: prices.duo.id,
      checkoutPriceIds: [],
      standalonePriceIds: PLANS.map((p) => prices[p.code].id),
      prices: terms,
    };
  }, 90_000);

  afterAll(async () => {
    for (const id of subscriptions) await stripe.subscriptions.cancel(id).catch(() => {});
    for (const price of [...Object.values(prices), legacy].filter(Boolean))
      await stripe.prices.update(price.id, { active: false }).catch(() => {});
    if (product) await stripe.products.update(product.id, { active: false }).catch(() => {});
    await close?.();
  }, 90_000);

  it("opens each plan's Checkout for exactly its mailboxes, with the 7-day card trial on a first purchase", async () => {
    for (const p of PLANS) {
      const { teamId, userId } = await team(`checkout-${p.code}`);
      const checkout = await beginMailboxCheckout(
        { db, stripe, requirePaidSendingPlan: true, earlyAccessCohort: opened() },
        forPlan(p.code),
        {
          teamId,
          userId,
          // Asking for more mailboxes than the plan has still buys the plan (Stripe quantity 1).
          seats: p.boxes + 5,
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
        stripePriceId: prices[p.code].id,
        planCode: p.code,
        seats: p.boxes,
        includedMailboxes: p.boxes,
        trialDays: 7,
        inboundDeliveriesPerPeriod: p.inn,
      });
      const session = await stripe.checkout.sessions.retrieve(lease!.stripeSessionId!, {
        expand: ["line_items"],
      });
      expect(session).toMatchObject({
        mode: "subscription",
        status: "open",
        payment_method_collection: "always",
        amount_total: 0,
      });
      expect(session.line_items?.data[0]).toMatchObject({ quantity: 1 });
      expect(session.line_items?.data[0]?.price?.id).toBe(prices[p.code].id);
    }
  }, 240_000);

  it("charges a direct purchase in full when the team already had its trial", async () => {
    const { teamId, userId } = await team("direct");
    // A trial claimed earlier (by its card) makes this a direct purchase.
    await db.insert(schema.mailboxTrialClaims).values({
      teamId,
      fingerprintHash: Buffer.from(run).toString("hex").padEnd(64, "0").slice(0, 64),
      stripeCustomerId: "cus_earlier_trial",
      stripeSubscriptionId: "sub_earlier_trial",
    });
    await beginMailboxCheckout(
      { db, stripe, requirePaidSendingPlan: true, earlyAccessCohort: opened() },
      forPlan("solo"),
      {
        teamId,
        userId,
        seats: 1,
        successUrl: "https://mepmail.dev/mailboxes?checkout=success",
        cancelUrl: "https://mepmail.dev/mailboxes",
      },
    );
    const [lease] = await db
      .select()
      .from(schema.mailboxCheckouts)
      .where(eq(schema.mailboxCheckouts.teamId, teamId));
    expect(lease).toMatchObject({ trialDays: 0, planCode: "solo" });
    const session = await stripe.checkout.sessions.retrieve(lease!.stripeSessionId!);
    expect(session.amount_total).toBe(290);
  }, 120_000);

  it("persists the paid plan's entitlements in USD and BRL, idempotently", async () => {
    for (const [code, currency, amount] of [
      ["solo", "usd", 290],
      ["equipe", "brl", 6490],
    ] as const) {
      const { teamId } = await team(`paid-${code}-${currency}`);
      const sub = await subscribe(teamId, code, { currency });
      const invoice = sub.latest_invoice as Stripe.Invoice;
      expect(invoice).toMatchObject({ status: "paid", currency, amount_paid: amount });
      const at = now();
      expect(await applyMailboxSubscription(db, sub, catalog, at)).toMatchObject({
        applied: true,
      });
      const first = await row(teamId);
      expect(first).toMatchObject({ status: "active", ...expected(code) });
      // The same event delivered again changes nothing.
      await applyMailboxSubscription(db, sub, catalog, at);
      expect(await row(teamId)).toMatchObject({ ...expected(code), status: "active" });
    }
  }, 180_000);

  it("runs a BRL Duo trial, upgrades it to Equipe by paying now, and ignores the older event after", async () => {
    const { teamId, userId } = await team("upgrade");
    const sub = await subscribe(teamId, "duo", { currency: "brl", trial: true });
    expect(sub).toMatchObject({ status: "trialing", currency: "brl" });
    const trialAt = now();
    expect(await applyMailboxSubscription(db, sub, catalog, trialAt)).toMatchObject({
      applied: true,
    });
    expect(await claimMailboxTrial(db, stripe, sub, teamId)).toBe("claimed");
    expect(await row(teamId)).toMatchObject({ status: "trialing", ...expected("duo") });
    // An upgrade during the trial ends it: the larger plan is paid in full, in BRL, now.
    const changed = await changeMailboxPlan({ db, stripe }, catalog, {
      teamId,
      userId,
      priceId: prices.equipe.id,
    });
    expect(changed).toEqual({ planCode: "equipe", direction: "upgrade" });
    const after = await stripe.subscriptions.retrieve(sub.id, {
      expand: ["latest_invoice", "items.data.price.product"],
    });
    expect(after.status).toBe("active");
    expect(after.latest_invoice as Stripe.Invoice).toMatchObject({
      status: "paid",
      currency: "brl",
      amount_paid: 6490,
    });
    expect(await row(teamId)).toMatchObject({ status: "active", ...expected("equipe") });
    // The trial's webhook arriving late never takes the plan back to Duo.
    expect(await applyMailboxSubscription(db, sub, catalog, trialAt - 5)).toMatchObject({
      applied: false,
      reason: "stale_event",
    });
    expect(await row(teamId)).toMatchObject(expected("equipe"));
    // The current state delivered again (a repeated webhook) is a no-op.
    await applyMailboxSubscription(db, after, catalog, now() + 1);
    await applyMailboxSubscription(db, after, catalog, now() + 1);
    expect(await row(teamId)).toMatchObject({ status: "active", ...expected("equipe") });
  }, 240_000);

  it("downgrades only when the team fits the smaller plan, at once and without refund", async () => {
    const { teamId, userId } = await team("downgrade");
    const sub = await subscribe(teamId, "duo");
    await applyMailboxSubscription(db, sub, catalog, now());
    const plan = (await row(teamId))!;
    // This period already received more than Solo allows.
    await db.insert(schema.mailboxUsagePeriods).values({
      teamId,
      periodStart: plan.periodStart,
      periodEnd: plan.periodEnd,
      inboundDeliveries: 2001,
      inboundBytes: 0,
    });
    await expect(
      changeMailboxPlan({ db, stripe }, catalog, { teamId, userId, priceId: prices.solo.id }),
    ).rejects.toMatchObject({ code: "plan_too_small" });
    expect((await stripe.subscriptions.retrieve(sub.id)).items.data[0]?.price.id).toBe(
      prices.duo.id,
    );
    await db
      .update(schema.mailboxUsagePeriods)
      .set({ inboundDeliveries: 10 })
      .where(eq(schema.mailboxUsagePeriods.teamId, teamId));
    expect(
      await changeMailboxPlan({ db, stripe }, catalog, { teamId, userId, priceId: prices.solo.id }),
    ).toEqual({ planCode: "solo", direction: "downgrade" });
    const after = await stripe.subscriptions.retrieve(sub.id);
    expect(after.items.data[0]?.price.id).toBe(prices.solo.id);
    // Same billing period; no credit note or pending proration back to the customer.
    expect(after.items.data[0]?.current_period_end).toBe(sub.items.data[0]?.current_period_end);
    const pending = await stripe.invoiceItems.list({
      customer: after.customer as string,
      pending: true,
    });
    expect(pending.data).toEqual([]);
    expect(await row(teamId)).toMatchObject({ ...expected("solo"), periodEnd: plan.periodEnd });
  }, 240_000);

  it("lets a contract sold before the plans move to Equipe voluntarily, its old terms kept until then", async () => {
    const { teamId, userId } = await team("legacy");
    const customer = await stripe.customers.create({ metadata: { team_id: teamId } });
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: customer.id })
      .where(eq(schema.teams.id, teamId));
    const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: legacy.id, quantity: 3 }],
      default_payment_method: pm.id,
      metadata: { mepmail_service: "mailbox", team_id: teamId },
      expand: ["items.data.price.product", "latest_invoice"],
    });
    subscriptions.push(sub.id);
    await applyMailboxSubscription(db, sub, catalog, now());
    expect(await row(teamId)).toMatchObject({
      planCode: null,
      seats: 3,
      stripePriceId: legacy.id,
      storageBytesPerMailbox: 10 * GiB,
      inboundDeliveriesPerPeriod: null,
    });
    // More mailboxes for the same base price: an upgrade, invoiced (here about zero) now.
    expect(
      await changeMailboxPlan({ db, stripe }, catalog, {
        teamId,
        userId,
        priceId: prices.equipe.id,
      }),
    ).toEqual({ planCode: "equipe", direction: "upgrade" });
    const after = await stripe.subscriptions.retrieve(sub.id, { expand: ["latest_invoice"] });
    expect(after.items.data[0]).toMatchObject({ quantity: 1 });
    const invoice = after.latest_invoice as Stripe.Invoice;
    expect(invoice).toMatchObject({ status: "paid", billing_reason: "subscription_update" });
    expect(Math.abs(invoice.total)).toBeLessThanOrEqual(5);
    expect(await row(teamId)).toMatchObject({ status: "active", ...expected("equipe") });
  }, 240_000);
});
