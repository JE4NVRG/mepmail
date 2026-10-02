import { type Db, schema } from "@millionsend/db";
import { and, asc, eq } from "drizzle-orm";
import type Stripe from "stripe";
import {
  isMailboxSubscription,
  mailboxCheckoutSessionMatches,
  recoverMailboxCheckoutSession,
  type MailboxBillingStripe,
  type MailboxCheckoutReadbackInput,
} from "./mailbox.js";
import type { BillingStripe } from "./stripe.js";
import { idOf, lockCustomer } from "./subscription.js";

/** Only the reads and cancellations needed for erasure. No Customer deletion or creation. */
export interface MailboxErasureStripe {
  subscriptions: Pick<BillingStripe["subscriptions"], "retrieve" | "list" | "cancel">;
  checkout: {
    sessions: {
      retrieve(id: string): Promise<Stripe.Checkout.Session>;
      list(
        params: Stripe.Checkout.SessionListParams,
      ): Promise<Stripe.ApiList<Stripe.Checkout.Session>>;
      expire(id: string): Promise<Stripe.Checkout.Session>;
    };
  };
}
export class MailboxErasureError extends Error {
  constructor(
    public readonly code: "forbidden" | "not_found" | "conflict" | "pending" | "unavailable",
  ) {
    super(code);
  }
}
export interface MailboxErasureDeps {
  db: Db;
  stripe?: MailboxErasureStripe | undefined;
  /** Lazy: an unlinked team without remote obligations needs no SDK instance. */
  getStripe?: (() => MailboxErasureStripe) | undefined;
  livemode?: boolean | undefined;
}
const TERMINAL_SUBSCRIPTIONS = new Set<Stripe.Subscription.Status>([
  "canceled",
  "incomplete_expired",
]);
const subscriptionId = (value: string | null) =>
  value !== null && /^sub_[A-Za-z0-9_]+$/.test(value);

async function read<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new MailboxErasureError("pending");
  }
}
function checkedSubscription(
  sub: Stripe.Subscription,
  id: string,
  customerId: string,
  livemode: boolean,
) {
  if (
    !subscriptionId(sub.id) ||
    sub.id !== id ||
    idOf(sub.customer) !== customerId ||
    sub.livemode !== livemode
  )
    throw new MailboxErasureError("conflict");
  return sub;
}
function checkedSession(session: Stripe.Checkout.Session, lease: MailboxCheckoutReadbackInput) {
  if (!mailboxCheckoutSessionMatches(session, lease)) throw new MailboxErasureError("conflict");
  return session;
}

/** Confirm that an owned URL cannot be completed. Expire may race a completion;
 * readback must then prove its terminal status, and a completed subscription is canceled below.
 */
async function closeSession(
  stripe: MailboxErasureStripe,
  session: Stripe.Checkout.Session,
  lease: MailboxCheckoutReadbackInput,
) {
  session = checkedSession(session, lease);
  if (session.status === "open") {
    const originalSessionId = session.id;
    try {
      session = await stripe.checkout.sessions.expire(originalSessionId);
    } catch {
      session = await read(() => stripe.checkout.sessions.retrieve(originalSessionId));
    }
    session = checkedSession(session, { ...lease, stripeSessionId: originalSessionId });
  }
  if (session.status !== "expired" && session.status !== "complete")
    throw new MailboxErasureError("pending");
  const linkedId = idOf(session.subscription);
  if ((linkedId && !subscriptionId(linkedId)) || (session.status === "complete" && !linkedId))
    throw new MailboxErasureError("pending");
  return { session, subscriptionId: linkedId };
}

/** Customer advisory -> team UPDATE -> current owner membership SHARE -> service/leases.
 * These locks cover all provider facts, the caller's existing Send cancellation, and DELETE.
 * The helper touches only Mail subscriptions. It never deletes the shared Customer or discovers
 * a team from provider metadata. Any ambiguous intent/failure preserves the team for retry.
 */
