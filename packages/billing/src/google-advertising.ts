import { type Db, schema } from "@millionsend/db";
import { and, eq, inArray, lte, or } from "drizzle-orm";
import type Stripe from "stripe";
import { advertisingCookie, type ConsentProof } from "./advertising-consent.js";
import { accepted, proofMatches, receiptFor } from "./meta-advertising.js";
import { initialSendInvoiceFacts } from "./send-purchase.js";

const contexts = schema.googleCheckoutContexts;
const outbox = schema.googleConversionOutbox;
type Attempt = typeof schema.sendCheckoutAttempts.$inferSelect;
type Outbox = typeof outbox.$inferSelect;
const CONTEXT_MS = 7 * 24 * 60 * 60 * 1000;
/** The Measurement Protocol accepts events up to 72 hours old. */
const DELIVERY_MS = 72 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface GoogleConversionConfig {
  enabled: boolean;
  measurementId?: string;
  apiSecret?: string;
}
export type ConfiguredGoogle = Required<GoogleConversionConfig>;

export function googleConversionConfigured(
  config: GoogleConversionConfig | undefined,
): config is ConfiguredGoogle {
  return (
    !!config &&
    config.enabled === true &&
    /^G-[A-Z0-9]{6,16}$/.test(config.measurementId ?? "") &&
    /^[A-Za-z0-9_-]{10,100}$/.test(config.apiSecret ?? "")
  );
}

/** Same Google tag as the public pages (G-3624E08M6J) unless overridden. */
export function readGoogleConversionConfig(
  env: Record<string, string | undefined>,
): GoogleConversionConfig {
  const config: GoogleConversionConfig = {
    enabled: env.GA4_CONVERSIONS_ENABLED === "true",
    measurementId: env.GA4_MEASUREMENT_ID || "G-3624E08M6J",
    ...(env.GA4_API_SECRET ? { apiSecret: env.GA4_API_SECRET } : {}),
  };
  // An incomplete or disabled configuration must not retain a credential for a caller to log.
  return googleConversionConfigured(config) ? config : { enabled: false };
}

/** `_ga` = GA1.<depth>.<random>.<seconds>; the client id is the last two fields. */
export function googleClientId(cookieHeader: string | null): string | null {
  const value = advertisingCookie(cookieHeader, "_ga");
  return /^GA1\.\d{1,2}\.([0-9]{1,20}\.[0-9]{1,20})$/.exec(value ?? "")?.[1] ?? null;
}

/** `_ga_<container>` carries the session start: GS1.1.<id>.… or GS2.1.s<id>$…. */
export function googleSessionId(cookieHeader: string | null, measurementId: string): string | null {
  const value = advertisingCookie(cookieHeader, `_ga_${measurementId.replace(/^G-/, "")}`) ?? "";
  return (
    /^GS1\.\d{1,2}\.([0-9]{1,20})\./.exec(value)?.[1] ??
    /^GS2\.\d{1,2}\.s([0-9]{1,20})(?:\$|$)/.exec(value)?.[1] ??
    null
  );
}

export interface GoogleCheckoutAdvertising {
  config: GoogleConversionConfig;
  proof: ConsentProof | null;
  cookieHeader: string | null;
}

/** Called only on the first durable financial intent, beside the Meta capture. No late attribution. */
export async function prepareGoogleCheckout(
  tx: Db,
  attempt: Attempt,
  advertising: GoogleCheckoutAdvertising | undefined,
  now: Date,
) {
  if (!advertising || !googleConversionConfigured(advertising.config) || !advertising.proof) return;
  const proof = advertising.proof;
  const receipt = await receiptFor(tx, proof.id, true);
  if (
    !proofMatches(receipt, proof, now) ||
    !accepted(receipt, now) ||
    !attempt.createdBy ||
    (receipt.userId && receipt.userId !== attempt.createdBy)
  )
    return;
  const clientId = googleClientId(advertising.cookieHeader);
  if (!clientId) return;
  if (!receipt.userId)
    await tx
      .update(schema.advertisingConsentReceipts)
      .set({ userId: attempt.createdBy, updatedAt: now })
      .where(eq(schema.advertisingConsentReceipts.id, receipt.id));
  await tx
    .insert(contexts)
    .values({
      attemptId: attempt.id,
      consentReceiptId: receipt.id,
      clientId,
      sessionId: googleSessionId(advertising.cookieHeader, advertising.config.measurementId),
      capturedAt: now,
      expiresAt: new Date(now.getTime() + CONTEXT_MS),
    })
    .onConflictDoNothing();
}

