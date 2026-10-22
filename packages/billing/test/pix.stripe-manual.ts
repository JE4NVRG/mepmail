/**
 * Manual Pix end to end against Stripe TEST mode through the paired CLI (sandbox only).
 * Not a test file: it waits while a person pays the Pix Checkout it prints, in test mode.
 *
 *   npx tsx test/pix.stripe-manual.ts <url-file>
 *
 * Writes each Checkout URL to <url-file>, polls until it is paid, then checks what the
 * webhook would do. Its own product, price, test clock and customer; archived at the end.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import type { MailboxCatalog } from "../src/mailbox.js";
import {
  applyMailboxSubscription,
  beginMailboxPixCheckout,
  fulfillMailboxPixStart,
} from "../src/mailbox-lifecycle.js";
import {
  beginPixInvoicePayment,
  isPixSubscription,
  openPixInvoices,
  readPixPayment,
  settlePixInvoice,
} from "../src/pix.js";
import { stripeCliHttpClient } from "./stripe-cli-transport.js";

const urlFile = process.argv[2] ?? "pix-url.txt";
const stripe = new Stripe("sk_test_via_cli", {
  httpClient: stripeCliHttpClient(),
  maxNetworkRetries: 0,
});
const extension = fileURLToPath(new URL("../../db/mailbox-drizzle/", import.meta.url));
const GiB = 1024 ** 3;
const run = `pix-${Date.now()}`;
const say = (...parts: unknown[]) => console.log(`[pix-e2e] ${parts.join(" ")}`);
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
  for (const name of readdirSync(extension)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    for (const statement of readFileSync(extension + name, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean))
      await db.execute(sql.raw(statement));
  const product = await stripe.products.create({
    name: `MepMail Correio ${run}`,
    metadata: { mepmail_service: "mailbox" },
  });
  const price = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: 290,
    recurring: { interval: "month" },
    currency_options: { brl: { unit_amount: 1490 } },
    metadata: { mepmail_service: "mailbox", mepmail_offer: run, mepmail_plan: "solo" },
  });
  const catalog: MailboxCatalog = {
    livemode: false,
    checkoutPriceId: price.id,
    standalonePriceIds: [price.id],
    prices: [
      {
        priceId: price.id,
        currency: "usd",
        unitAmount: 290,
        interval: "month",
        planCode: "solo",
        quotaScope: "team",
        includedMailboxes: 1,
        storageBytesPerMailbox: GiB,
        includedOutboundPerMailbox: 500,
        inboundDeliveriesPerPeriod: 2000,
        inboundBytesPerPeriod: GiB / 2,
        outboundBytesPerPeriod: GiB / 4,
        localCurrency: { currency: "brl", unitAmount: 1490 },
      },
    ],
  };
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
    name: "stripe-pix.example.test",
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
  const urls = {
    successUrl: "https://mepmail.dev/mailboxes?checkout=pix",
    cancelUrl: "https://mepmail.dev/mailboxes",
  };
  const log = (m: string) => say(m);
  try {
    const { url } = await beginMailboxPixCheckout({ db, stripe }, stripe, catalog, {
      teamId,
      userId,
      ...urls,
    });
    const sessionId = await waitPaid(url);
    const payment = await readPixPayment(stripe, sessionId, false);
    if (typeof payment === "string") throw new Error(`payment ${payment}`);
    check(payment.amount === 1490 && payment.kind === "mailbox_start", "paid R$ 14,90 start");
    const outcome = await db.transaction((tx) =>
      fulfillMailboxPixStart(tx as unknown as Db, stripe, stripe, catalog, payment, log),
    );
    check(outcome === "fulfilled", "fulfilled");
    const again = await db.transaction((tx) =>
      fulfillMailboxPixStart(tx as unknown as Db, stripe, stripe, catalog, payment, log),
    );
    check(again === "fulfilled", "a retried event changes nothing");
    const subs = await stripe.subscriptions.list({ customer: customer.id, status: "all" });
    check(subs.data.length === 1, "exactly one subscription");
    const sub = await stripe.subscriptions.retrieve(subs.data[0]!.id, {
      expand: ["latest_invoice"],
    });
    check(isPixSubscription(sub), "send_invoice subscription marked pix");
    check(sub.currency === "brl" && sub.status === "active", "active, in reais");
    const first = sub.latest_invoice as Stripe.Invoice;
    check(first.status === "paid" && first.amount_paid === 1490, "first invoice paid out of band");
    check(
      (await applyMailboxSubscription(db, sub, catalog, Math.floor(Date.now() / 1000))).applied,
      "the subscription event grants the plan",
    );
    const [plan] = await db
      .select()
      .from(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, teamId));
    check(plan?.status === "active" && plan.planCode === "solo", "Solo active in the ledger");

    // A month later the renewal invoice is open, due in 5 days.
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
    check(open.length === 1 && open[0]!.amount === 1490, "renewal invoice open, R$ 14,90");
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
    check(
      (await settlePixInvoice(stripe, open[0]!.id, renewal)) === "paid",
      "a retried renewal event changes nothing",
    );
    const after = await stripe.subscriptions.retrieve(sub.id);
    check(after.status === "active", "still active after the renewal");
    check((await openPixInvoices(stripe, customer.id)).length === 0, "nothing left to pay");
    say("ALL CHECKS PASSED");
  } finally {
    await stripe.testHelpers.testClocks.del(clock.id).catch(() => null);
    await stripe.prices.update(price.id, { active: false }).catch(() => null);
    await stripe.products.update(product.id, { active: false }).catch(() => null);
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