export async function withMailboxTeamErasure<T>(
  deps: MailboxErasureDeps,
  actor: { teamId: string; userId: string },
  callbacks: {
    cancelSend?: ((transaction: Db, teamId: string) => Promise<void>) | undefined;
    delete: (transaction: Db) => Promise<T>;
  },
): Promise<T> {
  deps = { ...deps };
  actor = { ...actor };
  callbacks = { ...callbacks };
  return deps.db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const [discovered] = await tx
      .select({ customerId: schema.teams.stripeCustomerId })
      .from(schema.teams)
      .where(eq(schema.teams.id, actor.teamId));
    if (!discovered) throw new MailboxErasureError("not_found");
    if (discovered.customerId) await lockCustomer(tx, discovered.customerId);
    const [team] = await tx
      .select({
        id: schema.teams.id,
        customerId: schema.teams.stripeCustomerId,
        sendSubscriptionId: schema.teams.stripeSubscriptionId,
      })
      .from(schema.teams)
      .where(eq(schema.teams.id, actor.teamId))
      .for("update");
    if (!team) throw new MailboxErasureError("not_found");
    // A linkage changed between discovery and the lock. Never fetch/cancel under the wrong lock.
    if (team.customerId !== discovered.customerId) throw new MailboxErasureError("conflict");
    const [member] = await tx
      .select({ role: schema.teamMembers.role })
      .from(schema.teamMembers)
      .where(
        and(eq(schema.teamMembers.teamId, team.id), eq(schema.teamMembers.userId, actor.userId)),
      )
      .for("share");
    if (member?.role !== "owner") throw new MailboxErasureError("forbidden");
    const [plan] = await tx
      .select()
      .from(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, team.id))
      .for("update");
    const leases = await tx
      .select()
      .from(schema.mailboxCheckouts)
      .where(eq(schema.mailboxCheckouts.teamId, team.id))
      .orderBy(asc(schema.mailboxCheckouts.id))
      .for("update");
    const [customerRequest] = await tx
      .select()
      .from(schema.mailboxCustomerRequests)
      .where(eq(schema.mailboxCustomerRequests.teamId, team.id))
      .for("update");
    if (customerRequest?.status === "creating") throw new MailboxErasureError("pending");
    if (
      customerRequest &&
      (customerRequest.stripeCustomerId !== team.customerId ||
        (deps.livemode !== undefined && customerRequest.livemode !== deps.livemode))
    )
      throw new MailboxErasureError("conflict");
    if (plan?.stripeCustomerId && plan.stripeCustomerId !== team.customerId)
      throw new MailboxErasureError("conflict");
    if (
      plan?.stripeSubscriptionId &&
      (!plan.stripeCustomerId || !subscriptionId(plan.stripeSubscriptionId))
    )
      throw new MailboxErasureError("conflict");
    if (plan?.livemode != null && deps.livemode !== undefined && plan.livemode !== deps.livemode)
      throw new MailboxErasureError("conflict");
    for (const lease of leases) {
      if (lease.stripeCustomerId !== team.customerId || lease.livemode !== deps.livemode)
        throw new MailboxErasureError("conflict");
    }
    const linkedMailIds = new Set<string>();
    if (plan?.stripeSubscriptionId) linkedMailIds.add(plan.stripeSubscriptionId);
    for (const lease of leases) {
      if (lease.stripeSubscriptionId) {
        if (!subscriptionId(lease.stripeSubscriptionId)) throw new MailboxErasureError("conflict");
        linkedMailIds.add(lease.stripeSubscriptionId);
      }
    }
    if (team.sendSubscriptionId && linkedMailIds.has(team.sendSubscriptionId))
      throw new MailboxErasureError("conflict");
    if (!team.customerId && (linkedMailIds.size || leases.length || customerRequest))
      throw new MailboxErasureError("pending");
    if (team.customerId) {
      if (!/^cus_[A-Za-z0-9_]+$/.test(team.customerId) || typeof deps.livemode !== "boolean")
        throw new MailboxErasureError("unavailable");
      let resolvedStripe: MailboxErasureStripe | undefined;
      try {
        resolvedStripe = deps.stripe ?? deps.getStripe?.();
      } catch {
        throw new MailboxErasureError("unavailable");
      }
      const stripe = resolvedStripe;
      if (!stripe) throw new MailboxErasureError("unavailable");
      const customerId = team.customerId;
      const livemode = deps.livemode;
      const checkoutFacts: Array<{
        id: string;
        sessionId: string;
        subscriptionId: string | null;
        status: "completed" | "expired";
      }> = [];
      for (const lease of leases) {
        // Prepared, unexposed intent has never crossed the durable creating marker.
        if (lease.status === "prepared" && !lease.stripeSessionId && !lease.checkoutUrl) continue;
        if (!lease.stripeSessionId && lease.status === "expired" && !lease.checkoutUrl) continue;
        if (
          !lease.stripeSessionId &&
          lease.status === "completed" &&
          lease.stripeSubscriptionId &&
          !lease.checkoutUrl
        )
          continue;
        const lookup: MailboxCheckoutReadbackInput = {
          teamId: team.id,
          stripeCustomerId: customerId,
          stripeSessionId: lease.stripeSessionId,
          idempotencyKey: lease.idempotencyKey,
          livemode,
        };
        // This shared helper returns null for none/multiple/mismatch/API ambiguity.
        const recovered = await recoverMailboxCheckoutSession(
          stripe as unknown as MailboxBillingStripe,
          lookup,
        );
        if (!recovered) throw new MailboxErasureError("pending");
        const closed = await closeSession(stripe, recovered, lookup);
        if (closed.subscriptionId) {
          if (closed.subscriptionId === team.sendSubscriptionId)
            throw new MailboxErasureError("conflict");
          linkedMailIds.add(closed.subscriptionId);
        }
        checkoutFacts.push({
          id: lease.id,
          sessionId: closed.session.id,
          subscriptionId: closed.subscriptionId ?? lease.stripeSubscriptionId,
          status: closed.session.status === "complete" ? "completed" : "expired",
        });
      }
      const subscriptions = new Map<string, Stripe.Subscription>();
      const fetchSubscription = async (id: string) =>
        checkedSubscription(
          await read(() =>
            stripe.subscriptions.retrieve(id, { expand: ["items.data.price.product"] }),
          ),
          id,
          customerId,
          livemode,
        );
      for (const id of linkedMailIds) subscriptions.set(id, await fetchSubscription(id));
      let startingAfter: string | undefined;
      const cursors = new Set<string>();
      for (;;) {
        const page = await read(() =>
          stripe.subscriptions.list({
            customer: customerId,
            status: "all",
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
          }),
        );
        if (!Array.isArray(page.data) || typeof page.has_more !== "boolean")
          throw new MailboxErasureError("pending");
        for (const listed of page.data) {
          checkedSubscription(listed, listed.id, customerId, livemode);
          if (listed.id === team.sendSubscriptionId || subscriptions.has(listed.id)) continue;
          // Product metadata requires an expanded authoritative read, not the list snapshot.
          const sub = await fetchSubscription(listed.id);
          if (isMailboxSubscription(sub)) subscriptions.set(sub.id, sub);
        }
        if (!page.has_more) break;
        const lastId = page.data.at(-1)?.id;
        if (!lastId || cursors.has(lastId)) throw new MailboxErasureError("pending");
        cursors.add(lastId);
        startingAfter = lastId;
      }
      // Discovery is complete before any subscription cancellation. Only validated Mail IDs enter.
      for (const id of [...subscriptions.keys()].sort()) {
        let sub = subscriptions.get(id)!;
        if (TERMINAL_SUBSCRIPTIONS.has(sub.status)) continue;
        sub = await fetchSubscription(id);
        if (!linkedMailIds.has(id) && !isMailboxSubscription(sub))
          throw new MailboxErasureError("conflict");
        if (!TERMINAL_SUBSCRIPTIONS.has(sub.status)) {
          try {
            sub = await stripe.subscriptions.cancel(id, { invoice_now: false, prorate: false });
          } catch {
            sub = await fetchSubscription(id);
          }
          checkedSubscription(sub, id, customerId, livemode);
          if (!TERMINAL_SUBSCRIPTIONS.has(sub.status)) throw new MailboxErasureError("pending");
        }
      }
      // Store only externally confirmed facts. If Send cancellation or DELETE fails, DB rolls back;
      // retries re-fetch already-expired/canceled objects without replaying their mutations.
      for (const fact of checkoutFacts)
        await tx
          .update(schema.mailboxCheckouts)
          .set({
            status: fact.status,
            stripeSessionId: fact.sessionId,
            stripeSubscriptionId: fact.subscriptionId,
            checkoutUrl: null,
            updatedAt: new Date(),
          })
          .where(eq(schema.mailboxCheckouts.id, fact.id));
      if (plan?.stripeSubscriptionId)
        await tx
          .update(schema.mailboxSubscriptions)
          .set({ status: "canceled", seats: 0, updatedAt: new Date() })
          .where(eq(schema.mailboxSubscriptions.teamId, team.id));
    }
    if (callbacks.cancelSend) await callbacks.cancelSend(tx, team.id);
    return callbacks.delete(tx);
  });
}
