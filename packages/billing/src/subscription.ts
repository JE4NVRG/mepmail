import { type PlanRung, type PlanRungKey, rungByKey } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import type { BillingDeps } from "./checkout.js";
import { isMailboxSubscription } from "./mailbox.js";
import { reportOverage } from "./overage.js";
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
import { resolveSendBillingContract, verifiedSendBillingContract } from "./send-contract.js";
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
  const previousContract = verifiedSendBillingContract(team.sendBillingContract, {
    teamId: team.id,
    customerId: customerId as string,
    subscriptionId: team.stripeSubscriptionId,
    financialPeriodStart: team.currentPeriodStart,
    financialPeriodEnd: team.currentPeriodEnd,
  });
  if (
    sub.status === "past_due" &&
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
    if (stripe && !overage && rung.period === "month" && matchesCatalog) {
      try {
        const price = await resolvePriceId(stripe, overageLookupKey(rung));
        overage = await stripe.subscriptionItems.create({ subscription: sub.id, price });
      } catch (err) {
        log(`overage item not added to ${sub.id}: ${String(err)}`);
      }
    }
    if (stripe && overage && rung.period === "month" && matchesCatalog) {
      const expected = overageLookupKey(rung);
      if (rungIdentityFromPrice(overage.price)?.key !== rung.key) {
        try {
          const price = await resolvePriceId(stripe, expected);
          overage = await stripe.subscriptionItems.update(overage.id, {
            price,
            proration_behavior: "none",
          });
        } catch (err) {
          log(`overage item ${overage.id} not re-pointed to ${expected}: ${String(err)}`);
        }
      }
    }
  } else if (sub.status === "past_due") {
    plan = team.plan;
    planQuota = team.planQuota;
  } else {
    plan = "free";
    planQuota = null;
  }
  const overageItemId = entitled || sub.status === "past_due" ? (overage?.id ?? null) : null;
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
  sendBillingContract = resolveSendBillingContract(effectiveSubscription, {
    teamId: team.id,
    customerId: customerId as string,
  });
  const included = Number(base?.price.metadata?.included_emails);
  const start = stamp(base?.current_period_start);
  const end = stamp(base?.current_period_end);
  const valid =
    (entitled || sub.status === "past_due") &&
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
  await deps.db.transaction(async (tx) => {
    await lockCustomer(tx as unknown as Db, customerId);
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
        await applySubscription(tx as unknown as Db, sub, deps.log ?? console.warn, deps.stripe);
        return;
      }
      if (!page.has_more) return;
      const lastId = page.data.at(-1)?.id;
      if (!lastId || lastId === startingAfter)
        throw new Error("Stripe subscription pagination stalled");
      startingAfter = lastId;
    }
  });
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

/** Lock first, then read Stripe: the row never receives a state older than one already applied. */
async function applyLocked(deps: BillingDeps, customerId: string, subscriptionId: string) {
  await deps.db.transaction(async (tx) => {
    await lockCustomer(tx as unknown as Db, customerId);
    const sub = await deps.stripe.subscriptions.retrieve(subscriptionId, {
      expand: SUBSCRIPTION_EXPAND,
    });
    await applySubscription(tx as unknown as Db, sub, deps.log ?? console.warn, deps.stripe);
  });
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
  | { applied: "unscheduled" };

/**
 * Moves a live subscription to another rung. Up (or across): at once, with
 * prorations on the next invoice, and any pending downgrade dropped. Down: a
 * subscription schedule swaps the items when the current period ends, with
 * no proration, so the paid volume is kept to the day it was paid for; a
 * later move up releases the schedule. Choosing the current rung while a
 * downgrade is pending drops it. Stripe's customer portal cannot switch
 * plans on a subscription carrying more than one item, so this is the one
 * place plan changes happen; the webhook that follows re-applies the state.
 */
export async function changeRung(
  deps: BillingDeps,
  input: { teamId: string; rung: PlanRungKey },
): Promise<RungChange> {
  const rung = rungByKey(input.rung);
  if (rung.priceCents <= 0) throw new Error(`rung ${input.rung} is not for sale`);
  const { customerId, sub } = await liveSubscription(deps, input.teamId);
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
    await releaseSchedule(deps, sub);
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
    await deps.db.transaction(async (transaction) => {
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
      // Internal subscription mutations and meter emission now share this lock.
      // A manual change made directly in Stripe remains outside the app's lock.
      await deps.stripe.subscriptions.update(sub.id, {
        items,
        proration_behavior: "create_prorations",
      });
      // What was accepted inside the old volume is never re-judged as overage
      // under the new one: the period row counts it as already settled.
      if (rung.period === "month" && base.current_period_start) {
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
      const confirmed = await deps.stripe.subscriptions.retrieve(sub.id, {
        expand: SUBSCRIPTION_EXPAND,
      });
      await applySubscription(tx, confirmed, deps.log ?? console.warn, deps.stripe);
    });
    return { applied: "now" };
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
