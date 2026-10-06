import { DAY_MS, type SendOverageTerms, verifiedSendOverageTerms } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { BillingDeps } from "./checkout.js";
import { METER_EVENT_NAME } from "./prices.js";
import { lockCustomer } from "./subscription.js";

/** Stripe refuses meter events older than this; a row that stale is logged and left. */
const METER_MAX_AGE_MS = 35 * DAY_MS;

export interface OverageReport {
  reported: number;
  failed: number;
}

type PeriodKey = { teamId: string; periodStart: Date };
type Step = PeriodKey & { customerId: string; from: number; to: number; terms: SendOverageTerms };

/** Customer -> team -> period is also the subscription-change lock order. */
async function readLocked(db: Db, key: PeriodKey) {
  const [team] = await db
    .select()
    .from(schema.teams)
    .where(eq(schema.teams.id, key.teamId))
    .for("update");
  if (!team) return null;
  const [period] = await db
    .select()
    .from(schema.usagePeriods)
    .where(
      and(
        eq(schema.usagePeriods.teamId, key.teamId),
        eq(schema.usagePeriods.periodStart, key.periodStart),
      ),
    )
    .for("update");
  return period ? { team, period } : null;
}

function samePrices(a: SendOverageTerms, b: SendOverageTerms): boolean {
  return (
    a.baseItemId === b.baseItemId &&
    a.basePriceId === b.basePriceId &&
    a.overagePriceId === b.overagePriceId &&
    a.centsPerBlock === b.centsPerBlock &&
    a.included === b.included
  );
}

/** A historical row keeps its own terms, but must still name the actual current prices. */
function termsOf(
  row: NonNullable<Awaited<ReturnType<typeof readLocked>>>,
): SendOverageTerms | null {
  const { team, period } = row;
  if (!team.currentPeriodStart || !team.currentPeriodEnd) return null;
  const binding = {
    teamId: team.id,
    customerId: team.stripeCustomerId,
    subscriptionId: team.stripeSubscriptionId,
    overageItemId: team.stripeOverageItemId,
  };
  const current = verifiedSendOverageTerms(team.billingTerms, {
    ...binding,
    periodStart: team.currentPeriodStart,
    periodEnd: team.currentPeriodEnd,
  });
  // Accepted usage without a snapshot cannot be priced retroactively from today's terms.
  const historical = verifiedSendOverageTerms(period.billingTerms, {
    ...binding,
    periodStart: period.periodStart,
  });
  return current &&
    historical &&
    samePrices(current, historical) &&
    historical.periodEnd <= current.periodEnd
    ? historical
    : null;
}

function eventTime(terms: SendOverageTerms, now: Date): Date | null {
  const end = new Date(terms.periodEnd);
  const at = now >= end ? new Date(end.getTime() - 1000) : now;
  return Number.isFinite(at.getTime()) && now.getTime() - at.getTime() <= METER_MAX_AGE_MS
    ? at
    : null;
}

/**
 * The first transaction validates and commits a durable pendingOverage pin.
 * A second transaction takes the same Customer lock, rereads both price bindings,
 * and holds that lock through the provider call. Its local HTTP-error catch commits
 * without clearing the pin. A crash or failed commit after POST therefore retries
 * the same Stripe identifier rather than creating a new financial step.
 *
 * If invoked with an existing transaction (subscription removal), these are
 * savepoints: durability still depends on that caller's eventual outer commit.
 */
