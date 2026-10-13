import { randomUUID } from "node:crypto";
import { type PlanRungKey, rungByKey } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq, ne, sql } from "drizzle-orm";
import type Stripe from "stripe";
import {
  type GoogleCheckoutAdvertising,
  type GoogleConversionConfig,
  prepareGoogleCheckout,
  recordGooglePixPurchase,
} from "./google-advertising.js";
import {
  isMailboxSubscription,
  MAILBOX_CUSTOMER_METADATA_KEY,
  MAILBOX_SERVICE,
  MAILBOX_SERVICE_METADATA_KEY,
} from "./mailbox.js";
import {
  type MetaCheckoutAdvertising,
  prepareMetaCheckout,
  recordMetaCheckout,
  recordMetaPixPurchase,
} from "./meta-advertising.js";
import type { MetaConversionConfig } from "./meta-conversions.js";
import {
  createPixCheckoutSession,
  PIX_COLLECTION,
  PIX_COLLECTION_METADATA_KEY,
  PIX_DAYS_UNTIL_DUE,
  PIX_SESSION_METADATA_KEY,
  type PixPayment,
  type PixStripe,
  pixAmountForPrice,
  refundPixPayment,
  settlePixInvoice,
} from "./pix.js";
import {
  effectiveOverageRate,
  overageLookupKey,
  resolvePriceId,
  rungFromPrice,
  rungLookupKey,
  SUBSCRIPTION_EXPAND,
} from "./prices.js";
import {
  resolveSendLaunchPrice,
  SEND_LAUNCH_OFFER,
  verifySendIntroCoupon,
} from "./send-launch-offer.js";
import { initialSendPixFacts } from "./send-purchase.js";
import type { BillingStripe } from "./stripe.js";
import { idOf, lockCustomer } from "./subscription.js";

export const SEND_CHECKOUT_METADATA_KEY = "mepmail_send_checkout";
const REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;
const LEASE_MS = 120_000;
const OCCUPIED = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);
type Attempt = typeof schema.sendCheckoutAttempts.$inferSelect;

export class SendCheckoutError extends Error {
  constructor(
    public readonly code:
      | "forbidden"
      | "not_found"
      | "invalid"
      | "conflict"
      | "pending"
      | "unknown"
      | "subscription_exists"
      | "expired",
  ) {
    super(code);
    this.name = "SendCheckoutError";
  }
}
export interface SendCheckoutDeps {
  db: Db;
  stripe: BillingStripe;
  livemode: boolean;
  advertising?: MetaCheckoutAdvertising;
  googleAdvertising?: GoogleCheckoutAdvertising;
  /** Enable only after the account's immutable launch prices and coupon are verified. */
  launchOfferEnabled?: boolean;
}
export interface SendCheckoutInput {
  team: { id: string; name: string; stripeCustomerId: string | null };
  userId: string;
  rung: PlanRungKey;
  interval?: "month" | "year";
  email: string;
  successUrl: string;
  cancelUrl: string;
  automaticTax?: boolean;
}
export interface SendCheckoutResult {
  url: string;
  attemptId: string;
  stripeSessionId: string;
}

async function now(db: Db): Promise<Date> {
  const [row] = await db
    .select({ value: sql<string>`clock_timestamp()` })
    .from(schema.teams)
    .limit(1);
  if (!row) throw new SendCheckoutError("unknown");
  return new Date(row.value);
}
async function currentTeam(db: Db, input: SendCheckoutInput) {
  // Customer -> team -> member order is shared with Mail, webhook and erasure.
  const [discovered] = await db
    .select({ customer: schema.teams.stripeCustomerId })
    .from(schema.teams)
    .where(eq(schema.teams.id, input.team.id));
  if (!discovered) throw new SendCheckoutError("not_found");
  if (discovered.customer) await lockCustomer(db, discovered.customer);
  const [team] = await db
    .select()
    .from(schema.teams)
    .where(eq(schema.teams.id, input.team.id))
    .for("update");
  if (!team) throw new SendCheckoutError("not_found");
  if (team.stripeCustomerId !== discovered.customer) throw new SendCheckoutError("conflict");
  const [member] = await db
    .select({ role: schema.teamMembers.role })
    .from(schema.teamMembers)
    .where(and(eq(schema.teamMembers.teamId, team.id), eq(schema.teamMembers.userId, input.userId)))
    .for("share");
  if (
    !member ||
    !["owner", "admin"].includes(member.role) ||
    team.plan === "system" ||
    team.suspendedAt
  )
    throw new SendCheckoutError("forbidden");
  if (OCCUPIED.has(team.planStatus)) throw new SendCheckoutError("subscription_exists");
  return team;
}

