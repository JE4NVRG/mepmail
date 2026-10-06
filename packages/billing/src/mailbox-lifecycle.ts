import { randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { mailboxManagementRequests } from "../../db/src/schema/mailbox-management-requests.js";
import {
  createMailboxCheckoutSession,
  isMailboxSubscription,
  MAILBOX_CUSTOMER_METADATA_KEY,
  type MailboxBillingStripe,
  type MailboxCatalog,
  type MailboxPriceTerms,
  mailboxCheckoutSessionMatches,
  mailboxCheckoutTerms,
  mailboxIncreasePaymentConfirmed,
  projectMailboxSubscription,
} from "./mailbox.js";
import { hasPaidSendingPlan } from "./mailbox-addon.js";
import type { BillingStripe } from "./stripe.js";
import { idOf, lockCustomer } from "./subscription.js";

export class MailboxLifecycleError extends Error {
  constructor(
    public readonly code:
      | "forbidden"
      | "not_found"
      | "invalid"
      | "unavailable"
      | "conflict"
      | "pending"
      | "expired"
      | "subscription_exists"
      | "sending_plan_required",
  ) {
    super(code);
  }
}

export type MailboxCheckoutLease = typeof schema.mailboxCheckouts.$inferSelect;
type MailboxSubscriptionRow = typeof schema.mailboxSubscriptions.$inferSelect;
const OPEN_CHECKOUTS = ["prepared", "creating", "ready"] as const;
const OCCUPIED_MAILBOX_PLANS = new Set(["active", "trialing", "past_due"]);
const OCCUPIED_SUBSCRIPTIONS = new Set([
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
]);
const epoch = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;

function historicalTerms(row: MailboxSubscriptionRow): MailboxPriceTerms | null {
  if (!row.stripePriceId || !row.currency || row.unitAmount === null || !row.interval) return null;
  return {
    priceId: row.stripePriceId,
    currency: row.currency,
    unitAmount: row.unitAmount,
    interval: row.interval,
    storageBytesPerMailbox: row.storageBytesPerMailbox,
    includedOutboundPerMailbox: row.includedOutboundPerMailbox,
  };
}
function leaseTerms(lease: MailboxCheckoutLease): MailboxPriceTerms {
  return {
    priceId: lease.stripePriceId,
    currency: lease.currency,
    unitAmount: lease.unitAmount,
    interval: lease.interval,
    storageBytesPerMailbox: lease.storageBytesPerMailbox,
    includedOutboundPerMailbox: lease.includedOutboundPerMailbox,
  };
}
function withHistoricalTerms(
  catalog: MailboxCatalog | null,
  terms: MailboxPriceTerms | null,
): MailboxCatalog | null {
  if (!catalog || !terms) return catalog;
  return {
    ...catalog,
    prices: [...catalog.prices.filter((p) => p.priceId !== terms.priceId), terms],
  };
}

export interface MailboxApplyResult {
  applied: boolean;
  teamId: string | null;
  reason:
    | "applied"
    | "revoked"
    | "unknown_customer"
    | "invalid_projection"
    | "stale_event"
    | "superseded"
    | "system_team";
}

/** Called only for verified lifecycle events with a subscription re-fetched under Customer lock.
 * A Db transaction can be passed directly; no Send terms or migration 0043 is referenced.
 */
export async function applyMailboxSubscription(
  db: Db,
  sub: Stripe.Subscription,
  catalog: MailboxCatalog | null,
  eventCreated: number,
  paymentInvoice?: Stripe.Invoice,
): Promise<MailboxApplyResult> {
  if (!epoch(eventCreated)) throw new MailboxLifecycleError("invalid");
  return applyMailboxProjection(db, sub, catalog, eventCreated, paymentInvoice);
}

/** Management readback keeps the existing webhook watermark; it cannot create a new grant. */
export async function reconcileExistingMailboxSubscription(
  db: Db,
  sub: Stripe.Subscription,
  catalog: MailboxCatalog | null,
  paymentInvoice?: Stripe.Invoice,
) {
  return applyMailboxProjection(db, sub, catalog, null, paymentInvoice);
}
export function mailboxSubscriptionCatalog(catalog: MailboxCatalog, row: MailboxSubscriptionRow) {
  return withHistoricalTerms(catalog, historicalTerms(row));
}
async function applyMailboxProjection(
  db: Db,
  sub: Stripe.Subscription,
  catalog: MailboxCatalog | null,
  eventCreated: number | null,
  paymentInvoice?: Stripe.Invoice,
): Promise<MailboxApplyResult> {
  const customerId = idOf(sub.customer);
  if (!customerId) return { applied: false, teamId: null, reason: "unknown_customer" };
  return db.transaction(async (tx): Promise<MailboxApplyResult> => {
    const transaction = tx as unknown as Db;
    await lockCustomer(transaction, customerId);
    const [team] = await tx
      .select({ id: schema.teams.id, plan: schema.teams.plan })
      .from(schema.teams)
      .where(eq(schema.teams.stripeCustomerId, customerId))
      .for("share");
    if (!team) return { applied: false, teamId: null, reason: "unknown_customer" };
    const result = (reason: MailboxApplyResult["reason"], applied = false): MailboxApplyResult => ({
      teamId: team.id,
      reason,
      applied,
    });
    if (team.plan === "system") return result("system_team");
    const [current] = await tx
      .select()
      .from(schema.mailboxSubscriptions)
      .where(eq(schema.mailboxSubscriptions.teamId, team.id))
      .for("update");
    if (eventCreated === null && (!current || current.stripeSubscriptionId !== sub.id))
      return result("invalid_projection");
    if (
      eventCreated !== null &&
      current?.lastEventCreated !== null &&
      current?.lastEventCreated !== undefined &&
      eventCreated < current.lastEventCreated
    )
      return result("stale_event");
    if (
      current?.stripeSubscriptionCreated !== null &&
      current?.stripeSubscriptionCreated !== undefined &&
      sub.id !== current.stripeSubscriptionId &&
      (!epoch(sub.created) ||
        sub.created < current.stripeSubscriptionCreated ||
        (sub.id !== current.stripeSubscriptionId &&
          sub.created === current.stripeSubscriptionCreated))
    )
      return result("superseded");
    const [lease] = catalog
      ? await tx
          .select()
          .from(schema.mailboxCheckouts)
          .where(
            and(
              eq(schema.mailboxCheckouts.teamId, team.id),
              eq(schema.mailboxCheckouts.stripeCustomerId, customerId),
              eq(schema.mailboxCheckouts.livemode, catalog.livemode),
              inArray(schema.mailboxCheckouts.status, [...OPEN_CHECKOUTS]),
            ),
          )
          .for("update")
      : [];
    const item = sub.items.data[0];
    const oldTerms =
      current?.stripeSubscriptionId === sub.id &&
      current.stripeCustomerId === customerId &&
      current.livemode === catalog?.livemode
        ? historicalTerms(current)
        : lease && item?.price.id === lease.stripePriceId && item.quantity === lease.seats
          ? leaseTerms(lease)
          : null;
    const creationMatches =
      !current ||
      current.stripeSubscriptionId !== sub.id ||
      current.stripeSubscriptionCreated === null ||
      current.stripeSubscriptionCreated === sub.created;
    const projection =
      epoch(sub.created) && creationMatches
        ? projectMailboxSubscription(sub, withHistoricalTerms(catalog, oldTerms), {
            teamId: team.id,
            customerId,
          })
        : null;
    if (!projection) {
      // An invalid other subscription must never revoke the valid current one.
      if (!current || current.stripeSubscriptionId !== sub.id) return result("invalid_projection");
      await tx
        .update(schema.mailboxSubscriptions)
        .set({
          status: "inactive",
          seats: 0,
          lastEventCreated: eventCreated ?? current.lastEventCreated,
          updatedAt: new Date(),
        })
        .where(eq(schema.mailboxSubscriptions.teamId, team.id));
      return result("revoked", true);
    }
    if (
      current &&
      current.stripeSubscriptionId !== sub.id &&
      OCCUPIED_MAILBOX_PLANS.has(current.status)
    )
      // An occupied internal grant has no Stripe subscription ID. Only an explicit
      // closure may release it; linking a Customer never hands its seats to Stripe.
      return result("superseded");
    const [increase] = current
      ? await tx
          .select()
          .from(mailboxManagementRequests)
          .where(
            and(
              eq(mailboxManagementRequests.teamId, team.id),
              eq(mailboxManagementRequests.stripeSubscriptionId, sub.id),
              eq(mailboxManagementRequests.action, "increase"),
              inArray(mailboxManagementRequests.status, ["creating", "pending"]),
            ),
          )
          .for("update")
      : [];
    const invoice =
      paymentInvoice ?? (typeof sub.latest_invoice === "object" ? sub.latest_invoice : null);
    const terminal = ["canceled", "incomplete_expired"].includes(sub.status);
    if (
      increase &&
      !sub.pending_update &&
      projection.seats === increase.seatsBefore &&
      invoice?.id === increase.stripeInvoiceId &&
      invoice.status === "void" &&
      idOf(invoice.customer) === customerId &&
      invoice.livemode === projection.livemode &&
      idOf(invoice.parent?.subscription_details?.subscription) === sub.id
    )
      await tx
        .update(mailboxManagementRequests)
        .set({ status: "expired", updatedAt: new Date() })
        .where(eq(mailboxManagementRequests.id, increase.id));
    if (
      !terminal &&
      current?.stripeSubscriptionId === sub.id &&
      current.seats > 0 &&
      projection.seats > current.seats &&
      !mailboxIncreasePaymentConfirmed(
        sub,
        {
          customerId,
          livemode: projection.livemode,
          previousInvoiceId: increase?.previousInvoiceId,
          invoiceId: increase?.stripeInvoiceId,
          seats: projection.seats,
          periodStart: increase?.periodStart ?? projection.periodStart,
          periodEnd: increase?.periodEnd ?? projection.periodEnd,
          prorationAt: increase?.createdAt,
        },
        paymentInvoice,
      )
    )
      return result("invalid_projection");
    const [reduction] = current
      ? await tx
          .select()
          .from(mailboxManagementRequests)
          .where(
            and(
              eq(mailboxManagementRequests.teamId, team.id),
              eq(mailboxManagementRequests.stripeSubscriptionId, sub.id),
              eq(mailboxManagementRequests.action, "decrease"),
              eq(mailboxManagementRequests.status, "scheduled"),
            ),
          )
          .for("update")
      : [];
    if (
      reduction &&
      ["active", "trialing"].includes(projection.status) &&
      projection.seats < current!.seats &&
      projection.periodStart < reduction.periodEnd
    )
      return result("invalid_projection");
    if (
      !terminal &&
      increase &&
      projection.seats === increase.seats &&
      mailboxIncreasePaymentConfirmed(
        sub,
        {
          customerId,
          livemode: projection.livemode,
          previousInvoiceId: increase.previousInvoiceId,
          invoiceId: increase.stripeInvoiceId,
          seats: increase.seats,
          periodStart: increase.periodStart,
          periodEnd: increase.periodEnd,
          prorationAt: increase.createdAt,
        },
        paymentInvoice,
      )
    )
      await tx
        .update(mailboxManagementRequests)
        .set({
          status: "confirmed",
          stripeInvoiceId: paymentInvoice?.id ?? idOf(sub.latest_invoice),
          updatedAt: new Date(),
        })
        .where(eq(mailboxManagementRequests.id, increase.id));
    await tx
      .update(mailboxManagementRequests)
      .set({ status: "confirmed", updatedAt: new Date() })
      .where(
        and(
          eq(mailboxManagementRequests.teamId, team.id),
          eq(mailboxManagementRequests.stripeSubscriptionId, sub.id),
          eq(mailboxManagementRequests.action, "decrease"),
          eq(mailboxManagementRequests.status, "scheduled"),
          eq(mailboxManagementRequests.seats, projection.seats),
          // Only a new period can fulfill a scheduled reduction.
          sql`${mailboxManagementRequests.periodEnd} <= ${projection.periodStart}`,
        ),
      );
    if (terminal)
      await tx
        .update(mailboxManagementRequests)
        .set({ status: "expired", updatedAt: new Date() })
        .where(
          and(
            eq(mailboxManagementRequests.teamId, team.id),
            eq(mailboxManagementRequests.stripeSubscriptionId, sub.id),
            eq(mailboxManagementRequests.stripeCustomerId, customerId),
            eq(mailboxManagementRequests.livemode, projection.livemode),
            inArray(mailboxManagementRequests.status, [
              "prepared",
              "creating",
              "pending",
              "scheduled",
            ]),
          ),
        );
    const next = {
      ...projection,
      lastEventCreated: eventCreated ?? current?.lastEventCreated ?? null,
      updatedAt: new Date(),
    };
    if (current) {
      await tx
        .update(schema.mailboxSubscriptions)
        .set(next)
        .where(eq(schema.mailboxSubscriptions.teamId, team.id));
    } else {
      const inserted = await tx
        .insert(schema.mailboxSubscriptions)
        .values(next)
        .onConflictDoNothing()
        .returning({ teamId: schema.mailboxSubscriptions.teamId });
      if (!inserted.length) throw new MailboxLifecycleError("conflict");
    }
    if (
      lease &&
      ["active", "trialing"].includes(projection.status) &&
      lease.stripePriceId === projection.stripePriceId &&
      lease.seats === projection.seats
    ) {
      await tx
        .update(schema.mailboxCheckouts)
        .set({ status: "completed", stripeSubscriptionId: sub.id, updatedAt: new Date() })
        .where(eq(schema.mailboxCheckouts.id, lease.id));
    }
    return result("applied", true);
  });
}

export interface MailboxPurchaseDeps {
  /** Hosted application policy; self-hosted/library callers retain their own catalog rules. */
  requirePaidSendingPlan?: boolean;
  db: Db;
  stripe: MailboxBillingStripe;
  /** Resolve an ambiguous attempt through provider readback. Null remains blocked, never expired by TTL. */
  recoverCheckout?: (lease: MailboxCheckoutLease) => Promise<Stripe.Checkout.Session | null>;
}
export interface BeginMailboxCheckoutInput {
  teamId: string;
  userId: string;
  seats: number;
  successUrl: string;
  cancelUrl: string;
  automaticTax?: boolean;
}
export interface BeginMailboxCheckoutResult {
  checkoutId: string;
  url: string;
}

async function currentAdmin(db: Db, input: Pick<BeginMailboxCheckoutInput, "teamId" | "userId">) {
  const [member] = await db
    .select({ role: schema.teamMembers.role })
    .from(schema.teamMembers)
    .where(
      and(eq(schema.teamMembers.teamId, input.teamId), eq(schema.teamMembers.userId, input.userId)),
    )
    .for("share");
  if (!member || !["owner", "admin"].includes(member.role))
    throw new MailboxLifecycleError("forbidden");
}

export interface MailboxCustomerRecoveryDeps {
  db: Db;
  stripe: MailboxBillingStripe;
  /** Trusted server configuration for the same Stripe client, never a caller-selected mode. */
  livemode: boolean;
}
export interface ResolveMailboxCustomerInput {
  teamId: string;
  userId: string;
  knownCustomerId: string;
}
export interface ResolveMailboxCustomerResult {
  resolved: true;
  duplicate: boolean;
}

/** Explicit server-only resolution of an ambiguous first-Customer request.
 * Reads the known Customer by ID and validates the saved nonce and complete snapshot.
 * Never creates/replays a request, searches by email, opens Checkout or grants entitlement.
 */
export async function resolveMailboxCustomer(
  deps: MailboxCustomerRecoveryDeps,
  input: ResolveMailboxCustomerInput,
): Promise<ResolveMailboxCustomerResult> {
  deps = { ...deps };
  input = { ...input };
  if (!/^cus_[A-Za-z0-9_]{1,251}$/.test(input.knownCustomerId))
    throw new MailboxLifecycleError("invalid");
  if (typeof deps.livemode !== "boolean") throw new MailboxLifecycleError("unavailable");
  return deps.db
    .transaction(async (transaction): Promise<ResolveMailboxCustomerResult> => {
      const tx = transaction as unknown as Db;
      // Same Customer -> team -> member order as billing writers, purchases and erasure.
      await lockCustomer(tx, input.knownCustomerId);
      const [team] = await tx
        .select({
          id: schema.teams.id,
          customerId: schema.teams.stripeCustomerId,
          plan: schema.teams.plan,
          suspendedAt: schema.teams.suspendedAt,
        })
        .from(schema.teams)
        .where(eq(schema.teams.id, input.teamId))
        .for("update");
      if (!team) throw new MailboxLifecycleError("not_found");
      await currentAdmin(tx, input);
      if (team.plan === "system" || team.suspendedAt) throw new MailboxLifecycleError("forbidden");
      const [request] = await tx
        .select()
        .from(schema.mailboxCustomerRequests)
        .where(eq(schema.mailboxCustomerRequests.teamId, team.id))
        .for("update");
      if (!request) throw new MailboxLifecycleError("not_found");
      if (
        request.livemode !== deps.livemode ||
        (request.stripeCustomerId && request.stripeCustomerId !== input.knownCustomerId) ||
        (team.customerId && team.customerId !== input.knownCustomerId) ||
        (request.status === "ready" &&
          (request.stripeCustomerId !== input.knownCustomerId ||
            team.customerId !== input.knownCustomerId))
      )
        throw new MailboxLifecycleError("conflict");
      const [bound] = await tx
        .select({ id: schema.teams.id })
        .from(schema.teams)
        .where(eq(schema.teams.stripeCustomerId, input.knownCustomerId));
      if (bound && bound.id !== team.id) throw new MailboxLifecycleError("conflict");
      if (!deps.stripe.customers.retrieve) throw new MailboxLifecycleError("pending");
      let customer: Stripe.Customer | Stripe.DeletedCustomer;
      try {
        customer = await deps.stripe.customers.retrieve(input.knownCustomerId);
      } catch {
        throw new MailboxLifecycleError("pending");
      }
      if (
        customer.deleted ||
        customer.id !== input.knownCustomerId ||
        customer.livemode !== request.livemode ||
        customer.metadata.team_id !== request.teamId ||
        customer.metadata[MAILBOX_CUSTOMER_METADATA_KEY] !== request.idempotencyKey ||
        customer.name !== request.name ||
        customer.email !== request.email
      )
        throw new MailboxLifecycleError("pending");
      if (request.status === "ready") return { resolved: true, duplicate: true };
      await tx
        .update(schema.teams)
        .set({ stripeCustomerId: customer.id })
        .where(eq(schema.teams.id, team.id));
      await tx
        .update(schema.mailboxCustomerRequests)
        .set({ status: "ready", stripeCustomerId: customer.id, updatedAt: new Date() })
        .where(eq(schema.mailboxCustomerRequests.teamId, team.id));
      return { resolved: true, duplicate: false };
    })
    .catch((error: unknown) => {
      if (error instanceof MailboxLifecycleError) throw error;
      // Readback or the local binding did not finish reliably; keep the original intent.
      throw new MailboxLifecycleError("pending");
    });
}

/** Creating a Customer does not grant a plan. Only the first durable request may call the provider.
 * A lost response or crash stays pending for explicit resolution; even an old key is never replayed.
 */
async function ensureMailboxCustomer(
  deps: MailboxPurchaseDeps,
  catalog: MailboxCatalog,
  input: BeginMailboxCheckoutInput,
): Promise<void> {
  const prepared = await deps.db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    const [discovered] = await tx
      .select({ customerId: schema.teams.stripeCustomerId })
      .from(schema.teams)
      .where(eq(schema.teams.id, input.teamId));
    if (!discovered) throw new MailboxLifecycleError("not_found");
    // Existing Customers follow purchaseTeam's Customer -> team -> member lock order.
    if (discovered.customerId) return null;
    const [team] = await tx
      .select({
        id: schema.teams.id,
        name: schema.teams.name,
        plan: schema.teams.plan,
        customerId: schema.teams.stripeCustomerId,
        suspendedAt: schema.teams.suspendedAt,
        planStatus: schema.teams.planStatus,
        stripeSubscriptionId: schema.teams.stripeSubscriptionId,
        currentPeriodStart: schema.teams.currentPeriodStart,
        currentPeriodEnd: schema.teams.currentPeriodEnd,
        cancelAt: schema.teams.cancelAt,
      })
      .from(schema.teams)
      .where(eq(schema.teams.id, input.teamId))
      .for("update");
    if (!team) throw new MailboxLifecycleError("not_found");
    if (team.customerId) return null;
    await currentAdmin(db, input);
    if (team.plan === "system" || team.suspendedAt) throw new MailboxLifecycleError("forbidden");
    if (
      deps.requirePaidSendingPlan &&
      !hasPaidSendingPlan({ ...team, stripeCustomerId: team.customerId })
    )
      throw new MailboxLifecycleError("sending_plan_required");
    await assertNoOccupiedMailboxPlan(db, team.id);
    const [existing] = await tx
      .select()
      .from(schema.mailboxCustomerRequests)
      .where(eq(schema.mailboxCustomerRequests.teamId, team.id))
      .for("update");
    if (existing) {
      if (existing.livemode !== catalog.livemode) throw new MailboxLifecycleError("conflict");
      // A prior attempt may have created a Customer even without a saved response.
      throw new MailboxLifecycleError("pending");
    }
    const [buyer] = await tx
      .select({ email: schema.user.email })
      .from(schema.user)
      .where(eq(schema.user.id, input.userId));
    if (!buyer?.email || !team.name) throw new MailboxLifecycleError("invalid");
    const [request] = await tx
      .insert(schema.mailboxCustomerRequests)
      .values({
        teamId: team.id,
        createdBy: input.userId,
        status: "creating",
        name: team.name,
        email: buyer.email,
        livemode: catalog.livemode,
        idempotencyKey: `mailbox-customer:${team.id}:${randomUUID()}`,
      })
      .returning();
    if (!request) throw new MailboxLifecycleError("conflict");
    return request;
  });
  if (!prepared) return;
  // The creating intent commits before the first provider call. No other caller can claim it.
  await deps.db
    .transaction(async (tx) => {
      const db = tx as unknown as Db;
      const [team] = await tx
        .select({
          plan: schema.teams.plan,
          customerId: schema.teams.stripeCustomerId,
          suspendedAt: schema.teams.suspendedAt,
          planStatus: schema.teams.planStatus,
          stripeSubscriptionId: schema.teams.stripeSubscriptionId,
          currentPeriodStart: schema.teams.currentPeriodStart,
          currentPeriodEnd: schema.teams.currentPeriodEnd,
          cancelAt: schema.teams.cancelAt,
        })
        .from(schema.teams)
        .where(eq(schema.teams.id, input.teamId))
        .for("update");
      if (!team) throw new MailboxLifecycleError("not_found");
      // A concurrent Send checkout may have linked first. Reuse it without acquiring a Customer lock
      // while holding this team lock; purchaseTeam acquires those locks later in the correct order.
      if (team.customerId) return;
      await currentAdmin(db, input);
      if (team.plan === "system" || team.suspendedAt) throw new MailboxLifecycleError("forbidden");
      if (
        deps.requirePaidSendingPlan &&
        !hasPaidSendingPlan({ ...team, stripeCustomerId: team.customerId })
      )
        throw new MailboxLifecycleError("sending_plan_required");
      // The first Customer intent committed before this transaction. A grant may
      // have arrived in that gap; preserve the intent and reject before the SDK call.
      await assertNoOccupiedMailboxPlan(db, input.teamId);
      const [request] = await tx
        .select()
        .from(schema.mailboxCustomerRequests)
        .where(eq(schema.mailboxCustomerRequests.teamId, input.teamId))
        .for("update");
      if (
        !request ||
        request.status !== "creating" ||
        request.idempotencyKey !== prepared.idempotencyKey ||
        request.livemode !== catalog.livemode
      )
        throw new MailboxLifecycleError("pending");
      let customer: Stripe.Customer;
      try {
        customer = await deps.stripe.customers.create(
          {
            name: request.name,
            email: request.email,
            metadata: {
              team_id: request.teamId,
              [MAILBOX_CUSTOMER_METADATA_KEY]: request.idempotencyKey,
            },
          },
          { idempotencyKey: request.idempotencyKey },
        );
      } catch {
        throw new MailboxLifecycleError("pending");
      }
      if (!/^cus_[A-Za-z0-9_]+$/.test(customer.id) || customer.livemode !== request.livemode)
        throw new MailboxLifecycleError("pending");
      // No existing binding exists here, so there is no Customer advisory lock to take after a row lock.
      // Only the Customer column changes; Send plan, quota and subscription stay untouched.
      await tx
        .update(schema.teams)
        .set({ stripeCustomerId: customer.id })
        .where(eq(schema.teams.id, input.teamId));
      await tx
        .update(schema.mailboxCustomerRequests)
        .set({ status: "ready", stripeCustomerId: customer.id, updatedAt: new Date() })
        .where(eq(schema.mailboxCustomerRequests.teamId, input.teamId));
    })
    .catch((error: unknown) => {
      if (error instanceof MailboxLifecycleError) throw error;
      // The provider may have succeeded even when linking or commit failed.
      throw new MailboxLifecycleError("pending");
    });
}
async function purchaseTeam(
  db: Db,
  input: BeginMailboxCheckoutInput,
  requirePaidSendingPlan = false,
) {
  // Discovery takes no row lock. Customer -> team -> membership -> service/lease
  // matches webhook writers and team deletion, avoiding an advisory/row lock cycle.
  const [discovered] = await db
    .select({ customerId: schema.teams.stripeCustomerId })
    .from(schema.teams)
    .where(eq(schema.teams.id, input.teamId));
  if (!discovered) throw new MailboxLifecycleError("not_found");
  if (!discovered.customerId) throw new MailboxLifecycleError("unavailable");
  await lockCustomer(db, discovered.customerId);
  const [team] = await db
    .select({
      id: schema.teams.id,
      plan: schema.teams.plan,
      customerId: schema.teams.stripeCustomerId,
      suspendedAt: schema.teams.suspendedAt,
      planStatus: schema.teams.planStatus,
      stripeSubscriptionId: schema.teams.stripeSubscriptionId,
      currentPeriodStart: schema.teams.currentPeriodStart,
      currentPeriodEnd: schema.teams.currentPeriodEnd,
      cancelAt: schema.teams.cancelAt,
    })
    .from(schema.teams)
    .where(eq(schema.teams.id, input.teamId))
    .for("share");
  if (!team) throw new MailboxLifecycleError("not_found");
  if (team.customerId !== discovered.customerId) throw new MailboxLifecycleError("conflict");
  await currentAdmin(db, input);
  if (team.plan === "system" || team.suspendedAt) throw new MailboxLifecycleError("forbidden");
  if (requirePaidSendingPlan && !hasPaidSendingPlan({ ...team, stripeCustomerId: team.customerId }))
    throw new MailboxLifecycleError("sending_plan_required");
  // Customer linkage is created by the authorized durable Customer flow, never team metadata.
  if (!team.customerId) throw new MailboxLifecycleError("unavailable");
  return { ...team, customerId: team.customerId };
}
async function assertNoSubscription(
  db: Db,
  stripe: BillingStripe,
  catalog: MailboxCatalog,
  teamId: string,
  customerId: string,
) {
  await assertNoOccupiedMailboxPlan(db, teamId);
  // A recovered complete Checkout does not grant access, but its known subscription
  // still prevents another purchase while the fulfillment webhook is outstanding.
  const [completed] = await db
    .select({ subscriptionId: schema.mailboxCheckouts.stripeSubscriptionId })
    .from(schema.mailboxCheckouts)
    .where(
      and(
        eq(schema.mailboxCheckouts.teamId, teamId),
        eq(schema.mailboxCheckouts.status, "completed"),
        isNotNull(schema.mailboxCheckouts.stripeSubscriptionId),
      ),
    )
    .orderBy(desc(schema.mailboxCheckouts.createdAt))
    .limit(1);
  if (completed?.subscriptionId) {
    const sub = await stripe.subscriptions.retrieve(completed.subscriptionId);
    if (idOf(sub.customer) !== customerId || sub.livemode !== catalog.livemode)
      throw new MailboxLifecycleError("unavailable");
    if (OCCUPIED_SUBSCRIPTIONS.has(sub.status))
      throw new MailboxLifecycleError("subscription_exists");
  }
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const sub of page.data) {
      if (idOf(sub.customer) !== customerId) continue;
      if (
        !isMailboxSubscription(sub) &&
        !sub.items.data.some((item) => catalog.prices.some((p) => p.priceId === item.price.id))
      )
        continue;
      if (sub.livemode !== catalog.livemode) throw new MailboxLifecycleError("unavailable");
      if (OCCUPIED_SUBSCRIPTIONS.has(sub.status))
        throw new MailboxLifecycleError("subscription_exists");
    }
    if (!page.has_more) return;
    const lastId = page.data.at(-1)?.id;
    if (!lastId || lastId === startingAfter) throw new MailboxLifecycleError("unavailable");
    startingAfter = lastId;
  }
}