/** Same transaction as stripe_events and the financial projection; HTTP only from the worker. */
export async function recordGooglePurchase(
  tx: Db,
  event: Stripe.Event,
  subscription: Stripe.Subscription,
  mailbox: boolean,
  config: GoogleConversionConfig | undefined,
  now = new Date(),
) {
  if (!googleConversionConfigured(config) || event.type !== "invoice.payment_succeeded") return;
  const attemptId = subscription.metadata?.mepmail_send_checkout;
  if (!attemptId || !UUID.test(attemptId)) return;
  const [attempt] = await tx
    .select()
    .from(schema.sendCheckoutAttempts)
    .where(eq(schema.sendCheckoutAttempts.id, attemptId));
  if (!attempt) return;
  const facts = initialSendInvoiceFacts({
    type: event.type,
    invoice: event.data.object,
    subscription,
    attempt,
    mailbox,
    anyRung: true,
  });
  if (
    !facts ||
    event.livemode !== attempt.livemode ||
    facts.paidAt > now ||
    facts.paidAt.getTime() + DELIVERY_MS <= now.getTime()
  )
    return;
  const [context] = await tx.select().from(contexts).where(eq(contexts.attemptId, attempt.id));
  if (!context || context.expiresAt <= now) return;
  const receipt = await receiptFor(tx, context.consentReceiptId, true);
  // Unix second precision: an invoice predating this intent/consent is never attributed later.
  if (
    !accepted(receipt, now) ||
    receipt.userId !== attempt.createdBy ||
    Math.floor(context.capturedAt.getTime() / 1000) > Math.floor(facts.paidAt.getTime() / 1000)
  )
    return;
  await tx
    .insert(outbox)
    .values({
      attemptId: attempt.id,
      consentReceiptId: receipt.id,
      transactionId: facts.stripeInvoiceId,
      rung: attempt.rung,
      valueMinor: facts.amountPaidMinor,
      currency: "USD",
      eventTime: facts.paidAt,
      nextAttemptAt: now,
      expiresAt: new Date(facts.paidAt.getTime() + DELIVERY_MS),
    })
    .onConflictDoNothing();
}

/** Withdrawal or replacement of a consent: nothing pending leaves, and the identity is erased. */
export async function withdrawGoogleConversions(tx: Db, consentReceiptId: string) {
  await tx
    .update(outbox)
    .set({ status: "cancelled", leaseUntil: null, lastFailure: "consent_withdrawn" })
    .where(
      and(
        eq(outbox.consentReceiptId, consentReceiptId),
        inArray(outbox.status, ["pending", "leased"]),
      ),
    );
  await tx.delete(contexts).where(eq(contexts.consentReceiptId, consentReceiptId));
}

export type GoogleFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number }>;
export type GoogleDeliveryOutcome =
  | { status: "accepted" }
  | { status: "retry"; reason: string }
  | { status: "rejected"; reason: string };

/** Only allowlisted fields: the GA client/session ids, the invoice id, the plan and the amount. */
export function buildGooglePurchase(
  row: Outbox,
  context: { clientId: string; sessionId: string | null },
) {
  return {
    client_id: context.clientId,
    timestamp_micros: row.eventTime.getTime() * 1000,
    non_personalized_ads: true,
    consent: { ad_user_data: "GRANTED", ad_personalization: "DENIED" },
    events: [
      {
        name: "purchase",
        params: {
          transaction_id: row.transactionId,
          value: row.valueMinor / 100,
          currency: row.currency,
          engagement_time_msec: 1,
          ...(context.sessionId ? { session_id: context.sessionId } : {}),
          items: [
            {
              item_id: row.rung,
              item_name: "MepMail Send",
              price: row.valueMinor / 100,
              quantity: 1,
            },
          ],
        },
      },
    ],
  };
}