/** Same durable first-Customer claim as Mail. Unknown Customer is recovered explicitly, never by TTL. */
async function ensureCustomer(deps: SendCheckoutDeps, input: SendCheckoutInput): Promise<string> {
  const prepared = await deps.db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const team = await currentTeam(tx, input);
    if (team.stripeCustomerId) return { customer: team.stripeCustomerId, key: null };
    const [existing] = await tx
      .select()
      .from(schema.mailboxCustomerRequests)
      .where(eq(schema.mailboxCustomerRequests.teamId, team.id))
      .for("update");
    if (existing) throw new SendCheckoutError("pending");
    const [buyer] = await tx
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, input.userId));
    if (!buyer?.email || !team.name) throw new SendCheckoutError("invalid");
    const key = `send-customer:${team.id}:${randomUUID()}`;
    await tx.insert(schema.mailboxCustomerRequests).values({
      teamId: team.id,
      createdBy: input.userId,
      status: "creating",
      name: team.name,
      email: buyer.email,
      livemode: deps.livemode,
      idempotencyKey: key,
    });
    return { customer: null, key };
  });
  if (prepared.customer) return prepared.customer;
  try {
    // This explicit transaction is never automatically replayed. The intent already committed.
    // Keeping the team lock through this one POST prevents a parallel Mail Customer creation.
    return await deps.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      const team = await currentTeam(tx, input);
      if (team.stripeCustomerId) return team.stripeCustomerId;
      const [request] = await tx
        .select()
        .from(schema.mailboxCustomerRequests)
        .where(eq(schema.mailboxCustomerRequests.teamId, team.id))
        .for("update");
      if (
        !request ||
        request.status !== "creating" ||
        request.idempotencyKey !== prepared.key ||
        request.livemode !== deps.livemode
      )
        throw new SendCheckoutError("pending");
      const customer = await deps.stripe.customers.create(
        {
          name: request.name,
          email: request.email,
          metadata: { team_id: team.id, [MAILBOX_CUSTOMER_METADATA_KEY]: request.idempotencyKey },
        },
        { idempotencyKey: request.idempotencyKey },
      );
      if (!/^cus_[A-Za-z0-9_]+$/.test(customer.id) || customer.livemode !== deps.livemode)
        throw new SendCheckoutError("pending");
      await tx
        .update(schema.teams)
        .set({ stripeCustomerId: customer.id })
        .where(eq(schema.teams.id, team.id));
      await tx
        .update(schema.mailboxCustomerRequests)
        .set({ status: "ready", stripeCustomerId: customer.id, updatedAt: await now(tx) })
        .where(eq(schema.mailboxCustomerRequests.teamId, team.id));
      return customer.id;
    });
  } catch (error) {
    if (error instanceof SendCheckoutError) throw error;
    throw new SendCheckoutError("pending");
  }
}

function matches(session: Stripe.Checkout.Session, attempt: Attempt): boolean {
  return (
    /^cs_[A-Za-z0-9_]+$/.test(session.id) &&
    (!attempt.stripeSessionId || session.id === attempt.stripeSessionId) &&
    session.mode === "subscription" &&
    idOf(session.customer) === attempt.stripeCustomerId &&
    session.livemode === attempt.livemode &&
    session.client_reference_id === attempt.teamId &&
    session.metadata?.[SEND_CHECKOUT_METADATA_KEY] === attempt.id
  );
}
function compatible(attempt: Attempt, input: SendCheckoutInput, deps: SendCheckoutDeps): boolean {
  const p = attempt.parameters as Stripe.Checkout.SessionCreateParams;
  return (
    attempt.rung === input.rung &&
    attempt.livemode === deps.livemode &&
    (p.metadata?.mepmail_send_interval ?? "month") === (input.interval ?? "month") &&
    p.success_url === input.successUrl &&
    p.cancel_url === input.cancelUrl &&
    p.automatic_tax?.enabled === (input.automaticTax ?? true)
  );
}
function result(attempt: Attempt): SendCheckoutResult {
  if (!attempt.checkoutUrl || !attempt.stripeSessionId) throw new SendCheckoutError("unknown");
  return {
    url: attempt.checkoutUrl,
    attemptId: attempt.id,
    stripeSessionId: attempt.stripeSessionId,
  };
}
async function noOtherSubscription(deps: SendCheckoutDeps, customer: string) {
  let after: string | undefined;
  for (;;) {
    const page = await deps.stripe.subscriptions.list({
      customer,
      status: "all",
      limit: 100,
      ...(after ? { starting_after: after } : {}),
    });
    for (const sub of page.data) {
      if (idOf(sub.customer) !== customer || sub.livemode !== deps.livemode)
        throw new SendCheckoutError("unknown");
      if (!isMailboxSubscription(sub) && OCCUPIED.has(sub.status))
        throw new SendCheckoutError("subscription_exists");
    }
    if (!page.has_more) return;
    const last = page.data.at(-1)?.id;
    if (!last || last === after) throw new SendCheckoutError("unknown");
    after = last;
  }
}

