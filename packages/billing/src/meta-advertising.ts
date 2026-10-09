import { randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { and, eq, inArray, lte, or } from "drizzle-orm";
import type Stripe from "stripe";
import {
  ADVERTISING_POLICY_VERSION,
  advertisingCookie,
  type ConsentProof,
  newConsentProof,
  publicAdvertisingSource,
} from "./advertising-consent.js";
import {
  buildMetaConversionPayload,
  type MetaConversionConfig,
  type MetaConversionEvent,
  type MetaConversionTransport,
  metaConversionConfigured,
  sendMetaConversion,
} from "./meta-conversions.js";
import { confirmedInitialSendPurchase, initialSendInvoiceFacts } from "./send-purchase.js";
import type { BillingStripe } from "./stripe.js";

const receipts = schema.advertisingConsentReceipts;
const contexts = schema.metaCheckoutContexts;
const outbox = schema.metaConversionOutbox;
const googleOutbox = schema.googleConversionOutbox;
const googleContexts = schema.googleCheckoutContexts;
type Attempt = typeof schema.sendCheckoutAttempts.$inferSelect;
type Receipt = typeof receipts.$inferSelect;
type Context = typeof contexts.$inferSelect;
type Outbox = typeof outbox.$inferSelect;
const DELIVERY_MS = 24 * 60 * 60 * 1000;
const CONTEXT_MS = 7 * DELIVERY_MS;

export function proofMatches(
  row: Receipt | undefined,
  proof: ConsentProof | null,
  now: Date,
): row is Receipt {
  return (
    !!row &&
    !!proof &&
    row.proofNonce === proof.nonce &&
    row.policyVersion === ADVERTISING_POLICY_VERSION &&
    row.expiresAt.getTime() === proof.expires * 1000 &&
    row.expiresAt > now
  );
}
export function accepted(row: Receipt | undefined, now: Date): row is Receipt {
  return (
    !!row &&
    row.state === "accepted" &&
    row.revokedAt === null &&
    row.acceptedAt !== null &&
    row.policyVersion === ADVERTISING_POLICY_VERSION &&
    row.expiresAt > now
  );
}
function owned(row: Receipt, attempt: Attempt): boolean {
  return !!attempt.createdBy && row.userId === attempt.createdBy;
}
export async function receiptFor(db: Db, id: string, lock = false) {
  const query = db.select().from(receipts).where(eq(receipts.id, id));
  const [row] = lock ? await query.for("update") : await query;
  return row;
}
export async function readAdvertisingConsent(db: Db, proof: ConsentProof | null, now = new Date()) {
  const row = proof ? await receiptFor(db, proof.id) : undefined;
  return {
    state: proofMatches(row, proof, now) ? row.state : ("unknown" as const),
    policyVersion: ADVERTISING_POLICY_VERSION,
  };
}

/** Consent lock first everywhere: a completed withdrawal cannot race a later delivery. */
export async function saveAdvertisingConsent(
  db: Db,
  input: {
    granted: boolean;
    proof: ConsentProof | null;
    userId: string | null;
    sourceUrl: string | null;
  },
  now = new Date(),
) {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const previous = input.proof ? await receiptFor(tx, input.proof.id, true) : undefined;
    const valid = proofMatches(previous, input.proof, now);
    if (valid && !input.granted) {
      await tx
        .update(receipts)
        .set({ state: "denied", revokedAt: now, updatedAt: now })
        .where(eq(receipts.id, previous.id));
      await tx
        .update(outbox)
        .set({
          status: "cancelled",
          leaseToken: null,
          leaseUntil: null,
          lastFailure: "consent_withdrawn",
          confirmation: null,
        })
        .where(
          and(
            eq(outbox.consentReceiptId, previous.id),
            inArray(outbox.status, ["waiting", "pending", "leased"]),
          ),
        );
      await tx
        .update(contexts)
        .set({ eligible: false, fbp: null, fbc: null })
        .where(eq(contexts.consentReceiptId, previous.id));
      await tx
        .update(googleOutbox)
        .set({ status: "cancelled", leaseUntil: null, lastFailure: "consent_withdrawn" })
        .where(
          and(
            eq(googleOutbox.consentReceiptId, previous.id),
            inArray(googleOutbox.status, ["pending", "leased"]),
          ),
        );
      await tx.delete(googleContexts).where(eq(googleContexts.consentReceiptId, previous.id));
      return {
        proof: input.proof!,
        state: "denied" as const,
        policyVersion: ADVERTISING_POLICY_VERSION,
      };
    }
    if (
      valid &&
      input.granted &&
      accepted(previous, now) &&
      (!previous.userId || previous.userId === input.userId)
    ) {
      // Never revive a revoked receipt or its historical checkout contexts.
      return {
        proof: input.proof!,
        state: "accepted" as const,
        policyVersion: ADVERTISING_POLICY_VERSION,
      };
    }
    if (valid && previous.state === "accepted") {
      await tx
        .update(receipts)
        .set({ state: "denied", revokedAt: now, updatedAt: now })
        .where(eq(receipts.id, previous.id));
      await tx
        .update(outbox)
        .set({
          status: "cancelled",
          leaseToken: null,
          leaseUntil: null,
          confirmation: null,
          lastFailure: "consent_replaced",
        })
        .where(
          and(
            eq(outbox.consentReceiptId, previous.id),
            inArray(outbox.status, ["waiting", "pending", "leased"]),
          ),
        );
      await tx
        .update(contexts)
        .set({ eligible: false, fbp: null, fbc: null })
        .where(eq(contexts.consentReceiptId, previous.id));
      await tx
        .update(googleOutbox)
        .set({ status: "cancelled", leaseUntil: null, lastFailure: "consent_withdrawn" })
        .where(
          and(
            eq(googleOutbox.consentReceiptId, previous.id),
            inArray(googleOutbox.status, ["pending", "leased"]),
          ),
        );
      await tx.delete(googleContexts).where(eq(googleContexts.consentReceiptId, previous.id));
    }
    const proof = newConsentProof(now);
    await tx.insert(receipts).values({
      id: proof.id,
      proofNonce: proof.nonce,
      policyVersion: ADVERTISING_POLICY_VERSION,
      state: input.granted ? "accepted" : "denied",
      userId: input.userId,
      sourceUrl: publicAdvertisingSource(input.sourceUrl),
      acceptedAt: input.granted ? now : null,
      revokedAt: input.granted ? null : now,
      expiresAt: new Date(proof.expires * 1000),
    });
    return {
      proof,
      state: input.granted ? ("accepted" as const) : ("denied" as const),
      policyVersion: ADVERTISING_POLICY_VERSION,
    };
  });
}