/** A finished sign-up for GA4 (`sign_up`): the browser's GA ids and nothing about the account. */
export function buildGoogleSignUp(row: {
  clientId: string;
  sessionId: string | null;
  eventTime: Date;
}) {
  return {
    client_id: row.clientId,
    timestamp_micros: row.eventTime.getTime() * 1000,
    non_personalized_ads: true,
    consent: { ad_user_data: "GRANTED", ad_personalization: "DENIED" },
    events: [
      {
        name: "sign_up",
        params: {
          engagement_time_msec: 1,
          ...(row.sessionId ? { session_id: row.sessionId } : {}),
        },
      },
    ],
  };
}

/** The URL carries the API secret: it is never logged or returned. */
export async function sendGooglePurchase(
  body: ReturnType<typeof buildGooglePurchase> | ReturnType<typeof buildGoogleSignUp>,
  config: ConfiguredGoogle,
  fetcher: GoogleFetch,
): Promise<GoogleDeliveryOutcome> {
  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(config.measurementId)}&api_secret=${encodeURIComponent(config.apiSecret)}`;
  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status >= 200 && response.status < 300) return { status: "accepted" };
    if (response.status === 429 || response.status >= 500)
      return { status: "retry", reason: `http_${response.status}` };
    return { status: "rejected", reason: `http_${response.status}` };
  } catch {
    return { status: "retry", reason: "network" };
  }
}

/** Durable retry key/time/value; consent is re-checked under its lock before each POST. */
export async function dispatchGoogleConversions(
  db: Db,
  config: GoogleConversionConfig,
  deps: { fetch: GoogleFetch; now?: () => Date },
) {
  if (!googleConversionConfigured(config)) return { considered: 0, sent: 0 };
  const clock = deps.now ?? (() => new Date());
  const due = await db
    .select()
    .from(outbox)
    .where(
      and(
        lte(outbox.nextAttemptAt, clock()),
        or(
          eq(outbox.status, "pending"),
          and(eq(outbox.status, "leased"), lte(outbox.leaseUntil, clock())),
        ),
      ),
    )
    .limit(20);
  let sent = 0;
  for (const candidate of due) {
    await db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      // Consent lock first everywhere: a completed withdrawal cannot race this delivery.
      const receipt = await receiptFor(tx, candidate.consentReceiptId, true);
      const [row] = await tx
        .select()
        .from(outbox)
        .where(eq(outbox.id, candidate.id))
        .for("update", { skipLocked: true });
      const now = clock();
      if (
        !row ||
        !["pending", "leased"].includes(row.status) ||
        row.nextAttemptAt > now ||
        (row.status === "leased" && row.leaseUntil && row.leaseUntil > now)
      )
        return;
      const finish = (
        status: Outbox["status"],
        lastFailure: string | null,
        extra: Partial<Outbox> = {},
      ) =>
        tx
          .update(outbox)
          .set({ status, lastFailure, leaseUntil: null, ...extra })
          .where(eq(outbox.id, row.id));
      const [context] = await tx
        .select()
        .from(contexts)
        .where(eq(contexts.attemptId, row.attemptId));
      const [attempt] = await tx
        .select()
        .from(schema.sendCheckoutAttempts)
        .where(eq(schema.sendCheckoutAttempts.id, row.attemptId));
      if (
        !accepted(receipt, now) ||
        !attempt ||
        receipt.userId !== attempt.createdBy ||
        !context ||
        context.consentReceiptId !== row.consentReceiptId
      ) {
        await finish("cancelled", "consent_withdrawn");
        return;
      }
      if (row.expiresAt <= now || row.attempts >= 5) {
        await finish("dead", "delivery_expired");
        return;
      }
      await tx
        .update(outbox)
        .set({ status: "leased", leaseUntil: new Date(now.getTime() + 120_000) })
        .where(eq(outbox.id, row.id));
      const outcome = await sendGooglePurchase(
        buildGooglePurchase(row, context),
        config,
        deps.fetch,
      );
      if (outcome.status === "accepted") {
        await finish("sent", null, { attempts: row.attempts + 1 });
        sent++;
      } else if (outcome.status === "retry")
        await finish("pending", outcome.reason, {
          attempts: row.attempts + 1,
          nextAttemptAt: new Date(now.getTime() + Math.min(3600_000, 60_000 * 2 ** row.attempts)),
        });
      else await finish("dead", outcome.reason, { attempts: row.attempts + 1 });
    });
  }
  return { considered: due.length, sent };
}