async function qualifiesForIntro(deps: SendCheckoutDeps, customer: string): Promise<boolean> {
  if (!deps.stripe.invoices?.list) throw new SendCheckoutError("unknown");
  const invoices = await deps.stripe.invoices.list({ customer, status: "paid", limit: 1 });
  if (invoices.data.length || invoices.has_more) return false;
  let after: string | undefined;
  for (;;) {
    const page = await deps.stripe.subscriptions.list({
      customer,
      status: "all",
      limit: 100,
      ...(after ? { starting_after: after } : {}),
    });
    for (const sub of page.data) {
      if (idOf(sub.customer) !== customer || sub.livemode !== deps.livemode)
        throw new SendCheckoutError("unknown");
      if (!isMailboxSubscription(sub) && sub.status !== "incomplete_expired") return false;
    }
    if (!page.has_more) return true;
    const last = page.data.at(-1)?.id;
    if (!last || last === after) throw new SendCheckoutError("unknown");
    after = last;
  }
}
async function noLegacySession(deps: SendCheckoutDeps, attempt: Attempt) {
  if (!deps.stripe.checkout.sessions.list) throw new SendCheckoutError("unknown");
  let after: string | undefined;
  let recovered: Stripe.Checkout.Session | null = null;
  for (;;) {
    const page = await deps.stripe.checkout.sessions.list({
      customer: attempt.stripeCustomerId,
      limit: 100,
      ...(after ? { starting_after: after } : {}),
    });
    for (const session of page.data) {
      if (idOf(session.customer) !== attempt.stripeCustomerId || session.livemode !== deps.livemode)
        throw new SendCheckoutError("unknown");
      if (session.metadata?.[SEND_CHECKOUT_METADATA_KEY] === attempt.id) {
        if (recovered || !matches(session, attempt)) throw new SendCheckoutError("unknown");
        recovered = session;
        continue;
      }
      if (
        session.metadata?.[MAILBOX_SERVICE_METADATA_KEY] === MAILBOX_SERVICE ||
        session.mode !== "subscription"
      )
        continue;
      if (session.status === "open") throw new SendCheckoutError("pending");
      if (session.status !== "expired" && session.status !== "complete")
        throw new SendCheckoutError("unknown");
      if (session.status === "complete") {
        const subId = idOf(session.subscription);
        if (!subId) throw new SendCheckoutError("unknown");
        const sub = await deps.stripe.subscriptions.retrieve(subId);
        if (
          idOf(sub.customer) !== attempt.stripeCustomerId ||
          sub.livemode !== deps.livemode ||
          !["canceled", "incomplete_expired"].includes(sub.status)
        )
          throw new SendCheckoutError("subscription_exists");
      }
    }
    if (!page.has_more) return recovered;
    const last = page.data.at(-1)?.id;
    if (!last || last === after) throw new SendCheckoutError("unknown");
    after = last;
  }
}