/** Call after the team/current-member locks, before intents or provider calls.
 * Occupancy follows contract status, preserving the existing expired/grace rules.
 */
async function assertNoOccupiedMailboxPlan(db: Db, teamId: string) {
  const [plan] = await db
    .select({ status: schema.mailboxSubscriptions.status })
    .from(schema.mailboxSubscriptions)
    .where(eq(schema.mailboxSubscriptions.teamId, teamId))
    .for("update");
  if (plan && OCCUPIED_MAILBOX_PLANS.has(plan.status))
    throw new MailboxLifecycleError("subscription_exists");
}
function safeUrl(value: string, httpsOnly = false) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || (!httpsOnly && url.protocol === "http:")) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
function compatible(
  lease: MailboxCheckoutLease,
  catalog: MailboxCatalog,
  terms: MailboxPriceTerms,
  input: BeginMailboxCheckoutInput,
  customerId: string,
) {
  return (
    lease.stripeCustomerId === customerId &&
    lease.stripePriceId === terms.priceId &&
    lease.seats === input.seats &&
    lease.livemode === catalog.livemode &&
    lease.automaticTax === (input.automaticTax ?? false)
  );
}
async function purchase(
  deps: MailboxPurchaseDeps,
  catalog: MailboxCatalog,
  terms: MailboxPriceTerms,
  input: BeginMailboxCheckoutInput,
): Promise<BeginMailboxCheckoutResult> {
  const prepared = await deps.db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    const team = await purchaseTeam(db, input, deps.requirePaidSendingPlan);
    await assertNoSubscription(db, deps.stripe, catalog, team.id, team.customerId);
    const [existing] = await tx
      .select()
      .from(schema.mailboxCheckouts)
      .where(
        and(
          eq(schema.mailboxCheckouts.teamId, team.id),
          inArray(schema.mailboxCheckouts.status, [...OPEN_CHECKOUTS]),
        ),
      )
      .for("update");
    if (existing) {
      if (!compatible(existing, catalog, terms, input, team.customerId))
        throw new MailboxLifecycleError("conflict");
      if (existing.status !== "prepared") return { lease: existing, create: false };
      await tx
        .update(schema.mailboxCheckouts)
        .set({ status: "creating", updatedAt: new Date() })
        .where(eq(schema.mailboxCheckouts.id, existing.id));
      return { lease: { ...existing, status: "creating" as const }, create: true };
    }
    const id = randomUUID();
    const [lease] = await tx
      .insert(schema.mailboxCheckouts)
      .values({
        id,
        teamId: team.id,
        createdBy: input.userId,
        status: "creating",
        stripeCustomerId: team.customerId,
        stripePriceId: terms.priceId,
        seats: input.seats,
        livemode: catalog.livemode,
        idempotencyKey: `mailbox-checkout:${team.id}:${id}`,
        currency: terms.currency,
        unitAmount: terms.unitAmount,
        interval: terms.interval,
        storageBytesPerMailbox: terms.storageBytesPerMailbox,
        includedOutboundPerMailbox: terms.includedOutboundPerMailbox,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
        automaticTax: input.automaticTax ?? false,
      })
      .returning();
    if (!lease) throw new MailboxLifecycleError("conflict");
    return { lease, create: true };
  });
  // The durable 'creating' marker commits before any Checkout creation call.
  const outcome = await deps.db.transaction(
    async (tx): Promise<BeginMailboxCheckoutResult | { error: "expired" | "pending" }> => {
      const db = tx as unknown as Db;
      const team = await purchaseTeam(db, input, deps.requirePaidSendingPlan);
      await assertNoSubscription(db, deps.stripe, catalog, team.id, team.customerId);
      const [lease] = await tx
        .select()
        .from(schema.mailboxCheckouts)
        .where(eq(schema.mailboxCheckouts.id, prepared.lease.id))
        .for("update");
      if (!lease || !compatible(lease, catalog, terms, input, team.customerId))
        throw new MailboxLifecycleError("conflict");
      if (lease.status === "ready" && lease.checkoutUrl && !deps.recoverCheckout)
        return { checkoutId: lease.id, url: lease.checkoutUrl };
      if (!OPEN_CHECKOUTS.includes(lease.status as (typeof OPEN_CHECKOUTS)[number]))
        throw new MailboxLifecycleError("subscription_exists");
      let session: Stripe.Checkout.Session | null = null;
      if (prepared.create) {
        const recordingStripe: BillingStripe = {
          ...deps.stripe,
          checkout: {
            sessions: {
              create: async (params, options) => {
                const created = await deps.stripe.checkout.sessions.create(params, options);
                session = created;
                return created;
              },
            },
          },
        };
        await createMailboxCheckoutSession(
          recordingStripe,
          {
            livemode: lease.livemode,
            checkoutPriceId: lease.stripePriceId,
            prices: [leaseTerms(lease)],
          },
          {
            teamId: team.id,
            customerId: lease.stripeCustomerId,
            seats: lease.seats,
            successUrl: lease.successUrl,
            cancelUrl: lease.cancelUrl,
            idempotencyKey: lease.idempotencyKey,
            automaticTax: lease.automaticTax,
          },
        );
      } else if (deps.recoverCheckout) {
        session = await deps.recoverCheckout(lease);
      }
      const recovered = session as Stripe.Checkout.Session | null;
      if (!recovered || !mailboxCheckoutSessionMatches(recovered, lease))
        throw new MailboxLifecycleError("pending");
      if (recovered.status === "expired") {
        await tx
          .update(schema.mailboxCheckouts)
          .set({ status: "expired", stripeSessionId: recovered.id, updatedAt: new Date() })
          .where(eq(schema.mailboxCheckouts.id, lease.id));
        return { error: "expired" };
      }
      if (recovered.status === "complete") {
        const subscriptionId = idOf(recovered.subscription);
        if (!subscriptionId) throw new MailboxLifecycleError("pending");
        await tx
          .update(schema.mailboxCheckouts)
          .set({
            status: "completed",
            stripeSessionId: recovered.id,
            stripeSubscriptionId: subscriptionId,
            updatedAt: new Date(),
          })
          .where(eq(schema.mailboxCheckouts.id, lease.id));
        return { error: "pending" };
      }
      if (recovered.status !== "open" || !recovered.url || !safeUrl(recovered.url, true))
        throw new MailboxLifecycleError("pending");
      await tx
        .update(schema.mailboxCheckouts)
        .set({
          status: "ready",
          stripeSessionId: recovered.id,
          checkoutUrl: recovered.url,
          updatedAt: new Date(),
        })
        .where(eq(schema.mailboxCheckouts.id, lease.id));
      return { checkoutId: lease.id, url: recovered.url };
    },
  );
  if ("error" in outcome) throw new MailboxLifecycleError(outcome.error);
  return outcome;
}

export async function beginMailboxCheckout(
  deps: MailboxPurchaseDeps,
  catalog: MailboxCatalog | null,
  input: BeginMailboxCheckoutInput,
): Promise<BeginMailboxCheckoutResult> {
  const terms = mailboxCheckoutTerms(catalog);
  if (!catalog || !terms) throw new MailboxLifecycleError("unavailable");
  if (
    !Number.isSafeInteger(input.seats) ||
    input.seats < 1 ||
    input.seats > 10000 ||
    !safeUrl(input.successUrl) ||
    !safeUrl(input.cancelUrl)
  )
    throw new MailboxLifecycleError("invalid");
  await ensureMailboxCustomer(deps, catalog, input);
  return purchase(deps, catalog, terms, input);
}
