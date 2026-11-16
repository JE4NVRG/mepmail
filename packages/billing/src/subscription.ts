import { type PlanRung, type PlanRungKey, rungByKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import type { BillingDeps } from "./checkout.js";
import { isMailboxSubscription } from "./mailbox.js";
import { reportOverage } from "./overage.js";
import { isPixSubscription, PixBillingError } from "./pix.js";
import {
  overageLookupKey,
  pendingRungOf,
  resolvePriceId,
  rungFromPrice,
  rungFromSubscription,
  rungIdentityFromPrice,
  rungLookupKey,
  SUBSCRIPTION_EXPAND,
  subscriptionItems,
} from "./prices.js";
import {
  assertPurchaseEligibility,
  PurchaseEligibilityError,
  requirePurchaseEligibility,
} from "./purchase-eligibility.js";
import { resolveSendBillingContract, verifiedSendBillingContract } from "./send-contract.js";
import type { SendSaleCapacitySource } from "./send-sale-capacity.js";
import { releaseSendSaleCapacity, reserveSendSaleCapacity } from "./send-sale-reservation.js";
import type { BillingStripe } from "./stripe.js";

type Plan = (typeof schema.planEnum.enumValues)[number];
type PlanStatus = (typeof schema.planStatusEnum.enumValues)[number];

export function idOf(ref: string | { id: string } | null | undefined): string | null {
  return typeof ref === "string" ? ref : (ref?.id ?? null);
}

function planStatusOf(status: Stripe.Subscription.Status): PlanStatus {
  const known = schema.planStatusEnum.enumValues as readonly string[];
  if (known.includes(status)) return status as PlanStatus;
  return status === "incomplete_expired" ? "incomplete" : "canceled";
}

const stamp = (seconds: number | null | undefined): Date | null => {
  if (!Number.isSafeInteger(seconds) || (seconds ?? 0) <= 0) return null;
  const date = new Date((seconds as number) * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
};

/**
 * Every writer of a team's billing columns takes this lock BEFORE fetching
 * the subscription from Stripe, so concurrent deliveries (or a reconcile
 * racing a webhook) can never apply a state older than one already applied.
 * Transaction-scoped: released on commit/rollback.
 */
export function lockCustomer(tx: Db, customerId: string): Promise<unknown> {
  return tx.execute(sql`select pg_advisory_xact_lock(hashtext(${customerId}))`);
}

/**
 * Applies a subscription fetched from Stripe to the team owning its customer.
 * Data we don't own (unknown customer, unknown price) is logged and
 * skipped; callers acknowledge such events so Stripe stops retrying them.
 * With a Stripe client at hand, a metered item priced for another rung
 * (the plan item moved without it) is re-pointed, best effort.
 */
export async function applySubscription(
  tx: Db,
  sub: Stripe.Subscription,
  log: (message: string) => void,
  stripe?: BillingStripe,
): Promise<void> {
  // Mail has its own entitlement. Exclude it before touching Send's billing schema.
  if (isMailboxSubscription(sub)) return;
  const customerId = idOf(sub.customer);
  const [team] = customerId
    ? await tx
        .select({
          id: schema.teams.id,
          plan: schema.teams.plan,
          planQuota: schema.teams.planQuota,
          stripeSubscriptionId: schema.teams.stripeSubscriptionId,
          stripeSubscriptionCreated: schema.teams.stripeSubscriptionCreated,
          stripeOverageItemId: schema.teams.stripeOverageItemId,
          sendBillingContract: schema.teams.sendBillingContract,
          currentPeriodStart: schema.teams.currentPeriodStart,
          currentPeriodEnd: schema.teams.currentPeriodEnd,
        })
        .from(schema.teams)
        .where(eq(schema.teams.stripeCustomerId, customerId))
    : [];
  if (!team) {
    log(`no team for customer ${customerId}`);
    return;
  }
  // The instance's own team is never billed; a Stripe customer pointing at
  // it is a misconfiguration, and Stripe's state must not overwrite the plan.
  if (team.plan === "system") {
    log(`team ${team.id} is on the system plan; subscription ${sub.id} ignored`);
    return;
  }

  // A customer's other products cannot replace Send's subscription or clear its terms.
  // Keep processing the already-linked subscription so legacy/unknown prices fail closed.
  if (team.stripeSubscriptionId !== sub.id && !rungFromSubscription(sub)) {
    log(`subscription ${sub.id} has no known plan price`);
    return;
  }

  if (!Number.isSafeInteger(sub.created) || sub.created <= 0) {
    log(`subscription ${sub.id} has no valid creation timestamp`);
    return;
  }
  let previousCreated = team.stripeSubscriptionCreated;
  if (
    team.stripeSubscriptionId &&
    team.stripeSubscriptionId !== sub.id &&
    previousCreated === null
  ) {
    // Pre-migration rows already have an authoritative subscription ID. Read its
    // immutable timestamp under the caller's customer lock before comparing events.
    if (!stripe) {
      log(`subscription ${sub.id} cannot replace an uninitialized linked subscription`);
      return;
    }
    const previous = await stripe.subscriptions.retrieve(team.stripeSubscriptionId, {
      expand: SUBSCRIPTION_EXPAND,
    });
    if (
      previous.id !== team.stripeSubscriptionId ||
      idOf(previous.customer) !== customerId ||
      previous.livemode !== sub.livemode ||
      isMailboxSubscription(previous) ||
      !Number.isSafeInteger(previous.created) ||
      previous.created <= 0
    ) {
      log(`linked subscription ${team.stripeSubscriptionId} has no verified creation timestamp`);
      return;
    }
    previousCreated = previous.created;
    await tx
      .update(schema.teams)
      .set({ stripeSubscriptionCreated: previousCreated })
      .where(eq(schema.teams.id, team.id));
  }
  if (
    team.stripeSubscriptionId === sub.id &&
    previousCreated !== null &&
    sub.created !== previousCreated
  ) {
    log(`subscription ${sub.id} creation timestamp changed`);
    return;
  }
  if (
    team.stripeSubscriptionId !== sub.id &&
    previousCreated !== null &&
    sub.created <= previousCreated
  )
    return;

  const entitled = sub.status === "active" || sub.status === "trialing";
  // A superseded subscription ending must not revoke what the team's
  // current subscription grants: events about different subscriptions
  // arrive in any order.
  if (!entitled && team.stripeSubscriptionId && team.stripeSubscriptionId !== sub.id) return;

  const { base, overage: existingOverage } = subscriptionItems(sub);
  // Paid by Pix (pix.ts: send_invoice, mepmail_collection=pix): an overdue invoice has no
  // card to retry, so past due is a lapsed plan, not the card's dunning grace.
  const pixLapsed =
    sub.status === "past_due" &&
    sub.collection_method === "send_invoice" &&
    sub.metadata?.mepmail_collection === "pix";
  const dunning = sub.status === "past_due" && !pixLapsed;
  const previousContract = verifiedSendBillingContract(team.sendBillingContract, {
    teamId: team.id,
    customerId: customerId as string,
    subscriptionId: team.stripeSubscriptionId,
    financialPeriodStart: team.currentPeriodStart,
    financialPeriodEnd: team.currentPeriodEnd,
  });
  if (
    dunning &&
    (base?.price.recurring?.interval === "year" || previousContract?.billingInterval === "year")
  ) {
    // Failed annual renewal must not mint another paid year from Stripe's
    // advanced invoice period. The previously paid window remains authoritative.
    await tx
      .update(schema.teams)
      .set({
        planStatus: "past_due",
        stripeSubscriptionCreated: sub.created,
        cancelAt: stamp(sub.cancel_at),
      })
      .where(eq(schema.teams.id, team.id));
    return;
  }
  let overage = existingOverage;
  let plan: Plan;
  let planQuota: number | null;
  let rung: PlanRung | null = null;
  let sendBillingContract = resolveSendBillingContract(sub, {
    teamId: team.id,
    customerId: customerId as string,
  });
  if (entitled) {
    rung = rungFromSubscription(sub);
    if (!rung || !sendBillingContract) {
      log(`subscription ${sub.id} has no known plan price`);
      // No quota metadata means no new entitlement. A pre-migration linked
      // contract keeps its stored quota; it does not acquire today's catalog terms.
      if (team.stripeSubscriptionId !== sub.id) return;
      if (previousContract?.billingInterval === "year") {
        // Keep the already verified paid annual window and its monthly usage
        // cycles. An unrecognized update cannot grant a renewal or new tariff.
        await tx
          .update(schema.teams)
          .set({
            planStatus: planStatusOf(sub.status),
            stripeSubscriptionCreated: sub.created,
            cancelAt: stamp(sub.cancel_at),
          })
          .where(eq(schema.teams.id, team.id));
        return;
      }
      await tx
        .update(schema.teams)
        .set({
          billingTerms: null,
          sendBillingContract: null,
          stripeSubscriptionId: sub.id,
          stripeSubscriptionCreated: sub.created,
        })
        .where(eq(schema.teams.id, team.id));
      return;
    }
    plan = rung.plan;
    planQuota = rung.period === "month" ? rung.included : null;
    // A monthly subscription from before the ladder has no metered item, so
    // its overage (on by default) would go unbilled; the first sync adds it.
    const catalog = rungByKey(rung.key as PlanRungKey);
    const baseTerms = base ? rungFromPrice(base.price) : null;
    const matchesCatalog =
      sendBillingContract.billingInterval === "month" &&
      base?.price.active === true &&
      baseTerms?.priceCents === catalog.priceCents &&
      baseTerms.included === catalog.included &&
      baseTerms.overageCentsPer1k === catalog.overageCentsPer1k;
  } else if (dunning) {
    plan = team.plan;
    planQuota = team.planQuota;
  } else {
    plan = "free";
    planQuota = null;
  }
  const overageItemId = entitled || dunning ? (overage?.id ?? null) : null;
  // The metered item is going (subscription ended, item removed elsewhere):
  // what it has not billed yet must reach the meter while the row still
  // names the item, inside Stripe's draft window for the closing period.
  if (stripe && team.stripeOverageItemId && overageItemId === null) {
    await reportOverage({ db: tx, stripe, log }, { teamId: team.id });
  }
  const effectiveItems = sub.items.data.map((item) =>
    overage && item.id === overage.id ? overage : item,
  );
  if (overage && !effectiveItems.some((item) => item.id === overage.id))
    effectiveItems.push(overage);
  const effectiveSubscription = { ...sub, items: { ...sub.items, data: effectiveItems } };
  const resolved = rungFromSubscription(effectiveSubscription);
  sendBillingContract = pixLapsed
    ? null
    : resolveSendBillingContract(effectiveSubscription, {
        teamId: team.id,
        customerId: customerId as string,
      });
  const included = Number(base?.price.metadata?.included_emails);
  const start = stamp(base?.current_period_start);
  const end = stamp(base?.current_period_end);
  const valid =
    (entitled || dunning) &&
    base &&
    overage &&
    effectiveItems.length === 2 &&
    sendBillingContract?.billingInterval === "month" &&
    base.quantity === 1 &&
    base.price.recurring?.interval === "month" &&
    (base.price.recurring.interval_count ?? 1) === 1 &&
    (overage.price.recurring?.interval_count ?? 1) === 1 &&
    Number.isSafeInteger(included) &&
    included > 0 &&
    included === planQuota &&
    resolved?.overageCentsPer1k !== null &&
    resolved?.overageCentsPer1k !== undefined &&
    start &&
    end &&
    start < end &&
    overage.current_period_start === base.current_period_start &&
    overage.current_period_end === base.current_period_end;
  const billingTerms: typeof schema.teams.$inferInsert.billingTerms =
    valid && overage
      ? {
          version: 1,
          teamId: team.id,
          customerId: customerId as string,
          subscriptionId: sub.id,
          baseItemId: base.id,
          basePriceId: base.price.id,
          overageItemId: overage.id,
          overagePriceId: overage.price.id,
          currency: "usd",
          centsPerBlock: resolved.overageCentsPer1k as number,
          blockSize: 1000,
          rounding: "up",
          included,
          periodStart: start.toISOString(),
          periodEnd: end.toISOString(),
          verifiedAt: new Date().toISOString(),
        }
      : null;
  await tx
    .update(schema.teams)
    .set({
      billingTerms,
      sendBillingContract,
      stripeSubscriptionCreated: Number.isSafeInteger(sub.created)
        ? sub.created
        : team.stripeSubscriptionCreated,
      plan,
      planQuota,
      planStatus: planStatusOf(sub.status),
      stripeSubscriptionId: sub.id,
      stripeOverageItemId: overageItemId,
      ...(sendBillingContract?.billingInterval === "year" ? { overageEnabled: false } : {}),
      pendingRung: entitled ? pendingRungOf(sub, rung) : null,
      currentPeriodStart: stamp(base?.current_period_start),
      currentPeriodEnd: stamp(base?.current_period_end),
      cancelAt: stamp(sub.cancel_at),
    })
    .where(eq(schema.teams.id, team.id));
  // Only persisted, exact provider state converts a promise to a contract. Pending
  // updates and transport completion alone keep their hold. No pool lock in this lifecycle.
  if (sendBillingContract && entitled && !sub.pending_update) {
    const id = sub.metadata?.mepmail_send_checkout;
    if (id) await releaseSendSaleCapacity(tx, team.id, id, "contract");
    const holds = await tx.execute<{ target: string }>(sql`select target from ${schema.auditLog}
      where team_id=${team.id} and action='sending.sale_reserved' and data->>'kind'='upgrade'
        and data->>'subscriptionId'=${sub.id} and data->>'rung'=${rung?.key ?? ""}`);
    const rows = Array.isArray(holds)
      ? holds
      : (holds as unknown as { rows: { target: string }[] }).rows;
    for (const hold of rows) await releaseSendSaleCapacity(tx, team.id, hold.target, "contract");
  }
  if (["canceled", "incomplete_expired"].includes(sub.status)) {
    const attemptId = sub.metadata?.mepmail_send_checkout;
    if (attemptId) {
      const [owned] = await tx
        .select()
        .from(schema.sendCheckoutAttempts)
        .where(
          and(
            eq(schema.sendCheckoutAttempts.id, attemptId),
            eq(schema.sendCheckoutAttempts.teamId, team.id),
          ),
        );
      if (owned?.stripeCustomerId === customerId && owned.livemode === sub.livemode)
        await releaseSendSaleCapacity(tx, team.id, attemptId, "expired");
    }
    const holds = await tx.execute<{ target: string }>(
      sql`select target from ${schema.auditLog} where team_id=${team.id} and action='sending.sale_reserved' and data->>'kind'='upgrade' and data->>'subscriptionId'=${sub.id}`,
    );
    const rows = Array.isArray(holds)
      ? holds
      : (holds as unknown as { rows: { target: string }[] }).rows;
    for (const hold of rows) await releaseSendSaleCapacity(tx, team.id, hold.target, "expired");
  }
}

async function loadBillingColumns(db: Db, teamId: string) {
  const [team] = await db
    .select({
      stripeCustomerId: schema.teams.stripeCustomerId,
      stripeSubscriptionId: schema.teams.stripeSubscriptionId,
    })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  return team ?? null;
}

/**
 * Re-derives the team's plan from Stripe's current state, for missed or
 * dropped webhooks. The newest recognized Send subscription is authoritative;
 * the already-linked one remains eligible even if its legacy price is unknown.
 * Other products on the same customer must never replace Send.
 */
export async function reconcileTeamPlan(deps: BillingDeps, teamId: string): Promise<void> {
  const team = await loadBillingColumns(deps.db, teamId);
  if (!team?.stripeCustomerId) return;
  const customerId = team.stripeCustomerId;

  // Retrieve carries the expansions (a list is nested beyond Stripe's depth limit).
  let startingAfter: string | undefined;
  for (;;) {
    const page = await deps.stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const listed of page.data) {
      if (isMailboxSubscription(listed)) continue;
      const sub = await deps.stripe.subscriptions.retrieve(listed.id, {
        expand: SUBSCRIPTION_EXPAND,
      });
      if (
        isMailboxSubscription(sub) ||
        idOf(sub.customer) !== customerId ||
        (sub.id !== team.stripeSubscriptionId && !rungFromSubscription(sub))
      )
        continue;
      await syncSubscription(deps, customerId, sub.id);
      return;
    }
    if (!page.has_more) return;
    const lastId = page.data.at(-1)?.id;
    if (!lastId || lastId === startingAfter)
      throw new Error("Stripe subscription pagination stalled");
    startingAfter = lastId;
  }
}

/** The team's live subscription, expanded for rung resolution; throws when it has none. */
async function liveSubscription(deps: BillingDeps, teamId: string) {
  const team = await loadBillingColumns(deps.db, teamId);
  if (!team?.stripeCustomerId || !team.stripeSubscriptionId) {
    throw new Error("team has no subscription");
  }
  const sub = await deps.stripe.subscriptions.retrieve(team.stripeSubscriptionId, {
    expand: SUBSCRIPTION_EXPAND,
  });
  return { customerId: team.stripeCustomerId, sub };
}

/** Bounded provider reads never extend a DB lease or projection lock. */
async function boundedRead<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Subscription read timed out")), 10000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const projectionKey = (team: typeof schema.teams.$inferSelect) =>
  JSON.stringify([
    team.stripeCustomerId,
    team.stripeSubscriptionId,
    team.stripeSubscriptionCreated,
    team.plan,
    team.planQuota,
    team.planStatus,
    team.billingTerms,
    team.sendBillingContract,
    team.currentPeriodStart,
    team.currentPeriodEnd,
  ]);
export async function prepareSubscription(
  deps: BillingDeps,
  customerId: string,
  subscriptionId: string,
) {
  const [team] = await deps.db
    .select()
    .from(schema.teams)
    .where(eq(schema.teams.stripeCustomerId, customerId));
  let sub = await boundedRead(
    deps.stripe.subscriptions.retrieve(subscriptionId, { expand: SUBSCRIPTION_EXPAND }),
  );
  if (sub.id !== subscriptionId || idOf(sub.customer) !== customerId)
    throw new Error("Subscription identity changed");
  const key = team ? projectionKey(team) : null;
  if (!team || isMailboxSubscription(sub)) return { sub, teamId: team?.id ?? null, key };
  const { base, overage } = subscriptionItems(sub);
  const rung = rungFromSubscription(sub);
  const catalog = rung ? rungByKey(rung.key as PlanRungKey) : null;
  const repair = !!(
    base &&
    rung &&
    catalog &&
    ["active", "trialing"].includes(sub.status) &&
    !sub.pending_update &&
    base.price.active &&
    base.price.recurring?.interval === "month" &&
    rung.priceCents === catalog.priceCents &&
    rung.included === catalog.included &&
    rungFromPrice(base.price)?.overageCentsPer1k === catalog.overageCentsPer1k &&
    (!overage || rungIdentityFromPrice(overage.price)?.key !== rung.key)
  );
  if (repair && rung && base) {
    if (team.stripeSubscriptionId !== sub.id)
      throw new Error("Repair requires the current subscription binding");
    const price = await resolvePriceId(deps.stripe, overageLookupKey(rung));
    const fresh = await boundedRead(
      deps.stripe.subscriptions.retrieve(sub.id, { expand: SUBSCRIPTION_EXPAND }),
    );
    const [binding] = await deps.db.select().from(schema.teams).where(eq(schema.teams.id, team.id));
    if (!binding || projectionKey(binding) !== key || JSON.stringify(fresh) !== JSON.stringify(sub))
      throw new Error("Repair source changed before POST");
    const operation = `send-meter-repair:${sub.id}:${base.id}:${base.price.id}:${overage?.id ?? "missing"}:${price}`;
    // No customer, team, pool or projection transaction spans either repair POST.
    if (overage)
      await (
        deps.stripe.subscriptionItems.update as (
          id: string,
          params: Stripe.SubscriptionItemUpdateParams,
          options: Stripe.RequestOptions,
        ) => Promise<Stripe.SubscriptionItem>
      )(overage.id, { price, proration_behavior: "none" }, { idempotencyKey: operation });
    else
      await (
        deps.stripe.subscriptionItems.create as (
          params: Stripe.SubscriptionItemCreateParams,
          options: Stripe.RequestOptions,
        ) => Promise<Stripe.SubscriptionItem>
      )({ subscription: sub.id, price }, { idempotencyKey: operation });
    const confirmed = await boundedRead(
      deps.stripe.subscriptions.retrieve(sub.id, { expand: SUBSCRIPTION_EXPAND }),
    );
    const items = subscriptionItems(confirmed);
    if (
      confirmed.id !== sub.id ||
      idOf(confirmed.customer) !== customerId ||
      confirmed.livemode !== sub.livemode ||
      confirmed.status !== sub.status ||
      confirmed.pending_update ||
      items.base?.id !== base.id ||
      items.base.price.id !== base.price.id ||
      items.base.current_period_start !== base.current_period_start ||
      items.base.current_period_end !== base.current_period_end ||
      items.overage?.price.id !== price ||
      (overage && items.overage.id !== overage.id)
    )
      throw new Error("Repair readback is ambiguous or stale");
    sub = confirmed;
  }
  return { sub, teamId: team.id, key };
}
export async function applyPreparedSubscription(
  tx: Db,
  prepared: Awaited<ReturnType<typeof prepareSubscription>>,
  log: (message: string) => void,
  stripe?: BillingStripe,
) {
  const customer = idOf(prepared.sub.customer);
  if (!customer) throw new Error("Missing subscription customer");
  await lockCustomer(tx, customer);
  if (prepared.teamId) {
    const [team] = await tx
      .select()
      .from(schema.teams)
      .where(eq(schema.teams.id, prepared.teamId))
      .for("update");
    if (!team || projectionKey(team) !== prepared.key)
      throw new Error("Projection changed after provider readback");
  }
  await applySubscription(tx, prepared.sub, log, stripe);
}
export async function syncSubscription(
  deps: BillingDeps,
  customerId: string,
  subscriptionId: string,
) {
  const prepared = await prepareSubscription(deps, customerId, subscriptionId);
  await deps.db.transaction((tx) =>
    applyPreparedSubscription(tx as unknown as Db, prepared, deps.log ?? console.warn, deps.stripe),
  );
}
async function applyLocked(deps: BillingDeps, customerId: string, subscriptionId: string) {
  await syncSubscription(deps, customerId, subscriptionId);
}

/** Drops a pending downgrade: the subscription keeps its current items. */
async function releaseSchedule(deps: BillingDeps, sub: Stripe.Subscription): Promise<void> {
  const id = idOf(sub.schedule);
  if (id) await deps.stripe.subscriptionSchedules.release(id);
}

/** The items a rung puts on a subscription: its plan price and, on a monthly rung, its metered price. */
async function rungItems(
  deps: BillingDeps,
  rung: PlanRung,
): Promise<{ price: string; quantity?: number }[]> {
  const base = await resolvePriceId(deps.stripe, rungLookupKey(rung));
  if (rung.period !== "month") return [{ price: base, quantity: 1 }];
  return [
    { price: base, quantity: 1 },
    { price: await resolvePriceId(deps.stripe, overageLookupKey(rung)) },
  ];
}

export type RungChange =
  | { applied: "now" }
  | { applied: "period_end"; at: Date }
  | { applied: "unscheduled" }
  /** The upgrade charge was not paid yet (declined or needs confirmation): plan unchanged. */
  | { applied: "payment_pending" };

/**
 * Moves a live subscription to another rung. Up (or across): the prorated
 * difference is charged at once and the new rung applies only when that charge
 * succeeds (otherwise Stripe keeps it as a pending update and the plan stays),
 * and any pending downgrade is dropped. Down: a
 * subscription schedule swaps the items when the current period ends, with
 * no proration, so the paid volume is kept to the day it was paid for; a
 * later move up releases the schedule. Choosing the current rung while a
 * downgrade is pending drops it. Stripe's customer portal cannot switch
 * plans on a subscription carrying more than one item, so this is the one
 * place plan changes happen; the webhook that follows re-applies the state.
 */
export async function changeRung(
  deps: BillingDeps & { capacitySource?: SendSaleCapacitySource },
  input: { teamId: string; rung: PlanRungKey; userId?: string },
): Promise<RungChange> {
  const rung = rungByKey(input.rung);
  if (rung.priceCents <= 0) throw new Error(`rung ${input.rung} is not for sale`);
  const { customerId, sub } = await liveSubscription(deps, input.teamId);
  // A Pix plan has no card for the proration charge: a new rung is a new purchase.
  if (isPixSubscription(sub)) throw new PixBillingError("unavailable");
  const { base, overage } = subscriptionItems(sub);
  if (!base) throw new Error(`subscription ${sub.id} has no plan item`);
  const current = rungFromPrice(base.price);
  if (!current) throw new Error(`subscription ${sub.id} has no known plan price`);
  if (base.price.recurring?.interval === "year") {
    throw new Error("Annual subscription changes require an explicit annual offer");
  }

  let result: RungChange;
  if (rung.key === current.key) {
    await releaseSchedule(deps, sub);
    result = { applied: "unscheduled" };
  } else if (rung.priceCents < current.priceCents) {
    const periodEnd = base.current_period_end;
    const scheduleId =
      idOf(sub.schedule) ??
      (await deps.stripe.subscriptionSchedules.create({ from_subscription: sub.id })).id;
    await deps.stripe.subscriptionSchedules.update(scheduleId, {
      end_behavior: "release",
      phases: [
        {
          items: sub.items.data.map((item) => ({
            price: item.price.id,
            ...(item.quantity ? { quantity: item.quantity } : {}),
          })),
          start_date: base.current_period_start,
          end_date: periodEnd,
          proration_behavior: "none",
        },
        {
          items: await rungItems(deps, rung),
          duration: { interval: "month", interval_count: 1 },
          proration_behavior: "none",
        },
      ],
    });
    result = { applied: "period_end", at: new Date(periodEnd * 1000) };
  } else {
    // Only an upgrade creates a new immediate charge. Persist any required
    // review outside the billing transaction, before schedule or meter effects.
    // Missing actors fail closed; non-purchase plan changes keep their old path.
    await requirePurchaseEligibility(deps.db, {
      teamId: input.teamId,
      userId: input.userId ?? "",
    });
    const capacity = await reserveSendSaleCapacity(
      deps.db,
      {
        teamId: input.teamId,
        userId: input.userId ?? "",
        rung: input.rung,
        kind: "upgrade",
        subscriptionId: sub.id,
      },
      deps.capacitySource,
    );
    // Sends made under the old rung settle at its rate before the move.
    if (overage) await reportOverage(deps, { teamId: input.teamId });
    const items: Stripe.SubscriptionUpdateParams.Item[] = [
      { id: base.id, price: await resolvePriceId(deps.stripe, rungLookupKey(rung)) },
    ];
    if (rung.period === "month") {
      const price = await resolvePriceId(deps.stripe, overageLookupKey(rung));
      items.push(overage ? { id: overage.id, price } : { price });
    } else if (overage) {
      items.push({ id: overage.id, deleted: true });
    }
    // Settle the old usage above before opening this transaction: its meter pin
    // must remain durable even if the subsequent price-change POST fails.
    let paymentPending = false;
    const fresh = await deps.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      await lockCustomer(tx, customerId);
      const [binding] = await tx
        .select({
          customerId: schema.teams.stripeCustomerId,
          subscriptionId: schema.teams.stripeSubscriptionId,
        })
        .from(schema.teams)
        .where(eq(schema.teams.id, input.teamId))
        .for("update");
      if (binding?.customerId !== customerId || binding.subscriptionId !== sub.id)
        throw new Error("Subscription binding changed before the plan update");
      const [member] = await tx
        .select({ role: schema.teamMembers.role })
        .from(schema.teamMembers)
        .where(
          and(
            eq(schema.teamMembers.teamId, input.teamId),
            eq(schema.teamMembers.userId, input.userId ?? ""),
          ),
        )
        .for("share");
      if (!member || !["owner", "admin"].includes(member.role))
        throw new PurchaseEligibilityError({
          eligible: false,
          code: "forbidden",
          domains: [],
          reviewReason: null,
        });
      const fresh = await deps.stripe.subscriptions.retrieve(sub.id, {
        expand: SUBSCRIPTION_EXPAND,
      });
      const { base: freshBase, overage: freshOverage } = subscriptionItems(fresh);
      if (
        fresh.id !== sub.id ||
        idOf(fresh.customer) !== customerId ||
        fresh.livemode !== sub.livemode ||
        fresh.status !== sub.status ||
        isMailboxSubscription(fresh) ||
        freshBase?.id !== base.id ||
        freshBase.price.id !== base.price.id ||
        freshBase.current_period_start !== base.current_period_start ||
        freshBase.current_period_end !== base.current_period_end ||
        freshOverage?.id !== overage?.id ||
        freshOverage?.price.id !== overage?.price.id
      )
        throw new Error("Subscription changed before the plan update");
      await assertPurchaseEligibility(tx, input.teamId);
      return fresh;
    });
    // Committed reservation and binding preflight precede every mutation; no customer/team lock spans POST.
    await releaseSchedule(deps, fresh);
    const updated = await deps.stripe.subscriptions.update(
      sub.id,
      {
        items,
        proration_behavior: "always_invoice",
        payment_behavior: "pending_if_incomplete",
      },
      { idempotencyKey: `send-upgrade:${capacity.id}` },
    );
    paymentPending = !!updated?.pending_update;
    const preparedProjection = await prepareSubscription(deps, customerId, sub.id);
    await deps.db.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      await lockCustomer(tx, customerId);
      const [binding] = await tx
        .select()
        .from(schema.teams)
        .where(eq(schema.teams.id, input.teamId))
        .for("update");
      if (binding?.stripeCustomerId !== customerId || binding.stripeSubscriptionId !== sub.id)
        throw new Error("Subscription binding changed after plan update");
      // What was accepted inside the old volume is never re-judged as overage
      // under the new one: the period row counts it as already settled.
      if (!paymentPending && rung.period === "month" && base.current_period_start) {
        const p = schema.usagePeriods;
        await tx
          .update(p)
          .set({
            reportedOverage: sql`greatest(${p.reportedOverage}, ${p.accepted} - ${rung.included})`,
          })
          .where(
            and(
              eq(p.teamId, input.teamId),
              eq(p.periodStart, new Date(base.current_period_start * 1000)),
            ),
          );
      }
      await applyPreparedSubscription(
        tx,
        preparedProjection,
        deps.log ?? console.warn,
        deps.stripe,
      );
    });
    return paymentPending ? { applied: "payment_pending" } : { applied: "now" };
  }
  await applyLocked(deps, customerId, sub.id);
  return result;
}