/** Reuses an open attempt. A lost response can replay only its immutable key within 23 hours. */
export async function beginSendCheckout(
  deps: SendCheckoutDeps,
  input: SendCheckoutInput,
): Promise<SendCheckoutResult> {
  deps = { ...deps };
  input = { ...input, team: { ...input.team } };
  if (typeof deps.livemode !== "boolean" || !input.userId) throw new SendCheckoutError("invalid");
  const rung = rungByKey(input.rung);
  const interval = input.interval ?? "month";
  if (interval !== "month" && interval !== "year") throw new SendCheckoutError("invalid");
  const launch = deps.launchOfferEnabled === true && input.rung === "pro_100k";
  if (interval === "year" && !launch) throw new SendCheckoutError("invalid");
  if (rung.priceCents <= 0) throw new Error(`rung ${input.rung} is not for sale`);
  // Price lookups are read-only. Once an attempt exists, its frozen IDs always win.
  const customer = await ensureCustomer(deps, input);
  const existing = await deps.db
    .select()
    .from(schema.sendCheckoutAttempts)
    .where(
      and(
        eq(schema.sendCheckoutAttempts.teamId, input.team.id),
        ne(schema.sendCheckoutAttempts.status, "resolved"),
      ),
    );
  const launchPrice =
    !existing.length && launch
      ? await resolveSendLaunchPrice(deps.stripe, interval, deps.livemode)
      : null;
  const [price, overage] = existing.length
    ? [null, null]
    : await Promise.all([
        launchPrice ? launchPrice.id : resolvePriceId(deps.stripe, rungLookupKey(rung)),
        rung.period === "month" && interval === "month"
          ? resolvePriceId(deps.stripe, overageLookupKey(rung))
          : null,
      ]);
  if (launchPrice && overage) {
    const page = await deps.stripe.prices.list({
      lookup_keys: [overageLookupKey(rung)],
      active: true,
    });
    const metered = page.data.find((entry) => entry.id === overage);
    const meteredRung = metered ? rungFromPrice(metered) : null;
    if (
      !metered ||
      page.has_more ||
      !metered.active ||
      metered.livemode !== deps.livemode ||
      (metered.recurring?.interval_count ?? 1) !== 1 ||
      meteredRung?.key !== rung.key ||
      meteredRung.included !== rung.included ||
      effectiveOverageRate(metered) !== rung.overageCentsPer1k ||
      idOf(metered.product) === idOf(launchPrice.product)
    )
      throw new SendCheckoutError("invalid");
  }
  const prepared = await deps.db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const team = await currentTeam(tx, input);
    if (team.stripeCustomerId !== customer) throw new SendCheckoutError("conflict");
    const [active] = await tx
      .select()
      .from(schema.sendCheckoutAttempts)
      .where(
        and(
          eq(schema.sendCheckoutAttempts.teamId, team.id),
          ne(schema.sendCheckoutAttempts.status, "resolved"),
        ),
      )
      .for("update");
    if (active) {
      if (!compatible(active, input, deps) || active.stripeCustomerId !== customer)
        throw new SendCheckoutError("conflict");
      return active;
    }
    if (!price) throw new SendCheckoutError("pending");
    const id = randomUUID();
    const productId = launchPrice ? idOf(launchPrice.product) : null;
    const intro = launchPrice && interval === "month" && (await qualifiesForIntro(deps, customer));
    const coupon =
      intro && productId
        ? await verifySendIntroCoupon(deps.stripe, productId, deps.livemode)
        : null;
    const metadata = {
      team_id: team.id,
      [SEND_CHECKOUT_METADATA_KEY]: id,
      mepmail_send_interval: interval,
      ...(launchPrice
        ? {
            mepmail_send_offer: SEND_LAUNCH_OFFER,
            mepmail_send_intro: coupon ? "first_invoice_900" : "none",
          }
        : {}),
    };
    const parameters = {
      mode: "subscription",
      customer,
      client_reference_id: team.id,
      metadata,
      subscription_data: { metadata },
      line_items: [{ price, quantity: 1 }, ...(overage ? [{ price: overage }] : [])],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      automatic_tax: { enabled: input.automaticTax ?? true },
      tax_id_collection: { enabled: input.automaticTax ?? true },
      ...(coupon
        ? { discounts: [{ coupon }] }
        : launchPrice
          ? {}
          : { allow_promotion_codes: true }),
      billing_address_collection: "auto",
      customer_update: { address: "auto", name: "auto" },
    };
    const [attempt] = await tx
      .insert(schema.sendCheckoutAttempts)
      .values({
        id,
        teamId: team.id,
        createdBy: input.userId,
        status: "prepared",
        rung: input.rung,
        livemode: deps.livemode,
        stripeCustomerId: customer,
        idempotencyKey: `send-checkout:${id}`,
        parameters,
      })
      .returning();
    if (!attempt) throw new SendCheckoutError("unknown");
    await prepareMetaCheckout(tx, attempt, deps.advertising, attempt.createdAt);
    await prepareGoogleCheckout(tx, attempt, deps.googleAdvertising, attempt.createdAt);
    return attempt;
  });
  const claim = await deps.db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await currentTeam(tx, input);
    const [attempt] = await tx
      .select()
      .from(schema.sendCheckoutAttempts)
      .where(eq(schema.sendCheckoutAttempts.id, prepared.id))
      .for("update");
    if (!attempt || !compatible(attempt, input, deps)) throw new SendCheckoutError("conflict");
    if (attempt.status === "resolved") throw new SendCheckoutError("expired");
    const time = await now(tx);
    if (attempt.leaseUntil && attempt.leaseUntil > time) throw new SendCheckoutError("pending");
    const token = randomUUID();
    // Durable unknown commits before POST; a crash at any subsequent point cannot authorize another intent.
    const [claimed] = await tx
      .update(schema.sendCheckoutAttempts)
      .set({
        status: attempt.status === "created" ? "created" : "unknown",
        firstRequestedAt: attempt.firstRequestedAt ?? time,
        leaseToken: token,
        leaseUntil: new Date(time.getTime() + LEASE_MS),
        updatedAt: time,
      })
      .where(eq(schema.sendCheckoutAttempts.id, attempt.id))
      .returning();
    if (!claimed) throw new SendCheckoutError("unknown");
    return { ...claimed, newRequest: attempt.firstRequestedAt === null };
  });
  let postStarted = false;
  try {
    const outcome = await deps.db.transaction(
      async (transaction): Promise<SendCheckoutResult | { error: "expired" | "pending" }> => {
        const tx = transaction as unknown as Db;
        const team = await currentTeam(tx, input);
        const [attempt] = await tx
          .select()
          .from(schema.sendCheckoutAttempts)
          .where(eq(schema.sendCheckoutAttempts.id, claim.id))
          .for("update");
        if (
          !attempt ||
          attempt.leaseToken !== claim.leaseToken ||
          team.stripeCustomerId !== attempt.stripeCustomerId
        )
          throw new SendCheckoutError("pending");
        await noOtherSubscription(deps, attempt.stripeCustomerId);
        let session: Stripe.Checkout.Session;
        if (attempt.stripeSessionId) {
          if (!deps.stripe.checkout.sessions.retrieve) throw new SendCheckoutError("unknown");
          session = await deps.stripe.checkout.sessions.retrieve(attempt.stripeSessionId);
        } else {
          const recovered = await noLegacySession(deps, attempt);
          if (recovered) session = recovered;
          else {
            const time = await now(tx);
            if (
              !attempt.firstRequestedAt ||
              time.getTime() - attempt.firstRequestedAt.getTime() >= REPLAY_WINDOW_MS
            )
              throw new SendCheckoutError("unknown");
            postStarted = true;
            session = await deps.stripe.checkout.sessions.create(
              attempt.parameters as Stripe.Checkout.SessionCreateParams,
              { idempotencyKey: attempt.idempotencyKey },
            );
          }
        }
        if (!matches(session, attempt)) throw new SendCheckoutError("unknown");
        const time = await now(tx);
        if (session.status === "expired") {
          await tx
            .update(schema.sendCheckoutAttempts)
            .set({
              status: "resolved",
              stripeSessionId: session.id,
              resolvedAt: time,
              leaseToken: null,
              leaseUntil: null,
              updatedAt: time,
            })
            .where(
              and(
                eq(schema.sendCheckoutAttempts.id, attempt.id),
                eq(schema.sendCheckoutAttempts.leaseToken, claim.leaseToken!),
              ),
            );
          return { error: "expired" };
        }
        if (session.status === "complete") {
          const subscriptionId = idOf(session.subscription);
          if (!subscriptionId) throw new SendCheckoutError("unknown");
          const subscription = await deps.stripe.subscriptions.retrieve(subscriptionId);
          if (
            idOf(subscription.customer) !== attempt.stripeCustomerId ||
            subscription.livemode !== attempt.livemode ||
            isMailboxSubscription(subscription)
          )
            throw new SendCheckoutError("unknown");
          if (["canceled", "incomplete_expired"].includes(subscription.status)) {
            await tx
              .update(schema.sendCheckoutAttempts)
              .set({
                status: "resolved",
                stripeSessionId: session.id,
                resolvedAt: time,
                leaseToken: null,
                leaseUntil: null,
                updatedAt: time,
              })
              .where(
                and(
                  eq(schema.sendCheckoutAttempts.id, attempt.id),
                  eq(schema.sendCheckoutAttempts.leaseToken, claim.leaseToken!),
                ),
              );
            return { error: "expired" };
          }
          await tx
            .update(schema.sendCheckoutAttempts)
            .set({
              status: "unknown",
              stripeSessionId: session.id,
              leaseToken: null,
              leaseUntil: null,
              updatedAt: time,
            })
            .where(
              and(
                eq(schema.sendCheckoutAttempts.id, attempt.id),
                eq(schema.sendCheckoutAttempts.leaseToken, claim.leaseToken!),
              ),
            );
          return { error: "pending" };
        }
        if (
          session.status !== "open" ||
          !session.url ||
          !/^https:\/\/checkout\.stripe\.com\//.test(session.url)
        )
          throw new SendCheckoutError("unknown");
        const [saved] = await tx
          .update(schema.sendCheckoutAttempts)
          .set({
            status: "created",
            stripeSessionId: session.id,
            checkoutUrl: session.url,
            leaseToken: null,
            leaseUntil: null,
            updatedAt: time,
          })
          .where(
            and(
              eq(schema.sendCheckoutAttempts.id, attempt.id),
              eq(schema.sendCheckoutAttempts.leaseToken, claim.leaseToken!),
            ),
          )
          .returning();
        if (!saved) throw new SendCheckoutError("pending");
        await recordMetaCheckout(tx, saved, session, deps.advertising, time);
        return result(saved);
      },
    );
    if ("error" in outcome) throw new SendCheckoutError(outcome.error);
    return outcome;
  } catch (error) {
    // Release only our lease, never the financial intent. A failed cleanup safely leaves the lease to expire.
    try {
      await deps.db
        .update(schema.sendCheckoutAttempts)
        .set({
          leaseToken: null,
          leaseUntil: null,
          ...(claim.newRequest && !postStarted
            ? { status: "prepared" as const, firstRequestedAt: null }
            : {}),
        })
        .where(
          and(
            eq(schema.sendCheckoutAttempts.id, claim.id),
            eq(schema.sendCheckoutAttempts.leaseToken, claim.leaseToken!),
          ),
        );
    } catch {
      /* keep unknown */
    }
    if (error instanceof SendCheckoutError) throw error;
    throw new SendCheckoutError("unknown");
  }
}

