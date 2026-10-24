import { emitFunnelEvent, type FunnelEventTarget } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, inArray, lt } from "drizzle-orm";
import type Stripe from "stripe";
import { mailboxManagementRequests } from "../../db/src/schema/mailbox-management-requests.js";
import type { BillingDeps } from "./checkout.js";
import { type GoogleConversionConfig, recordGooglePurchase } from "./google-advertising.js";
import { isMailboxSubscription, type MailboxCatalog } from "./mailbox.js";
import { applyMailboxSubscription, fulfillMailboxPixStart } from "./mailbox-lifecycle.js";
import { claimMailboxTrial } from "./mailbox-trial.js";
import { recordMetaPurchase } from "./meta-advertising.js";
import type { MetaConversionConfig } from "./meta-conversions.js";
import { screenPaymentRisk } from "./payment-risk.js";
import {
  type PixStripe,
  pixSessionOf,
  readPixPayment,
  refundPixPayment,
  settlePixInvoice,
} from "./pix.js";
import { SUBSCRIPTION_EXPAND } from "./prices.js";
import { fulfillSendPixStart } from "./send-checkout.js";
import { type CanonicalInvoicePayment, initialSendInvoiceFacts } from "./send-purchase.js";
import { applySubscription, idOf, lockCustomer } from "./subscription.js";

export interface WebhookDeps extends BillingDeps {
  webhookSecret: string;
  /** Collector supplied by the web boundary; absent still records the local truth ledger. */
  funnel?: FunnelEventTarget | undefined;
  /** Mode of the configured API key; events from the other mode are rejected. */
  livemode: boolean;
  advertisingConfig?: MetaConversionConfig;
  googleConversionConfig?: GoogleConversionConfig;
  /** Presence opts into the independent Mail ledger. Null closes paid Mail access. */
  mailboxCatalog?: MailboxCatalog | null;
  /** Settles Pix payments (pix.ts); absent, a paid Pix is only logged. */
  pixStripe?: PixStripe;
  /**
   * Runs after the transaction commits, once per event that was newly
   * recorded and acted on — the same dedupe the ledger applies, so a
   * redelivery stays silent here too. The route uses it to emit the funnel's
   * payment event without billing knowing anything about analytics.
   * Best-effort: a failure here is logged and the event stays applied.
   */
  afterApply?: ((event: AppliedWebhookEvent) => void | Promise<void>) | undefined;
}

/** What a newly applied event tells its caller: enough to key and classify it. */
export interface AppliedWebhookEvent {
  id: string;
  type: string;
  customerId: string | null;
  subscriptionId: string;
  service: "send" | "mailbox" | "ignored";
  /** Verified acquisition only; legacy payment_succeeded remains a separate renewal metric. */
  acquisition?: { teamId: string; amountPaidMinor: number; currency: string } | undefined;
}

/** Stripe redelivers for at most 3 days; older dedupe rows are dead weight. */
const EVENT_RETENTION_MS = 90 * 86_400_000;

/** Which subscription an event is about, plus the customer from the payload (lock key only). */
function subscriptionRef(
  event: Stripe.Event,
): { subscriptionId: string | null; customerId: string | null } | null {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      return { subscriptionId: idOf(session.subscription), customerId: idOf(session.customer) };
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object;
      return { subscriptionId: sub.id, customerId: idOf(sub.customer) };
    }
    case "invoice.paid":
    case "invoice.payment_succeeded":
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      return {
        subscriptionId: idOf(invoice.parent?.subscription_details?.subscription),
        customerId: idOf(invoice.customer),
      };
    }
    default:
      return null;
  }
}

/**
 * Verifies, dedupes, and applies a Stripe webhook. The plan is derived from
 * the subscription RE-FETCHED from Stripe, never from the event payload, so
 * out-of-order deliveries converge on Stripe's current state. Returns the
 * HTTP status to answer with; data we don't own (unknown customer, unknown
 * price) is logged and acknowledged so Stripe stops retrying it, while
 * infrastructure failures throw and roll back the ledger row so the retry
 * is processed again.
 */
