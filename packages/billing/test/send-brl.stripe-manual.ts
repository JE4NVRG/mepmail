/**
 * Manual end to end against Stripe TEST mode through the paired CLI (sandbox only):
 * Send bought in reais must grant exactly what the same purchase in dollars grants.
 *
 *   SKIP_ENV_VALIDATION=1 npx tsx test/send-brl.stripe-manual.ts
 *
 * Uses the sandbox's launch 110K price and Pro overage price, which carry a BRL currency
 * option. Two customers, the same items: one subscription in usd, one in brl, each paid
 * with the test card; both applied to an in-memory database and compared. Cleaned up after.
 */
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { SUBSCRIPTION_EXPAND } from "../src/prices.js";
import { applySubscription } from "../src/subscription.js";
import { stripeCliHttpClient } from "./stripe-cli-transport.js";

const stripe = new Stripe("sk_test_via_cli", {
  httpClient: stripeCliHttpClient(),
  maxNetworkRetries: 0,
});
const run = `send-brl-${Date.now()}`;
const say = (...parts: unknown[]) => console.log(`[send-brl] ${parts.join(" ")}`);
const check = (ok: unknown, what: string) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  say(`ok: ${what}`);
};

async function priceId(lookupKey: string) {
  const page = await stripe.prices.list({ lookup_keys: [lookupKey], active: true });
  const price = page.data[0];
  if (!price) throw new Error(`no ${lookupKey}`);
  return price.id;
}

async function main() {
  const { db, close } = await createTestDb();
  const base = await priceId("mepmail_send_110k_launch_20261006_month");
  const overage = await priceId("millionsend_pro_100k_overage");
  const customers: string[] = [];
  const subscriptions: string[] = [];
  const buy = async (currency: "usd" | "brl") => {
    const teamId = await createTeam(db as Db, `${run}-${currency}`);
    const customer = await stripe.customers.create({
      metadata: { claude_probe: run, team_id: teamId },
    });
    customers.push(customer.id);
    await db
      .update(schema.teams)
      .set({ stripeCustomerId: customer.id })
      .where(eq(schema.teams.id, teamId));
    const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      currency,
      items: [{ price: base, quantity: 1 }, { price: overage }],
      default_payment_method: pm.id,
      metadata: { claude_probe: run, team_id: teamId },
      expand: ["latest_invoice"],
    });
    subscriptions.push(sub.id);
    const invoice = sub.latest_invoice as Stripe.Invoice;
    say(currency, "invoice", invoice.status, invoice.currency, invoice.amount_paid);
    const full = await stripe.subscriptions.retrieve(sub.id, { expand: SUBSCRIPTION_EXPAND });
    const logs: string[] = [];
    await db.transaction((tx) =>
      applySubscription(tx as unknown as Db, full, (m) => logs.push(m), stripe),
    );
    const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
    return { team: team!, invoice, sub: full, logs };
  };
  try {
    const usd = await buy("usd");
    const brl = await buy("brl");
    check(
      usd.invoice.status === "paid" && usd.invoice.amount_paid === 2900,
      "usd invoice paid US$29",
    );
    check(
      brl.invoice.status === "paid" &&
        brl.invoice.currency === "brl" &&
        brl.invoice.amount_paid === 14900,
      "brl invoice paid R$149",
    );
    check(
      brl.sub.currency === "brl" && brl.sub.status === "active",
      "brl subscription active in reais",
    );
    const pick = (t: typeof usd.team) => ({
      plan: t.plan,
      planQuota: t.planQuota,
      planStatus: t.planStatus,
      contract: !!t.sendBillingContract,
      terms: !!t.billingTerms,
      overageItem: !!t.stripeOverageItemId,
    });
    say("usd", JSON.stringify(pick(usd.team)), usd.logs.join(" | "));
    say("brl", JSON.stringify(pick(brl.team)), brl.logs.join(" | "));
    check(brl.team.plan === "pro" && brl.team.planQuota === 110_000, "brl grants Pro 110K");
    check(
      JSON.stringify(pick(brl.team)) === JSON.stringify(pick(usd.team)),
      "brl grants exactly what usd grants",
    );
    say("ALL CHECKS PASSED");
  } finally {
    for (const id of subscriptions) await stripe.subscriptions.cancel(id).catch(() => null);
    for (const id of customers) await stripe.customers.del(id).catch(() => null);
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