/** The intro coupon's discount in reais, or null when it has no BRL amount. */
async function introCouponBrl(stripe: BillingStripe, coupon: string): Promise<number | null> {
  if (!stripe.coupons) return null;
  const found = await stripe.coupons.retrieve(coupon, { expand: ["currency_options"] });
  const amount = found.currency_options?.brl?.amount_off;
  return found.valid && Number.isSafeInteger(amount) && (amount as number) > 0
    ? (amount as number)
    : null;
}

/** What a first Pix for this Send purchase is: prices, intro coupon and the amount in reais. */
async function sendPixTerms(
  deps: SendCheckoutDeps,
  pix: PixStripe,
  customer: string,
  rungKey: PlanRungKey,
  interval: "month" | "year",
) {
  const rung = rungByKey(rungKey);
  const launch = deps.launchOfferEnabled === true && rungKey === "pro_100k";
  if ((interval === "year" && !launch) || rung.priceCents <= 0)
    throw new SendCheckoutError("invalid");
  const launchPrice = launch
    ? await resolveSendLaunchPrice(deps.stripe, interval, deps.livemode)
    : null;
  const price = launchPrice
    ? launchPrice.id
    : await resolvePriceId(deps.stripe, rungLookupKey(rung));
  const overage =
    rung.period === "month" && interval === "month"
      ? await resolvePriceId(deps.stripe, overageLookupKey(rung))
      : null;
  const priced = await pixAmountForPrice(pix, price, 1);
  if (!priced) throw new SendCheckoutError("invalid");
  let coupon: string | null = null;
  let discount = 0;
  if (launchPrice && interval === "month" && (await qualifiesForIntro(deps, customer))) {
    coupon = await verifySendIntroCoupon(
      deps.stripe,
      idOf(launchPrice.product) ?? "",
      deps.livemode,
    );
    const brl = await introCouponBrl(deps.stripe, coupon);
    if (brl === null) throw new SendCheckoutError("invalid");
    discount = brl;
  }
  const amount = priced.amount - discount;
  if (amount <= 0) throw new SendCheckoutError("invalid");
  return { price, overage, coupon, amount, product: priced.product };
}