export interface MetaCheckoutAdvertising {
  config: MetaConversionConfig;
  proof: ConsentProof | null;
  cookieHeader: string | null;
}

/** Called only on the first durable financial intent, before the Stripe POST. No late attribution/backfill. */
export async function prepareMetaCheckout(
  tx: Db,
  attempt: Attempt,
  advertising: MetaCheckoutAdvertising | undefined,
  now: Date,
) {
  if (!advertising || !metaConversionConfigured(advertising.config)) return;
  if (!["pro_100k", "pro_200k"].includes(attempt.rung)) return;
  const proof = advertising.proof;
  const receipt = proof ? await receiptFor(tx, proof.id, true) : undefined;
  const consented =
    proofMatches(receipt, proof, now) &&
    accepted(receipt, now) &&
    !!attempt.createdBy &&
    (!receipt.userId || owned(receipt, attempt));
  const fbp = consented ? advertisingCookie(advertising.cookieHeader, "_fbp") : null;
  const fbc = consented ? advertisingCookie(advertising.cookieHeader, "_fbc") : null;
  const eligible =
    consented &&
    !!receipt?.sourceUrl &&
    buildMetaConversionPayload({
      eventName: "InitiateCheckout",
      eventId: randomUUID(),
      eventTime: Math.floor(now.getTime() / 1000),
      eventSourceUrl: receipt.sourceUrl,
      consent: "granted",
      matching: { ...(fbp ? { fbp } : {}), ...(fbc ? { fbc } : {}) },
    }).status === "built";
  if (eligible && receipt && !receipt.userId)
    await tx
      .update(receipts)
      .set({ userId: attempt.createdBy, updatedAt: now })
      .where(eq(receipts.id, receipt.id));
  await tx
    .insert(contexts)
    .values({
      attemptId: attempt.id,
      eligible,
      consentReceiptId: eligible && receipt ? receipt.id : null,
      sourceUrl: eligible && receipt ? receipt.sourceUrl : null,
      fbp: eligible ? fbp : null,
      fbc: eligible ? fbc : null,
      capturedAt: now,
      expiresAt: new Date(now.getTime() + CONTEXT_MS),
    })
    .onConflictDoNothing();
}