export async function handleWebhook(
  rawBody: string,
  signature: string | null,
  deps: WebhookDeps,
): Promise<200 | 400> {
  let event: Stripe.Event;
  try {
    event = deps.stripe.webhooks.constructEvent(rawBody, signature ?? "", deps.webhookSecret);
  } catch {
    return 400;
  }
  if (event.livemode !== deps.livemode) return 400;
  const log = deps.log ?? console.warn;
  let paidCandidate:
    | { event: Stripe.Event; sub: Stripe.Subscription; mailbox: boolean }
    | undefined;
  const applied = await deps.db.transaction(async (tx): Promise<AppliedWebhookEvent | null> => {
    const inserted = await tx
      .insert(schema.stripeEvents)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing()
      .returning({ id: schema.stripeEvents.id });
    if (inserted.length === 0) return null;

    // A Pix payment is a one-time Checkout: it settles an invoice or starts a plan, and the
    // subscription events that follow are applied below like any other.
    const pixSession = pixSessionOf(event);
    if (pixSession) {
      await settlePixCheckout(tx as unknown as Db, deps, pixSession, (m) =>
        log(`stripe webhook ${event.id}: ${m}`),
      );
      return null;
    }

    const ref = subscriptionRef(event);
    if (!ref?.subscriptionId) return null;
    await lockCustomer(tx as unknown as Db, ref.customerId ?? ref.subscriptionId);
    let sub = await deps.stripe.subscriptions.retrieve(ref.subscriptionId, {
      expand: SUBSCRIPTION_EXPAND,
    });
    const mail = isMailboxSubscription(sub);
    if (mail)
      sub = await deps.stripe.subscriptions.retrieve(ref.subscriptionId, {
        expand: [...SUBSCRIPTION_EXPAND, "latest_invoice", "default_payment_method"],
      });
    let paymentInvoice: Stripe.Invoice | undefined;
    if (mail && "mailboxCatalog" in deps && deps.stripe.invoices) {
      const [attempt] = await tx
        .select({ invoiceId: mailboxManagementRequests.stripeInvoiceId })
        .from(mailboxManagementRequests)
        .where(
          and(
            eq(mailboxManagementRequests.stripeSubscriptionId, sub.id),
            eq(mailboxManagementRequests.stripeCustomerId, idOf(sub.customer) ?? ""),
            eq(mailboxManagementRequests.livemode, deps.livemode),
            eq(mailboxManagementRequests.action, "increase"),
            inArray(mailboxManagementRequests.status, ["creating", "pending"]),
          ),
        );
      if (attempt?.invoiceId && attempt.invoiceId !== idOf(sub.latest_invoice))
        paymentInvoice = await deps.stripe.invoices.retrieve(attempt.invoiceId);
    }
    const projected =
      "mailboxCatalog" in deps
        ? await applyMailboxSubscription(
            tx as unknown as Db,
            sub,
            deps.mailboxCatalog ?? null,
            event.created,
            paymentInvoice,
          )
        : null;
    // One free trial per card: a trial on a card that already had one ends now.
    if (mail && projected?.applied && projected.teamId && sub.status === "trialing") {
      const claim = await claimMailboxTrial(
        tx as unknown as Db,
        deps.stripe,
        sub,
        projected.teamId,
      );
      if (claim !== "claimed") log(`stripe webhook ${event.id}: Correio trial ended (${claim})`);
    }
    if (!mail)
      await applySubscription(
        tx as unknown as Db,
        sub,
        (m) => log(`stripe webhook ${event.id}: ${m}`),
        deps.stripe,
      );
    const customerId = idOf(sub.customer);
    // Send and Mail alike: the fraud screen holds the team's sending (Correio
    // outbound included) for review when Radar blocked one of its payments. Mail
    // is sold without Envio too, so its buyers are screened on their own.
    if (customerId) {
      await screenPaymentRisk(tx as unknown as Db, deps.stripe, customerId, (m) =>
        log(`stripe webhook ${event.id}: ${m}`),
      );
    }
    const [sendTeam] =
      customerId && !mail && !projected?.applied
        ? await tx
            .select({ subscriptionId: schema.teams.stripeSubscriptionId, plan: schema.teams.plan })
            .from(schema.teams)
            .where(eq(schema.teams.stripeCustomerId, customerId))
        : [];
    await recordMetaPurchase(
      tx as unknown as Db,
      event,
      sub,
      mail || !!projected?.applied,
      deps.advertisingConfig,
    );
    await recordGooglePurchase(
      tx as unknown as Db,
      event,
      sub,
      mail || !!projected?.applied,
      deps.googleConversionConfig,
    );
    paidCandidate = { event, sub, mailbox: mail || !!projected?.applied };
    return {
      id: event.id,
      type: event.type,
      customerId,
      subscriptionId: sub.id,
      service:
        mail || projected?.applied
          ? "mailbox"
          : sendTeam?.plan !== "system" && sendTeam?.subscriptionId === sub.id
            ? "send"
            : "ignored",
    };
  });
  // After the commit, and never before it: the caller's hook reports on an
  // event that is durable. A throwing hook is logged, not propagated — the
  // event is applied, and Stripe must not be told to redeliver it.
  if (applied && paidCandidate) {
    try {
      await recordSubscriptionPaid(
        deps,
        paidCandidate.event,
        paidCandidate.sub,
        paidCandidate.mailbox,
      );
    } catch (error) {
      log(`subscription_paid funnel skipped (${String(error)})`);
    }
  }
  if (applied && deps.afterApply) {
    try {
      await deps.afterApply(applied);
    } catch (error) {
      log(`stripe webhook ${applied.id}: afterApply failed (${String(error)})`);
    }
  }
  return 200;
}