/**
 * Send paid by Pix (see pix.ts): a one-time Pix Checkout in reais for the first period, the
 * intro coupon included when the team qualifies. Nothing is granted here; the webhook starts
 * the send_invoice subscription once the Pix is paid.
 */
export async function beginSendPixCheckout(
  deps: SendCheckoutDeps,
  pix: PixStripe,
  input: SendCheckoutInput,
): Promise<{ url: string }> {
  if (typeof deps.livemode !== "boolean" || !input.userId) throw new SendCheckoutError("invalid");
  const interval = input.interval ?? "month";
  if (interval !== "month" && interval !== "year") throw new SendCheckoutError("invalid");
  const customer = await ensureCustomer(deps, input);
  const attemptId = randomUUID();
  const terms = await deps.db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const team = await currentTeam(tx, input);
    if (team.stripeCustomerId !== customer) throw new SendCheckoutError("conflict");
    await noOtherSubscription(deps, customer);
    const terms = await sendPixTerms(deps, pix, customer, input.rung, interval);
    // The durable intent of this Pix purchase: the anchor of its advertising context, like a
    // card attempt. Created resolved: a Pix never holds the card Checkout's lease, and the
    // card paths only ever read unresolved attempts.
    const at = await now(tx);
    const [attempt] = await tx
      .insert(schema.sendCheckoutAttempts)
      .values({
        id: attemptId,
        teamId: team.id,
        createdBy: input.userId,
        status: "resolved",
        resolvedAt: at,
        rung: input.rung,
        livemode: deps.livemode,
        stripeCustomerId: customer,
        idempotencyKey: `pix-send:${team.id}:${attemptId}`,
        parameters: {
          method: "pix",
          client_reference_id: team.id,
          mepmail_send_interval: interval,
          line_items: [
            { price: terms.price, quantity: 1 },
            ...(terms.overage ? [{ price: terms.overage }] : []),
          ],
        },
      })
      .returning();
    if (!attempt) throw new SendCheckoutError("unknown");
    await prepareMetaCheckout(tx, attempt, deps.advertising, at);
    await prepareGoogleCheckout(tx, attempt, deps.googleAdvertising, at);
    return terms;
  });
  const url = await createPixCheckoutSession(pix, {
    kind: "send_start",
    teamId: input.team.id,
    customerId: customer,
    amount: terms.amount,
    product: terms.product,
    priceId: terms.price,
    quantity: 1,
    interval,
    ...(terms.overage ? { overagePriceId: terms.overage } : {}),
    ...(terms.coupon ? { coupon: terms.coupon } : {}),
    attemptId,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    idempotencyKey: `pix-send:${input.team.id}:${attemptId}`,
  });
  return { url };
}

