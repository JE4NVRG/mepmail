/**
 * Manual Send-by-Pix end to end against Stripe TEST mode through the paired CLI (sandbox only).
 * Not a test file: it waits while a person pays the Pix Checkout it prints, in test mode.
 *
 *   SKIP_ENV_VALIDATION=1 npx tsx test/send-pix.stripe-manual.ts <url-file>
 *
 * Uses the sandbox's launch 110K price, Pro overage price and intro coupon (all with their
 * BRL currency options). Its own test clock and customer, deleted at the end.
 */
import { writeFileSync } from "node:fs";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { saveAdvertisingConsent } from "../src/meta-advertising.js";
import type { MetaConversionConfig } from "../src/meta-conversions.js";
import {
  beginPixInvoicePayment,
  isPixSubscription,
  openPixInvoices,
  readPixPayment,
  settlePixInvoice,
} from "../src/pix.js";
import { SUBSCRIPTION_EXPAND } from "../src/prices.js";
import { beginSendPixCheckout, fulfillSendPixStart } from "../src/send-checkout.js";
import { SEND_INTRO_COUPON } from "../src/send-launch-offer.js";
import { applySubscription } from "../src/subscription.js";
import { stripeCliHttpClient } from "./stripe-cli-transport.js";

const urlFile = process.argv[2] ?? "send-pix-url.txt";
const stripe = new Stripe("sk_test_via_cli", {
  httpClient: stripeCliHttpClient(),
  maxNetworkRetries: 0,
});
const run = `send-pix-${Date.now()}`;
const say = (...parts: unknown[]) => console.log(`[send-pix-e2e] ${parts.join(" ")}`);
const check = (ok: unknown, what: string) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  say(`ok: ${what}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitPaid(url: string) {
  writeFileSync(urlFile, url);
  say("pay this Pix in the test Checkout:", url);
  const id = /\/pay\/(cs_test_[A-Za-z0-9]+)/.exec(url)?.[1];
  if (!id) throw new Error("no session id in the URL");
  for (let i = 0; i < 180; i++) {
    const s = await stripe.checkout.sessions.retrieve(id);
    if (s.status === "complete" && s.payment_status === "paid") return id;
    await wait(5000);
  }
  throw new Error("the Pix was not paid within 15 minutes");
}

async function main() {
  const { db, close } = await createTestDb();
  // The sandbox coupon needs its BRL amount like the live one (stripe-send-brl.mjs).
  const coupon = await stripe.coupons.retrieve(SEND_INTRO_COUPON, {
    expand: ["currency_options"],
  });
  if (!coupon.currency_options?.brl) {
    await stripe.coupons.update(SEND_INTRO_COUPON, {
      currency_options: { brl: { amount_off: 5000 } },
    });
    say("sandbox coupon given its BRL amount (R$ 50)");
  }
  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: Math.floor(Date.now() / 1000),
    name: run,
  });
  // Stripe's Pix test mode pays a Pix at once for this e-mail prefix.
  const customer = await stripe.customers.create({
    email: "succeed_immediately@example.com",
    test_clock: clock.id,
    metadata: { claude_probe: run },
  });
  const teamId = await createTeam(db as Db, run);
  await db.insert(schema.domains).values({
    teamId,
    name: "stripe-send-pix.example.test",
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
  });
  const userId = `${run}-owner`;
  await db.insert(schema.user).values({ id: userId, name: userId, email: `${userId}@example.com` });
  await db.insert(schema.teamMembers).values({ teamId, userId, role: "owner" });
  await db
    .update(schema.teams)
    .set({ stripeCustomerId: customer.id })
    .where(eq(schema.teams.id, teamId));
  // Advertising measured, never sent: the Purchase row is checked in the local database only.
  const meta: MetaConversionConfig = {
    enabled: true,
    datasetId: "123456789",
    accessToken: "offline-never-sent",
    graphVersion: "v23.0",
    mode: "production",
  };
  const consent = await saveAdvertisingConsent(db as Db, {
    granted: true,
    proof: null,
    userId,
    sourceUrl: "https://mepmail.dev/pricing?lang=pt-BR",
  });
  const deps = {
    db: db as Db,
    stripe,
    livemode: false,
    launchOfferEnabled: true,
    advertising: {
      config: meta,
      proof: consent.proof,
      cookieHeader: "_fbp=fb.1.1790996395000.123456789",
    },
    advertisingConfig: meta,
  };
  const log = (m: string) => say(m);
  try {
    const { url } = await beginSendPixCheckout(deps, stripe, {
      team: { id: teamId, name: run, stripeCustomerId: customer.id },
      userId,
      rung: "pro_100k",
      interval: "month",
      email: `${userId}@example.com`,
      successUrl: "https://mepmail.dev/settings/billing?checkout=pix",
      cancelUrl: "https://mepmail.dev/settings/billing",
    });
    const sessionId = await waitPaid(url);
    // The test clock froze before the checkout captured its consent; bring it to the real
    // time, so the first invoice is paid after that capture, as it always is outside tests.
    await stripe.testHelpers.testClocks.advance(clock.id, {
      frozen_time: Math.floor(Date.now() / 1000),
    });
    for (let i = 0; i < 60; i++) {
      if ((await stripe.testHelpers.testClocks.retrieve(clock.id)).status === "ready") break;
      await wait(2000);
    }
    const payment = await readPixPayment(stripe, sessionId, false);
    if (typeof payment === "string") throw new Error(`payment ${payment}`);
    check(
      payment.kind === "send_start" && payment.amount === 9900 && payment.coupon,
      "paid R$ 99 first month (R$ 149 − R$ 50)",
    );
    const fulfill = () =>
      db.transaction((tx) => fulfillSendPixStart(tx as unknown as Db, deps, stripe, payment, log));
    check((await fulfill()) === "fulfilled", "fulfilled");
    check((await fulfill()) === "fulfilled", "a retried event changes nothing");
    const subs = await stripe.subscriptions.list({ customer: customer.id, status: "all" });
    check(subs.data.length === 1, "exactly one subscription");
    const sub = await stripe.subscriptions.retrieve(subs.data[0]!.id, {
      expand: [...SUBSCRIPTION_EXPAND, "latest_invoice"],
    });
    check(isPixSubscription(sub), "send_invoice subscription marked pix");
    check(sub.currency === "brl" && sub.status === "active", "active, in reais");
    check(sub.items.data.length === 2, "base + metered overage");
    const first = sub.latest_invoice as Stripe.Invoice;
    check(first.status === "paid" && first.amount_paid === 9900, "first invoice paid out of band");
    const logs: string[] = [];
    await db.transaction((tx) =>
      applySubscription(tx as unknown as Db, sub, (m) => logs.push(m), stripe),
    );
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    say("apply:", logs.join(" | ") || "(no notes)");
    check(team?.plan === "pro" && team.planQuota === 110_000, "Pro 110K granted");
    check(team?.planStatus === "active" && team.stripeOverageItemId, "active with overage item");
    // Each link the Purchase needs, from the real objects (no personal data printed).
    const [ctx] = await db.select().from(schema.metaCheckoutContexts);
    const pi = await stripe.paymentIntents.retrieve(payment.paymentIntentId);
    const inv = await stripe.invoices.retrieve(first.id);
    say(
      "links:",
      JSON.stringify({
        context_eligible: ctx?.eligible,
        captured_before_paid:
          !!ctx &&
          Math.floor(ctx.capturedAt.getTime() / 1000) <= (inv.status_transitions.paid_at ?? 0),
        pi_status: pi.status,
        pi_amount: pi.amount,
        pi_received: pi.amount_received,
        pi_currency: pi.currency,
        pi_customer_matches:
          (typeof pi.customer === "string" ? pi.customer : pi.customer?.id) === customer.id,
        inv_status: inv.status,
        inv_amount_paid: inv.amount_paid,
        inv_reason: inv.billing_reason,
        inv_collection: inv.collection_method,
        inv_session_matches: inv.metadata?.mepmail_pix_session === sessionId,
        inv_pi_matches: inv.metadata?.mepmail_pix_payment === payment.paymentIntentId,
        inv_lines: inv.lines.data.map((l) => ({
          price:
            typeof l.pricing?.price_details?.price === "string"
              ? "id"
              : typeof l.pricing?.price_details?.price,
          proration: l.parent?.subscription_item_details?.proration,
        })),
        inv_lines_more: inv.lines.has_more,
        sub_attempt: !!sub.metadata?.mepmail_send_checkout,
        sub_trial: [sub.trial_start, sub.trial_end],
      }),
    );
    const purchases = await db.select().from(schema.metaConversionOutbox);
    say(
      "purchase row:",
      JSON.stringify(
        purchases.map((r) => ({
          event: r.eventName,
          status: r.status,
          amount: r.amountPaidMinor,
          currency: r.currency,
          session: r.stripeSessionId === sessionId,
          invoice: r.stripeInvoiceId === first.id,
          subscription: r.stripeSubscriptionId === sub.id,
        })),
      ),
    );
    check(
      purchases.length === 1 &&
        purchases[0]!.eventName === "Purchase" &&
        purchases[0]!.status === "pending" &&
        purchases[0]!.amountPaidMinor === 9900 &&
        purchases[0]!.currency === "brl" &&
        purchases[0]!.stripeSessionId === sessionId &&
        purchases[0]!.stripeInvoiceId === first.id,
      "one Purchase of R$ 99 BRL recorded from real Stripe objects (never sent)",
    );

    // A month later the renewal invoice is open at the full R$ 149, due in 5 days.
    const periodEnd = sub.items.data[0]!.current_period_end;
    await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: periodEnd + 7200 });
    for (let i = 0; i < 60; i++) {
      if ((await stripe.testHelpers.testClocks.retrieve(clock.id)).status === "ready") break;
      await wait(4000);
    }
    let open: Awaited<ReturnType<typeof openPixInvoices>> = [];
    for (let i = 0; i < 30 && !open.length; i++) {
      open = await openPixInvoices(stripe, customer.id);
      if (!open.length) await wait(4000);
    }
    check(open.length === 1 && open[0]!.amount === 14900, "renewal invoice open, R$ 149");
    const renewalUrl = await beginPixInvoicePayment(stripe, {
      teamId,
      customerId: customer.id,
      invoiceId: open[0]!.id,
      successUrl: "https://mepmail.dev/settings/billing?pix=paid",
      cancelUrl: "https://mepmail.dev/settings/billing",
    });
    const renewalSession = await waitPaid(renewalUrl);
    const renewal = await readPixPayment(stripe, renewalSession, false);
    if (typeof renewal === "string") throw new Error(`renewal ${renewal}`);
    check((await settlePixInvoice(stripe, open[0]!.id, renewal)) === "paid", "renewal paid by Pix");
    const after = await stripe.subscriptions.retrieve(sub.id, { expand: SUBSCRIPTION_EXPAND });
    check(after.status === "active", "still active after the renewal");
    await db.transaction((tx) => applySubscription(tx as unknown as Db, after, () => {}, stripe));
    const [renewed] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    check(renewed?.plan === "pro", "Pro kept after the renewal");
    check((await openPixInvoices(stripe, customer.id)).length === 0, "nothing left to pay");
    check(
      (await db.select().from(schema.metaConversionOutbox)).length === 1,
      "the renewal adds no Purchase",
    );
    say("ALL CHECKS PASSED");
  } finally {
    await stripe.testHelpers.testClocks.del(clock.id).catch(() => null);
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