async function checkoutContext(
  tx: Db,
  attempt: Attempt,
  now: Date,
): Promise<{ context: Context; receipt: Receipt } | null> {
  const [context] = await tx.select().from(contexts).where(eq(contexts.attemptId, attempt.id));
  if (!context?.eligible || !context.consentReceiptId || context.expiresAt <= now) return null;
  const receipt = await receiptFor(tx, context.consentReceiptId, true);
  return accepted(receipt, now) && owned(receipt, attempt) ? { context, receipt } : null;
}
export async function recordMetaCheckout(
  tx: Db,
  attempt: Attempt,
  session: Stripe.Checkout.Session,
  advertising: MetaCheckoutAdvertising | undefined,
  now: Date,
) {
  if (!advertising || !metaConversionConfigured(advertising.config)) return;
  const captured = await checkoutContext(tx, attempt, now);
  const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (
    !captured ||
    session.livemode !== attempt.livemode ||
    session.mode !== "subscription" ||
    session.status !== "open" ||
    attempt.stripeSessionId !== session.id ||
    customer !== attempt.stripeCustomerId ||
    session.client_reference_id !== attempt.parameters.client_reference_id ||
    session.metadata?.mepmail_send_checkout !== attempt.id ||
    !Number.isSafeInteger(session.created) ||
    session.created <= 0
  )
    return;
  const eventTime = new Date(session.created * 1000);
  if (eventTime > now || eventTime.getTime() + DELIVERY_MS <= now.getTime()) return;
  await tx
    .insert(outbox)
    .values({
      eventName: "InitiateCheckout",
      attemptId: attempt.id,
      consentReceiptId: captured.receipt.id,
      livemode: attempt.livemode,
      stripeSessionId: session.id,
      eventTime,
      expiresAt: new Date(eventTime.getTime() + DELIVERY_MS),
    })
    .onConflictDoNothing();
}

/** Selected authenticated facts, not the raw invoice, contact data, or provider response. */
function selectedConfirmation(
  type: string,
  invoice: Stripe.Invoice,
  subscription: Stripe.Subscription,
): Record<string, unknown> {
  return {
    type,
    invoice: {
      id: invoice.id,
      customer: typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id,
      parent: { subscription_details: { subscription: subscription.id } },
      livemode: invoice.livemode,
      status: invoice.status,
      billing_reason: invoice.billing_reason,
      currency: invoice.currency,
      amount_paid: invoice.amount_paid,
      status_transitions: { paid_at: invoice.status_transitions.paid_at },
      lines: {
        has_more: invoice.lines.has_more,
        data: invoice.lines.data.map((line) => ({
          pricing: {
            price_details: {
              price:
                typeof line.pricing?.price_details?.price === "string"
                  ? line.pricing.price_details.price
                  : line.pricing?.price_details?.price?.id,
            },
          },
          parent: {
            subscription_item_details: {
              proration: line.parent?.subscription_item_details?.proration,
            },
          },
        })),
      },
    },
    subscription: {
      id: subscription.id,
      customer:
        typeof subscription.customer === "string"
          ? subscription.customer
          : subscription.customer.id,
      livemode: subscription.livemode,
      metadata: { mepmail_send_checkout: subscription.metadata.mepmail_send_checkout },
      trial_start: subscription.trial_start,
      trial_end: subscription.trial_end,
      items: {
        has_more: subscription.items.has_more,
        data: subscription.items.data.map((item) => ({ price: { id: item.price.id } })),
      },
    },
  };
}