/**
 * Closes the team's open card Checkout for Send, so a Pix and a card never both start a plan.
 * "completed" when Stripe already took that payment (the card is the purchase then).
 */
async function closeOpenSendCheckout(
  db: Db,
  stripe: BillingStripe,
  teamId: string,
): Promise<"none" | "closed" | "completed"> {
  const open = await db
    .select()
    .from(schema.sendCheckoutAttempts)
    .where(
      and(
        eq(schema.sendCheckoutAttempts.teamId, teamId),
        ne(schema.sendCheckoutAttempts.status, "resolved"),
      ),
    )
    .for("update");
  let state: "none" | "closed" | "completed" = "none";
  for (const attempt of open) {
    if (attempt.stripeSessionId) {
      const sessions = stripe.checkout.sessions as typeof stripe.checkout.sessions & {
        expire?: (id: string) => Promise<Stripe.Checkout.Session>;
      };
      if (!sessions.retrieve) throw new SendCheckoutError("unknown");
      let session = await sessions.retrieve(attempt.stripeSessionId);
      if (session.status === "open" && sessions.expire) {
        // Stripe refuses to expire a session that was just paid; read it again then.
        await sessions.expire(session.id).catch(() => null);
        session = await sessions.retrieve(attempt.stripeSessionId);
      }
      if (session.status === "complete") state = "completed";
      else if (session.status !== "expired") throw new SendCheckoutError("pending");
    }
    await db
      .update(schema.sendCheckoutAttempts)
      .set({ status: "resolved", resolvedAt: new Date(), leaseToken: null, leaseUntil: null })
      .where(eq(schema.sendCheckoutAttempts.id, attempt.id));
    if (state !== "completed") state = "closed";
  }
  return state;
}

/**
 * Starts the Send plan a paid first Pix bought: a send_invoice subscription in reais (base,
 * metered overage on monthly plans, the intro coupon) whose first invoice this payment
 * settles. Idempotent per Checkout session; refunds the Pix when the team cannot take it.
 */