/** Acts on a paid Pix Checkout, read back from Stripe; a retried event changes nothing. */
async function settlePixCheckout(
  db: Db,
  deps: WebhookDeps,
  sessionId: string,
  log: (message: string) => void,
): Promise<void> {
  if (!deps.pixStripe) return log(`pix ${sessionId}: Pix is not configured`);
  const payment = await readPixPayment(deps.pixStripe, sessionId, deps.livemode);
  if (payment === "pending") return log(`pix ${sessionId}: not paid yet`);
  if (payment === "invalid") return log(`pix ${sessionId}: not a MepMail Pix payment`);
  if (payment.kind === "send_start") {
    const outcome = await fulfillSendPixStart(db, deps, deps.pixStripe, payment, log);
    return log(`pix ${sessionId}: ${outcome}`);
  }
  if (payment.kind === "mailbox_start") {
    const outcome = await fulfillMailboxPixStart(
      db,
      deps.stripe,
      deps.pixStripe,
      deps.mailboxCatalog ?? null,
      payment,
      log,
    );
    return log(`pix ${sessionId}: ${outcome}`);
  }
  await lockCustomer(db, payment.customerId);
  const settled = payment.invoiceId
    ? await settlePixInvoice(deps.pixStripe, payment.invoiceId, payment)
    : "mismatch";
  if (settled === "paid") return log(`pix ${sessionId}: invoice ${payment.invoiceId} paid`);
  await refundPixPayment(deps.pixStripe, payment, "invoice");
  log(`pix ${sessionId}: refunded (invoice ${payment.invoiceId} not payable)`);
}

/** Drops dedupe rows past the retention window; returns how many. */
export async function purgeStripeEvents(db: Db, now = new Date()): Promise<number> {
  const rows = await db
    .delete(schema.stripeEvents)
    .where(lt(schema.stripeEvents.receivedAt, new Date(now.getTime() - EVENT_RETENTION_MS)))
    .returning({ id: schema.stripeEvents.id });
  return rows.length;
}