/**
 * The customer's overage switch. The metered item stays on the subscription
 * either way and bills only what the worker reports, so the switch is a row
 * flag: off reports what is still unreported first, so the usage reaches the
 * invoice, then stops the reporting. A subscription from before the ladder
 * has no metered item yet; on adds it once.
 */
export async function setOverage(
  deps: BillingDeps,
  input: { teamId: string; enabled: boolean },
): Promise<void> {
  const { customerId, sub } = await liveSubscription(deps, input.teamId);
  const { base, overage } = subscriptionItems(sub);
  const rung = base ? rungFromPrice(base.price) : null;
  if (rung?.period !== "month" || base?.price.recurring?.interval !== "month")
    throw new Error("overage applies to monthly plans only");
  if (input.enabled && !overage) {
    const catalog = rungByKey(rung.key as PlanRungKey);
    if (
      base?.price.active !== true ||
      rung.priceCents !== catalog.priceCents ||
      rung.included !== catalog.included ||
      rung.overageCentsPer1k !== catalog.overageCentsPer1k
    ) {
      throw new Error("Existing subscription requires explicit overage price review");
    }
    await deps.stripe.subscriptionItems.create({
      subscription: sub.id,
      price: await resolvePriceId(deps.stripe, overageLookupKey(rung)),
    });
    await applyLocked(deps, customerId, sub.id);
  }
  if (!input.enabled) await reportOverage(deps, { teamId: input.teamId });
  await deps.db
    .update(schema.teams)
    .set({ overageEnabled: input.enabled })
    .where(eq(schema.teams.id, input.teamId));
}