export async function reportOverage(
  deps: BillingDeps,
  opts: { now?: Date; teamId?: string } = {},
): Promise<OverageReport> {
  const now = opts.now ?? new Date();
  const log = deps.log ?? console.warn;
  const t = schema.teams;
  const p = schema.usagePeriods;
  // This is only discovery. Every financial field is read again under the Customer lock.
  const candidates = await deps.db
    .select({ teamId: t.id, customerId: t.stripeCustomerId, periodStart: p.periodStart })
    .from(p)
    .innerJoin(t, eq(t.id, p.teamId))
    .where(
      and(
        isNotNull(t.stripeOverageItemId),
        isNotNull(t.stripeCustomerId),
        opts.teamId ? eq(t.id, opts.teamId) : undefined,
      ),
    );
  let reported = 0;
  let failed = 0;
  for (const candidate of candidates) {
    if (!candidate.customerId) continue;
    try {
      const prepared = await deps.db.transaction(
        async (transaction): Promise<Step | "failed" | null> => {
          const tx = transaction as unknown as Db;
          await lockCustomer(tx, candidate.customerId as string);
          const row = await readLocked(tx, candidate);
          if (!row || row.team.plan === "system") return null;
          const terms = termsOf(row);
          if (!terms || row.team.stripeCustomerId !== candidate.customerId) {
            if (
              row.period.pendingOverage !== null ||
              row.period.accepted > (row.team.planQuota ?? 0)
            ) {
              log(
                `overage: team ${candidate.teamId} period ${candidate.periodStart.toISOString()} has no verified terms; preserved`,
              );
              return "failed";
            }
            return null;
          }
          const from = row.period.reportedOverage;
          const to = row.period.pendingOverage ?? row.period.accepted - terms.included;
          if (to <= from) return null;
          if (!eventTime(terms, now)) {
            log(
              `overage: team ${candidate.teamId} period ${candidate.periodStart.toISOString()} is outside the meter window`,
            );
            return "failed";
          }
          if (row.period.pendingOverage === null) {
            const pinned = await tx
              .update(p)
              .set({ pendingOverage: to })
              .where(
                and(
                  eq(p.teamId, candidate.teamId),
                  eq(p.periodStart, candidate.periodStart),
                  eq(p.reportedOverage, from),
                  isNull(p.pendingOverage),
                ),
              )
              .returning({ pendingOverage: p.pendingOverage });
            if (!pinned.length) return null;
          }
          return { ...candidate, customerId: candidate.customerId as string, from, to, terms };
        },
      );
      if (!prepared) continue;
      if (prepared === "failed") {
        failed += 1;
        continue;
      }
      const outcome = await deps.db.transaction(
        async (transaction): Promise<"reported" | "failed" | null> => {
          const tx = transaction as unknown as Db;
          await lockCustomer(tx, prepared.customerId);
          const row = await readLocked(tx, prepared);
          // Another reporter may already have finished this exact pinned step.
          if (row && row.period.reportedOverage !== prepared.from) return null;
          const terms = row ? termsOf(row) : null;
          const at = terms ? eventTime(terms, now) : null;
          if (
            !row ||
            row.team.plan === "system" ||
            row.team.stripeCustomerId !== prepared.customerId ||
            !terms ||
            !samePrices(terms, prepared.terms) ||
            terms.periodEnd !== prepared.terms.periodEnd ||
            row.period.pendingOverage !== prepared.to ||
            !at
          ) {
            log(
              `overage: team ${prepared.teamId} price binding changed before reporting; pin preserved`,
            );
            return "failed";
          }
          try {
            await deps.stripe.billing.meterEvents.create({
              event_name: METER_EVENT_NAME,
              identifier: `${prepared.teamId}:${prepared.periodStart.getTime()}:${prepared.from}:${prepared.to}`,
              timestamp: Math.floor(at.getTime() / 1000),
              payload: {
                stripe_customer_id: prepared.customerId,
                value: String(prepared.to - prepared.from),
              },
            });
          } catch (err) {
            log(`overage: team ${prepared.teamId} report failed: ${String(err)}`);
            return "failed";
          }
          await tx
            .update(p)
            .set({ reportedOverage: prepared.to, pendingOverage: null })
            .where(
              and(
                eq(p.teamId, prepared.teamId),
                eq(p.periodStart, prepared.periodStart),
                eq(p.reportedOverage, prepared.from),
                eq(p.pendingOverage, prepared.to),
              ),
            );
          return "reported";
        },
      );
      if (outcome === "reported") reported += 1;
      else if (outcome === "failed") failed += 1;
    } catch (err) {
      failed += 1;
      log(`overage: team ${candidate.teamId} report failed: ${String(err)}`);
    }
  }
  return { reported, failed };
}
