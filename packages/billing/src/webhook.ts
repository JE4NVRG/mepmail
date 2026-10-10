import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, inArray, lt } from "drizzle-orm";
import type Stripe from "stripe";
import { mailboxManagementRequests } from "../../db/src/schema/mailbox-management-requests.js";
import type { BillingDeps } from "./checkout.js";
import { type GoogleConversionConfig, recordGooglePurchase } from "./google-advertising.js";
import { isMailboxSubscription, type MailboxCatalog } from "./mailbox.js";
import { applyMailboxSubscription } from "./mailbox-lifecycle.js";
import { recordMetaPurchase } from "./meta-advertising.js";
import type { MetaConversionConfig } from "./meta-conversions.js";
import { screenPaymentRisk } from "./payment-risk.js";
import { SUBSCRIPTION_EXPAND } from "./prices.js";
import { applySubscription, idOf, lockCustomer } from "./subscription.js";

export interface WebhookDeps extends BillingDeps {
  webhookSecret: string;
  /** Mode of the configured API key; events from the other mode are rejected. */
  livemode: boolean;
  advertisingConfig?: MetaConversionConfig;
  googleConversionConfig?: GoogleConversionConfig;
  /** Presence opts into the independent Mail ledger. Null closes paid Mail access. */
  mailboxCatalog?: MailboxCatalog | null;
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
  const applied = await deps.db.transaction(async (tx): Promise<AppliedWebhookEvent | null> => {
    const inserted = await tx
      .insert(schema.stripeEvents)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing()
      .returning({ id: schema.stripeEvents.id });
    if (inserted.length === 0) return null;

    const ref = subscriptionRef(event);
    if (!ref?.subscriptionId) return null;
    await lockCustomer(tx as unknown as Db, ref.customerId ?? ref.subscriptionId);
    let sub = await deps.stripe.subscriptions.retrieve(ref.subscriptionId, {
      expand: SUBSCRIPTION_EXPAND,
    });
    const mail = isMailboxSubscription(sub);
    if (mail)
      sub = await deps.stripe.subscriptions.retrieve(ref.subscriptionId, {
        expand: [...SUBSCRIPTION_EXPAND, "latest_invoice"],
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
  if (applied && deps.afterApply) {
    try {
      await deps.afterApply(applied);
    } catch (error) {
      log(`stripe webhook ${applied.id}: afterApply failed (${String(error)})`);
    }
  }
  return 200;
}

/** Drops dedupe rows past the retention window; returns how many. */
export async function purgeStripeEvents(db: Db, now = new Date()): Promise<number> {
  const rows = await db
    .delete(schema.stripeEvents)
    .where(lt(schema.stripeEvents.receivedAt, new Date(now.getTime() - EVENT_RETENTION_MS)))
    .returning({ id: schema.stripeEvents.id });
  return rows.length;
}