/** Same transaction as stripe_events and financial projection. Canonical Session resolution is deferred, never a financial POST. */
export async function recordMetaPurchase(
  tx: Db,
  event: Stripe.Event,
  subscription: Stripe.Subscription,
  mailbox: boolean,
  config: MetaConversionConfig | undefined,
  now = new Date(),
) {
  if (!config || !metaConversionConfigured(config) || event.type !== "invoice.payment_succeeded")
    return;
  const attemptId = subscription.metadata?.mepmail_send_checkout;
  if (
    !attemptId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId)
  )
    return;
  const [attempt] = await tx
    .select()
    .from(schema.sendCheckoutAttempts)
    .where(eq(schema.sendCheckoutAttempts.id, attemptId));
  if (!attempt) return;
  const invoice = event.data.object;
  const facts = initialSendInvoiceFacts({
    type: event.type,
    invoice,
    subscription,
    attempt,
    mailbox,
  });
  if (
    !facts ||
    event.livemode !== attempt.livemode ||
    facts.paidAt > now ||
    facts.paidAt.getTime() + DELIVERY_MS <= now.getTime()
  )
    return;
  const captured = await checkoutContext(tx, attempt, now);
  // Unix second precision: an invoice predating this intent/consent is never attributed later.
  if (
    !captured ||
    Math.floor(captured.context.capturedAt.getTime() / 1000) >
      Math.floor(facts.paidAt.getTime() / 1000)
  )
    return;
  await tx
    .insert(outbox)
    .values({
      eventName: "Purchase",
      attemptId: attempt.id,
      consentReceiptId: captured.receipt.id,
      livemode: attempt.livemode,
      stripeInvoiceId: facts.stripeInvoiceId,
      stripeSubscriptionId: facts.stripeSubscriptionId,
      amountPaidMinor: facts.amountPaidMinor,
      currency: facts.currency,
      eventTime: facts.paidAt,
      status: "waiting",
      confirmation: selectedConfirmation(event.type, invoice, subscription),
      expiresAt: new Date(facts.paidAt.getTime() + DELIVERY_MS),
    })
    .onConflictDoNothing();
}

async function canonicalSession(
  stripe: BillingStripe,
  attempt: Attempt,
): Promise<Stripe.Checkout.Session | null> {
  if (!stripe.checkout.sessions.retrieve) return null;
  if (attempt.stripeSessionId)
    return stripe.checkout.sessions.retrieve(attempt.stripeSessionId, { expand: ["line_items"] });
  if (!stripe.checkout.sessions.list) return null;
  let after: string | undefined;
  let found: string | null = null;
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = await stripe.checkout.sessions.list({
      customer: attempt.stripeCustomerId,
      limit: 100,
      ...(after ? { starting_after: after } : {}),
    });
    for (const session of page.data) {
      if (session.metadata?.mepmail_send_checkout !== attempt.id) continue;
      if (found || session.livemode !== attempt.livemode) return null;
      found = session.id;
    }
    if (!page.has_more)
      return found ? stripe.checkout.sessions.retrieve(found, { expand: ["line_items"] }) : null;
    const last = page.data.at(-1)?.id;
    if (!last || last === after) return null;
    after = last;
  }
  return null;
}