export async function fulfillSendPixStart(
  db: Db,
  deps: PixPurchaseDeps,
  pix: PixStripe,
  payment: PixPayment,
  log: (message: string) => void,
): Promise<"fulfilled" | "refunded"> {
  await lockCustomer(db, payment.customerId);
  const refund = async (reason: string) => {
    await refundPixPayment(pix, payment, reason);
    log(`pix ${payment.sessionId}: refunded (${reason})`);
    return "refunded" as const;
  };
  const [team] = await db
    .select()
    .from(schema.teams)
    .where(eq(schema.teams.stripeCustomerId, payment.customerId));
  if (!team || team.id !== payment.teamId) return refund("team");
  // The attempt this Pix was opened under (beginSendPixCheckout), when it is this team's.
  const [found] = payment.attemptId
    ? await db
        .select()
        .from(schema.sendCheckoutAttempts)
        .where(eq(schema.sendCheckoutAttempts.id, payment.attemptId))
        .for("update")
    : [];
  const attempt =
    found &&
    found.teamId === team.id &&
    found.stripeCustomerId === payment.customerId &&
    found.livemode === deps.livemode &&
    found.parameters?.method === "pix" &&
    (found.stripeSessionId === null || found.stripeSessionId === payment.sessionId)
      ? found
      : null;
  if (attempt && attempt.stripeSessionId === null) {
    await db
      .update(schema.sendCheckoutAttempts)
      .set({ stripeSessionId: payment.sessionId, updatedAt: await now(db) })
      .where(eq(schema.sendCheckoutAttempts.id, attempt.id));
    attempt.stripeSessionId = payment.sessionId;
  }
  const listed = await pix.subscriptions.list({
    customer: payment.customerId,
    status: "all",
    limit: 100,
  });
  let sub =
    listed.data.find((s) => s.metadata?.[PIX_SESSION_METADATA_KEY] === payment.sessionId) ?? null;
  if (!sub) {
    if (team.plan === "system" || team.suspendedAt || OCCUPIED.has(team.planStatus))
      return refund("team");
    if (!payment.priceId || payment.quantity !== 1 || !payment.interval) return refund("terms");
    const card = await closeOpenSendCheckout(db, deps.stripe, team.id);
    if (card === "completed") return refund("occupied");
    try {
      await noOtherSubscription({ ...deps, db }, payment.customerId);
    } catch (error) {
      if (error instanceof SendCheckoutError && error.code === "subscription_exists")
        return refund("occupied");
      throw error;
    }
    const priced = await pixAmountForPrice(pix, payment.priceId, 1);
    const discount = payment.coupon ? await introCouponBrl(deps.stripe, payment.coupon) : 0;
    if (!priced || discount === null || priced.amount - discount !== payment.amount)
      return refund("amount");
    sub = await pix.subscriptions.create(
      {
        customer: payment.customerId,
        currency: "brl",
        collection_method: "send_invoice",
        days_until_due: PIX_DAYS_UNTIL_DUE,
        // Card only on the invoice page: boleto is never offered.
        payment_settings: { payment_method_types: ["card"] },
        items: [
          { price: payment.priceId, quantity: 1 },
          ...(payment.overagePriceId ? [{ price: payment.overagePriceId }] : []),
        ],
        ...(payment.coupon ? { discounts: [{ coupon: payment.coupon }] } : {}),
        metadata: {
          team_id: team.id,
          mepmail_send_interval: payment.interval,
          ...(payment.coupon ? { mepmail_send_intro: "first_invoice_900" } : {}),
          [PIX_COLLECTION_METADATA_KEY]: PIX_COLLECTION,
          [PIX_SESSION_METADATA_KEY]: payment.sessionId,
          ...(attempt ? { [SEND_CHECKOUT_METADATA_KEY]: attempt.id } : {}),
        },
      },
      { idempotencyKey: `pix-send-start:${payment.sessionId}` },
    );
  }
  const invoiceId = idOf(sub.latest_invoice);
  if (!invoiceId) throw new SendCheckoutError("pending");
  if ((await settlePixInvoice(pix, invoiceId, payment)) === "paid") {
    if (attempt)
      await recordSendPixPurchase(db, deps, pix, payment, attempt, sub.id, invoiceId, log);
    return "fulfilled";
  }
  // The first invoice is not this payment's amount: undo the start and give the Pix back.
  if (!["canceled", "incomplete_expired"].includes(sub.status))
    await pix.subscriptions.cancel(sub.id, { invoice_now: false, prorate: false });
  const invoice = await pix.invoices.retrieve(invoiceId);
  if (invoice.status === "open") await pix.invoices.voidInvoice(invoiceId);
  return refund("invoice");
}

/** What a Pix fulfilment needs from the webhook: Stripe, the mode and the ad configs. */
type PixPurchaseDeps = Pick<SendCheckoutDeps, "stripe" | "livemode"> & {
  advertisingConfig?: MetaConversionConfig;
  googleConversionConfig?: GoogleConversionConfig;
};

/**
 * The first purchase a paid Pix made, for Meta and Google: re-read from Stripe (the
 * PaymentIntent, the invoice this payment just settled, the subscription it started) and
 * recorded only when every link holds (initialSendPixFacts). A failed read throws, so the
 * webhook is redelivered and the idempotent fulfilment records it then.
 */
async function recordSendPixPurchase(
  db: Db,
  deps: PixPurchaseDeps,
  pix: PixStripe,
  payment: PixPayment,
  attempt: Attempt,
  subscriptionId: string,
  invoiceId: string,
  log: (message: string) => void,
) {
  if (!deps.advertisingConfig && !deps.googleConversionConfig) return;
  const [paymentIntent, invoice, subscription] = await Promise.all([
    pix.paymentIntents.retrieve(payment.paymentIntentId),
    pix.invoices.retrieve(invoiceId),
    deps.stripe.subscriptions.retrieve(subscriptionId, { expand: SUBSCRIPTION_EXPAND }),
  ]);
  const read = { payment, paymentIntent, invoice, subscription, attempt, livemode: deps.livemode };
  const meta = initialSendPixFacts(read);
  if (meta) await recordMetaPixPurchase(db, attempt, meta, deps.advertisingConfig);
  const google = initialSendPixFacts({ ...read, anyRung: true });
  if (google) await recordGooglePixPurchase(db, attempt, google, deps.googleConversionConfig);
  if (!google) log(`pix ${payment.sessionId}: purchase not confirmed for advertising`);
}
