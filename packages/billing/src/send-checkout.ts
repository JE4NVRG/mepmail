import { randomUUID } from "node:crypto";
import { type PlanRungKey, rungByKey } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq, ne, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { type GoogleCheckoutAdvertising, prepareGoogleCheckout } from "./google-advertising.js";
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
} from "./meta-advertising.js";
import {
  effectiveOverageRate,
  overageLookupKey,
  resolvePriceId,
  rungFromPrice,
  rungLookupKey,
} from "./prices.js";
import {
  resolveSendLaunchPrice,
  SEND_LAUNCH_OFFER,
  verifySendIntroCoupon,
} from "./send-launch-offer.js";
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