/** The renewal was asked to stop, but Stripe's current state still renews: nothing to confirm. */
export class RenewalCancelError extends Error {
  constructor() {
    super("renewal_not_cancelled");
    this.name = "RenewalCancelError";
  }
}

/** One cancel request: a UUID minted per request and reused only by that request's retries. */
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Stops the renewal of the team's Send subscription: it keeps the plan until the end of the
 * period already paid for and then ends (cancel_at_period_end), with no invoice, no refund and
 * no plan offered. Null without a live Send subscription.
 *
 * `operationId` names this one request. The Stripe idempotency key is built from it, so a retry
 * of the same request never applies twice, while a later cancel (after a reactivation on the
 * web, say) is a new operation that Stripe applies instead of replaying the first answer. And
 * success is read from Stripe's current subscription, never from the update's response, which
 * a replay would return unchanged.
 */
export async function cancelTeamRenewal(
  deps: BillingDeps,
  teamId: string,
  operationId: string,
): Promise<{ cancelAt: Date | null } | null> {
  if (!OPERATION_ID.test(operationId))
    throw new Error("cancelTeamRenewal: operationId must be a UUID");
  const team = await loadBillingColumns(deps.db, teamId);
  if (!team?.stripeSubscriptionId) return null;
  const sub = await deps.stripe.subscriptions.retrieve(team.stripeSubscriptionId, {
    expand: SUBSCRIPTION_EXPAND,
  });
  if (
    isMailboxSubscription(sub) ||
    sub.status === "canceled" ||
    sub.status === "incomplete_expired"
  )
    return null;
  if (!sub.cancel_at_period_end) {
    await deps.stripe.subscriptions.update(
      sub.id,
      { cancel_at_period_end: true },
      { idempotencyKey: `send-renewal-cancel:${sub.id}:${operationId}` },
    );
  }
  const current = await deps.stripe.subscriptions.retrieve(sub.id, {
    expand: SUBSCRIPTION_EXPAND,
  });
  if (current.cancel_at_period_end !== true) throw new RenewalCancelError();
  await reconcileTeamPlan(deps, teamId);
  const [row] = await deps.db
    .select({ cancelAt: schema.teams.cancelAt })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  return { cancelAt: row?.cancelAt ?? null };
}

/**
 * Cancels the team's subscription immediately (no final invoice) and clears
 * its plan; used when the team itself goes away. No-op without a live
 * subscription.
 */
export async function cancelTeamSubscription(deps: BillingDeps, teamId: string): Promise<void> {
  const team = await loadBillingColumns(deps.db, teamId);
  if (!team?.stripeSubscriptionId) return;
  const sub = await deps.stripe.subscriptions.retrieve(team.stripeSubscriptionId);
  if (sub.status !== "canceled" && sub.status !== "incomplete_expired") {
    await deps.stripe.subscriptions.cancel(sub.id, { invoice_now: false, prorate: false });
  }
  await deps.db
    .update(schema.teams)
    .set({
      plan: "free",
      planQuota: null,
      planStatus: "canceled",
      stripeSubscriptionId: null,
      billingTerms: null,
      sendBillingContract: null,
      stripeOverageItemId: null,
      overageEnabled: false,
      pendingRung: null,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      cancelAt: null,
    })
    .where(eq(schema.teams.id, teamId));
}