/** Durable retry key/time/value; only this worker sends HTTP, after the financial transaction. */
export async function dispatchMetaConversions(
  db: Db,
  config: MetaConversionConfig,
  deps: MetaConversionTransport & { stripe: BillingStripe; now?: () => Date },
) {
  if (!metaConversionConfigured(config)) return { considered: 0, sent: 0 };
  const clock = deps.now ?? (() => new Date());
  const due = await db
    .select()
    .from(outbox)
    .where(
      and(
        lte(outbox.nextAttemptAt, clock()),
        or(
          inArray(outbox.status, ["waiting", "pending"]),
          and(eq(outbox.status, "leased"), lte(outbox.leaseUntil, clock())),
        ),
      ),
    )
    .limit(20);
  let sent = 0;
  for (const candidate of due) {
    // Read-only Stripe resolution outside locks, only while consent/actor are still eligible.
    // A withdrawal/deletion racing this readback is checked again under the delivery lock below.
    let resolved: string | null = null;
    if (candidate.status === "waiting") {
      const [attempt] = await db
        .select()
        .from(schema.sendCheckoutAttempts)
        .where(eq(schema.sendCheckoutAttempts.id, candidate.attemptId));
      const receipt = await receiptFor(db, candidate.consentReceiptId);
      const [context] = await db
        .select()
        .from(contexts)
        .where(eq(contexts.attemptId, candidate.attemptId));
      const beforeReadback = clock();
      if (
        attempt &&
        candidate.confirmation &&
        accepted(receipt, beforeReadback) &&
        owned(receipt, attempt) &&
        context?.eligible &&
        context.consentReceiptId === candidate.consentReceiptId &&
        context.expiresAt > beforeReadback &&
        candidate.expiresAt > beforeReadback &&
        candidate.attempts < 5
      ) {
        try {
          const session = await canonicalSession(deps.stripe, attempt);
          const v = candidate.confirmation;
          if (session && v.type === "invoice.payment_succeeded" && v.invoice && v.subscription) {
            const facts = confirmedInitialSendPurchase({
              type: v.type,
              invoice: v.invoice as Stripe.Invoice,
              subscription: v.subscription as Stripe.Subscription,
              session,
              attempt,
              mailbox: false,
            });
            if (
              facts &&
              facts.stripeInvoiceId === candidate.stripeInvoiceId &&
              facts.stripeSubscriptionId === candidate.stripeSubscriptionId &&
              facts.amountPaidMinor === candidate.amountPaidMinor &&
              facts.currency === candidate.currency &&
              facts.paidAt.getTime() === candidate.eventTime.getTime()
            )
              resolved = facts.stripeSessionId;
          }
        } catch {
          /* Unknown readback remains pending, never manufactures success. */
        }
      }
    }
    await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      const receipt = await receiptFor(tx, candidate.consentReceiptId, true);
      const [row] = await tx
        .select()
        .from(outbox)
        .where(eq(outbox.id, candidate.id))
        .for("update", { skipLocked: true });
      const now = clock();
      if (
        !row ||
        !["waiting", "pending", "leased"].includes(row.status) ||
        row.nextAttemptAt > now ||
        (row.status === "leased" && row.leaseUntil && row.leaseUntil > now)
      )
        return;
      const [context] = await tx
        .select()
        .from(contexts)
        .where(eq(contexts.attemptId, row.attemptId));
      const [attempt] = await tx
        .select()
        .from(schema.sendCheckoutAttempts)
        .where(eq(schema.sendCheckoutAttempts.id, row.attemptId));
      const finish = async (
        status: Outbox["status"],
        lastFailure: string | null,
        extra: Partial<Outbox> = {},
      ) =>
        tx
          .update(outbox)
          .set({ status, lastFailure, leaseToken: null, leaseUntil: null, ...extra })
          .where(eq(outbox.id, row.id));
      if (
        !accepted(receipt, now) ||
        !attempt ||
        !owned(receipt, attempt) ||
        !context?.eligible ||
        context.expiresAt <= now
      ) {
        await finish("cancelled", "consent_withdrawn", { confirmation: null });
        return;
      }
      if (row.expiresAt <= now || row.attempts >= 5) {
        await finish("dead", "delivery_expired", { confirmation: null });
        return;
      }
      if (row.status === "waiting" && !resolved) {
        await finish("waiting", "session_unconfirmed", {
          attempts: row.attempts + 1,
          nextAttemptAt: new Date(now.getTime() + 60_000),
        });
        return;
      }
      const sessionId = resolved ?? row.stripeSessionId;
      if (!sessionId) {
        await finish("dead", "session_unconfirmed");
        return;
      }
      const event: MetaConversionEvent = {
        eventId: row.eventId,
        eventTime: Math.floor(row.eventTime.getTime() / 1000),
        eventSourceUrl: context.sourceUrl ?? "",
        consent: "granted",
        matching: {
          ...(context.fbp ? { fbp: context.fbp } : {}),
          ...(context.fbc ? { fbc: context.fbc } : {}),
        },
        ...(row.eventName === "Purchase"
          ? {
              eventName: "Purchase" as const,
              amountPaidMinor: row.amountPaidMinor ?? 0,
              currency: "USD",
            }
          : { eventName: "InitiateCheckout" as const }),
      };
      await tx
        .update(outbox)
        .set({
          status: "leased",
          leaseToken: randomUUID(),
          leaseUntil: new Date(now.getTime() + 120_000),
          stripeSessionId: sessionId,
        })
        .where(eq(outbox.id, row.id));
      // Bounded transport while holding ONLY advertising locks serializes withdrawal vs in-flight delivery.
      const outcome = await sendMetaConversion(event, config, deps);
      if (outcome.status === "accepted") {
        await finish("sent", null, { attempts: row.attempts + 1, confirmation: null });
        sent++;
      } else if (outcome.status === "retry")
        await finish("pending", outcome.reason, {
          attempts: row.attempts + 1,
          nextAttemptAt: new Date(now.getTime() + Math.min(3600_000, 60_000 * 2 ** row.attempts)),
        });
      else await finish("dead", outcome.reason, { confirmation: null });
    });
  }
  return { considered: due.length, sent };
}