/** Authenticated webhook caller only. Never backfill or infer money from a plan change. */
async function recordSubscriptionPaid(
  deps: WebhookDeps,
  event: Stripe.Event,
  sub: Stripe.Subscription,
  mailbox: boolean,
): Promise<void> {
  const db = deps.db;
  if (
    event.livemode !== true ||
    sub.livemode !== true ||
    mailbox ||
    (event.type !== "invoice.payment_succeeded" && event.type !== "invoice.paid")
  )
    return;
  let canonicalPayment: CanonicalInvoicePayment | null = null;
  if (event.type === "invoice.paid") {
    // paid alone includes out-of-band settlements. Only a canonical expanded
    // PaymentIntent readback can prove money for this alias; an ID alone cannot.
    if (!deps.stripe.invoices) return;
    const invoice = await deps.stripe.invoices.retrieve(event.data.object.id, {
      expand: ["payments.data.payment.payment_intent"],
    });
    const payments = invoice.payments;
    if (invoice.id !== event.data.object.id || invoice.livemode !== true || payments?.has_more)
      return;
    const succeeded = payments?.data.filter(
      (p) => p.status === "paid" && p.payment.type === "payment_intent",
    );
    if (succeeded?.length !== 1) return;
    const payment = succeeded[0]!;
    const pi = payment.payment.payment_intent;
    if (
      !pi ||
      typeof pi === "string" ||
      pi.livemode !== true ||
      pi.status !== "succeeded" ||
      pi.currency !== invoice.currency ||
      pi.amount_received !== invoice.amount_paid ||
      idOf(pi.customer) !== idOf(invoice.customer)
    )
      return;
    canonicalPayment = {
      invoiceId: invoice.id,
      customerId: idOf(invoice.customer) ?? "",
      subscriptionId: idOf(invoice.parent?.subscription_details?.subscription) ?? "",
      livemode: true,
      status: "paid",
      paymentType: "payment_intent",
      paymentStatus: "succeeded",
      amountPaidMinor: pi.amount_received,
      currency: pi.currency,
    };
  }
  const attemptId = sub.metadata?.mepmail_send_checkout;
  if (
    !attemptId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId)
  )
    return;
  const [attempt] = await db
    .select()
    .from(schema.sendCheckoutAttempts)
    .where(eq(schema.sendCheckoutAttempts.id, attemptId));
  if (!attempt?.teamId || !attempt.livemode) return;
  const facts = initialSendInvoiceFacts({
    type: event.type,
    invoice: event.data.object,
    subscription: sub,
    attempt,
    mailbox,
    canonicalPayment,
    anyRung: true,
  });
  if (
    !facts ||
    facts.paidAt > new Date() ||
    facts.paidAt.getTime() < attempt.createdAt.getTime() - 1000
  )
    return;
  const [team] = await db
    .select({ id: schema.teams.id })
    .from(schema.teams)
    .where(
      and(
        eq(schema.teams.id, attempt.teamId),
        eq(schema.teams.stripeCustomerId, attempt.stripeCustomerId),
        eq(schema.teams.stripeSubscriptionId, sub.id),
      ),
    );
  if (!team) return;
  // No collector configuration dependency in billing: durable ledger is canonical.
  // Both verified aliases share one team claim; legacy renewal events are not summed with it.
  await emitFunnelEvent(
    db,
    deps.funnel ?? {
      endpoint: null,
      websiteId: null,
      hostname: new URL(process.env.APP_BASE_URL ?? "http://localhost").host,
    },
    {
      name: "subscription_paid",
      dedupeKey: `subscription_paid:${team.id}`,
      teamId: team.id,
      props: {
        product: "send",
        measurement_version: "2",
        amount_paid_minor: String(facts.amountPaidMinor),
        currency: facts.currency,
      },
    },
  );
}
