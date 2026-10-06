import { randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import {
  type MailboxLaunchCohort,
  mailboxLaunchCohortAllows,
} from "../../core/src/mailbox-launch-cohort.js";
import { mailboxManagementRequests as requests } from "../../db/src/schema/mailbox-management-requests.js";
import {
  type MailboxCatalog,
  mailboxIncreaseInvoiceMatches,
  mailboxIncreasePaymentConfirmed,
  projectMailboxSubscription,
} from "./mailbox.js";
import { hasPaidSendingPlanForMailbox } from "./mailbox-addon.js";
import {
  MailboxLifecycleError,
  mailboxSubscriptionCatalog,
  reconcileExistingMailboxSubscription,
} from "./mailbox-lifecycle.js";
import type { BillingStripe } from "./stripe.js";
import { idOf, lockCustomer } from "./subscription.js";

type Request = typeof requests.$inferSelect;
const OPEN = ["prepared", "creating", "pending"] as const;
const KEY = "mepmail_management_key";
export interface MailboxManagementDeps {
  db: Db;
  stripe: BillingStripe;
  now?: () => Date;
  /** Paused billing may reconcile provider evidence, but must not dispatch writes. */
  readOnly?: boolean;
  /** Hosted Envio contract prerequisite for increases/resume, never cancel/reduction. */
  requirePaidSendingPlan?: boolean;
  earlyAccessCohort?: MailboxLaunchCohort | null | undefined;
}
export interface MailboxManagementInput {
  teamId: string;
  userId: string;
  action: "cancel" | "resume" | "quantity" | "reconcile";
  seats?: number | undefined;
}
export interface MailboxManagementResult {
  status: "confirmed" | "scheduled" | "pending" | "expired";
  scheduledSeats: number | null;
  effectiveAt: Date | null;
  paymentUrl: string | null;
}
function increaseEvidence(row: Request) {
  return {
    customerId: row.stripeCustomerId,
    livemode: row.livemode,
    seats: row.seats,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    prorationAt: row.createdAt,
    previousInvoiceId: row.previousInvoiceId,
    invoiceId: row.stripeInvoiceId,
  };
}
function paymentUrl(sub: Stripe.Subscription, row: Request): string | null {
  const invoice = sub.latest_invoice;
  if (
    row.status !== "pending" ||
    row.action !== "increase" ||
    !invoice ||
    typeof invoice !== "object" ||
    invoice.status !== "open" ||
    invoice.id !== row.stripeInvoiceId ||
    idOf(invoice.customer) !== row.stripeCustomerId ||
    invoice.livemode !== row.livemode ||
    idOf(invoice.parent?.subscription_details?.subscription) !== row.stripeSubscriptionId ||
    !mailboxIncreaseInvoiceMatches(sub, increaseEvidence(row), invoice)
  )
    return null;
  try {
    const url = new URL(invoice.hosted_invoice_url ?? "");
    return url.protocol === "https:" &&
      url.hostname === "invoice.stripe.com" &&
      !url.username &&
      !url.password &&
      !url.port
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function phaseSettings(phase: Stripe.SubscriptionSchedule.Phase, row: Request, currency: string) {
  const empty = (v: unknown): boolean =>
    v == null ||
    v === false ||
    v === 0 ||
    v === "" ||
    (Array.isArray(v) ? v.length === 0 : typeof v === "object" && Object.values(v).every(empty));
  const allowed = new Set([
    "start_date",
    "end_date",
    "items",
    "proration_behavior",
    "currency",
    "metadata",
    "collection_method",
    "billing_cycle_anchor",
    "automatic_tax",
  ]);
  if (
    phase.start_date !== Math.floor(row.periodStart.getTime() / 1000) ||
    phase.end_date !== Math.floor(row.periodEnd.getTime() / 1000) ||
    (phase.currency && phase.currency !== currency) ||
    Object.entries(phase).some(([k, v]) => !allowed.has(k) && !empty(v)) ||
    phase.items.some((item) =>
      Object.entries(item).some(
        ([k, v]) => !["price", "plan", "quantity", "metadata"].includes(k) && !empty(v),
      ),
    ) ||
    (phase.automatic_tax && (phase.automatic_tax.enabled || !empty(phase.automatic_tax.liability)))
  )
    throw new MailboxLifecycleError("unavailable");
  return {
    ...(phase.metadata ? { metadata: { ...phase.metadata } } : {}),
    ...(phase.collection_method ? { collection_method: phase.collection_method } : {}),
    ...(phase.billing_cycle_anchor ? { billing_cycle_anchor: phase.billing_cycle_anchor } : {}),
    ...(phase.automatic_tax ? { automatic_tax: { enabled: false } } : {}),
    itemMetadata: phase.items[0]?.metadata ?? {},
  };
}
function result(row: Request, sub?: Stripe.Subscription): MailboxManagementResult {
  return {
    status:
      row.status === "scheduled" || row.status === "confirmed" || row.status === "expired"
        ? row.status
        : "pending",
    scheduledSeats: row.status === "scheduled" ? row.seats : null,
    effectiveAt: row.status === "scheduled" ? row.periodEnd : null,
    paymentUrl: sub ? paymentUrl(sub, row) : null,
  };
}

/** Customer -> team -> current membership -> Mail. Every provider stage rechecks authority. */
async function context(
  db: Db,
  deps: MailboxManagementDeps,
  catalog: MailboxCatalog,
  input: MailboxManagementInput,
) {
  const [discovered] = await db
    .select({ customer: schema.teams.stripeCustomerId })
    .from(schema.teams)
    .where(eq(schema.teams.id, input.teamId));
  if (!discovered?.customer) throw new MailboxLifecycleError("unavailable");
  await lockCustomer(db, discovered.customer);
  const [team] = await db
    .select()
    .from(schema.teams)
    .where(eq(schema.teams.id, input.teamId))
    .for("share");
  if (!team || team.stripeCustomerId !== discovered.customer)
    throw new MailboxLifecycleError("conflict");
  const [member] = await db
    .select({ role: schema.teamMembers.role })
    .from(schema.teamMembers)
    .where(
      and(eq(schema.teamMembers.teamId, input.teamId), eq(schema.teamMembers.userId, input.userId)),
    )
    .for("share");
  if (
    !member ||
    !["owner", "admin"].includes(member.role) ||
    team.suspendedAt ||
    team.plan === "system"
  )
    throw new MailboxLifecycleError("forbidden");
  const [plan] = await db
    .select()
    .from(schema.mailboxSubscriptions)
    .where(eq(schema.mailboxSubscriptions.teamId, input.teamId))
    .for("update");
  if (
    !plan?.stripeSubscriptionId ||
    plan.stripeCustomerId !== team.stripeCustomerId ||
    plan.livemode !== catalog.livemode ||
    !plan.stripeSubscriptionItemId ||
    !plan.stripePriceId
  )
    throw new MailboxLifecycleError("unavailable");
  const paidSendingPlanEligible =
    !deps.requirePaidSendingPlan ||
    hasPaidSendingPlanForMailbox(team, deps.earlyAccessCohort, deps.now?.());
  const earlyAccessEligible = mailboxLaunchCohortAllows(
    deps.earlyAccessCohort,
    { teamId: team.id, customerId: team.stripeCustomerId },
    deps.now?.(),
  );
  const sendingPlanEligible = paidSendingPlanEligible && earlyAccessEligible;
  const sub = await deps.stripe.subscriptions.retrieve(plan.stripeSubscriptionId, {
    expand: ["items.data.price.product", "latest_invoice", "schedule"],
  });
  const approved = mailboxSubscriptionCatalog(catalog, plan);
  const projection = projectMailboxSubscription(sub, approved, {
    teamId: team.id,
    customerId: discovered.customer,
  });
  if (
    !projection ||
    sub.id !== plan.stripeSubscriptionId ||
    projection.stripeSubscriptionItemId !== plan.stripeSubscriptionItemId ||
    projection.stripePriceId !== plan.stripePriceId ||
    projection.stripeSubscriptionCreated !== plan.stripeSubscriptionCreated
  )
    throw new MailboxLifecycleError("unavailable");
  if (
    !sendingPlanEligible &&
    (input.action === "resume" || (input.action === "quantity" && input.seats! > projection.seats))
  )
    throw new MailboxLifecycleError(
      paidSendingPlanEligible ? "early_access_required" : "sending_plan_required",
    );
  return { plan, sub, projection, approved, sendingPlanEligible };
}
function compatible(row: Request, c: Awaited<ReturnType<typeof context>>) {
  return (
    row.stripeSubscriptionId === c.sub.id &&
    row.stripeCustomerId === idOf(c.sub.customer) &&
    row.livemode === c.sub.livemode &&
    row.stripeSubscriptionItemId === c.projection.stripeSubscriptionItemId &&
    row.stripePriceId === c.projection.stripePriceId
  );
}
async function save(db: Db, row: Request, changes: Partial<Request>) {
  const [next] = await db
    .update(requests)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(requests.id, row.id))
    .returning();
  if (!next) throw new MailboxLifecycleError("conflict");
  return next;
}
function scheduleOwns(schedule: Stripe.SubscriptionSchedule, row: Request) {
  return (
    schedule.id === row.stripeScheduleId &&
    schedule.livemode === row.livemode &&
    idOf(schedule.customer) === row.stripeCustomerId &&
    idOf(schedule.subscription) === row.stripeSubscriptionId
  );
}
function scheduledMatches(schedule: Stripe.SubscriptionSchedule, row: Request) {
  const current = schedule.phases.find(
    (p) => p.start_date === Math.floor(row.periodStart.getTime() / 1000),
  );
  const future = schedule.phases.find(
    (p) => p.start_date === Math.floor(row.periodEnd.getTime() / 1000),
  );
  return (
    scheduleOwns(schedule, row) &&
    schedule.status === "active" &&
    schedule.phases.length === 2 &&
    schedule.metadata?.[KEY] === row.idempotencyKey &&
    schedule.end_behavior === "release" &&
    !!current &&
    current.end_date === Math.floor(row.periodEnd.getTime() / 1000) &&
    current.items.length === 1 &&
    idOf(current.items[0]!.price) === row.stripePriceId &&
    current.items[0]!.quantity === row.seatsBefore &&
    !!future &&
    future.items.length === 1 &&
    idOf(future.items[0]!.price) === row.stripePriceId &&
    future.items[0]!.quantity === row.seats &&
    future.proration_behavior === "none"
  );
}
async function ownedReduction(db: Db, c: Awaited<ReturnType<typeof context>>) {
  const scheduleId = idOf(c.sub.schedule);
  if (!scheduleId) return null;
  const [row] = await db
    .select()
    .from(requests)
    .where(
      and(
        eq(requests.stripeSubscriptionId, c.sub.id),
        eq(requests.stripeScheduleId, scheduleId),
        eq(requests.action, "decrease"),
        inArray(requests.status, ["scheduled", "confirmed"]),
      ),
    )
    .for("update");
  if (
    !row ||
    !c.sub.schedule ||
    typeof c.sub.schedule !== "object" ||
    !scheduledMatches(c.sub.schedule, row)
  )
    throw new MailboxLifecycleError("conflict");
  return row;
}
async function prepare(
  deps: MailboxManagementDeps,
  catalog: MailboxCatalog,
  input: MailboxManagementInput,
) {
  return deps.db.transaction(async (tx) => {
    const db = tx as unknown as Db,
      c = await context(db, deps, catalog, input);
    const [open] = await db
      .select()
      .from(requests)
      .where(and(eq(requests.teamId, input.teamId), inArray(requests.status, [...OPEN])))
      .for("update");
    if (open) {
      if (
        !compatible(open, c) ||
        (input.action !== "reconcile" &&
          (input.action === "quantity" ? open.seats !== input.seats : open.action !== input.action))
      )
        throw new MailboxLifecycleError("conflict");
      return { id: open.id, done: null };
    }
    await reconcileExistingMailboxSubscription(db, c.sub, c.approved);
    if (input.action === "reconcile") {
      const [last] = await db
        .select()
        .from(requests)
        .where(
          and(
            eq(requests.teamId, input.teamId),
            eq(requests.stripeSubscriptionId, c.sub.id),
            eq(requests.stripeCustomerId, c.projection.stripeCustomerId),
            eq(requests.livemode, c.projection.livemode),
          ),
        )
        .orderBy(desc(requests.createdAt))
        .limit(1);
      return {
        id: null,
        done: last
          ? result(last, c.sub)
          : {
              status: "confirmed" as const,
              scheduledSeats: null,
              effectiveAt: null,
              paymentUrl: null,
            },
      };
    }
    const now = (deps.now?.() ?? new Date()).getTime();
    if (
      !["active", "trialing", "past_due"].includes(c.sub.status) ||
      c.projection.periodEnd.getTime() <= now ||
      c.projection.periodStart.getTime() > now
    )
      throw new MailboxLifecycleError("expired");
    if (c.sub.pending_update) throw new MailboxLifecycleError("pending");
    const reduction = await ownedReduction(db, c);
    const action: Request["action"] =
      input.action === "quantity"
        ? input.seats! > c.projection.seats
          ? "increase"
          : "decrease"
        : input.action;
    if (
      input.action === "quantity" &&
      (c.sub.status !== "active" ||
        c.sub.cancel_at_period_end ||
        c.sub.collection_method !== "charge_automatically")
    )
      throw new MailboxLifecycleError("unavailable");
    if ((reduction || action === "decrease") && !deps.stripe.subscriptionSchedules.retrieve)
      throw new MailboxLifecycleError("unavailable");
    if (
      input.action === "quantity" &&
      (c.sub.discounts?.length || c.sub.default_tax_rates?.length || c.sub.automatic_tax?.enabled)
    )
      throw new MailboxLifecycleError("unavailable");
    if (
      (action === "cancel" && c.sub.cancel_at_period_end) ||
      (action === "resume" && !c.sub.cancel_at_period_end) ||
      (input.action === "quantity" && input.seats === c.projection.seats && !reduction)
    )
      return {
        id: null,
        done: {
          status: "confirmed" as const,
          scheduledSeats: null,
          effectiveAt: null,
          paymentUrl: null,
        },
      };
    if (action === "resume" && !["active", "trialing"].includes(c.sub.status))
      throw new MailboxLifecycleError("unavailable");
    if (c.sub.cancel_at && !c.sub.cancel_at_period_end) throw new MailboxLifecycleError("conflict");
    const id = randomUUID();
    const [row] = await db
      .insert(requests)
      .values({
        id,
        teamId: input.teamId,
        createdBy: input.userId,
        action,
        status: "prepared",
        step: reduction ? "release_schedule" : action === "decrease" ? "create_schedule" : "update",
        seatsBefore: c.projection.seats,
        seats: input.action === "quantity" ? input.seats! : c.projection.seats,
        periodStart: c.projection.periodStart,
        periodEnd: c.projection.periodEnd,
        stripeCustomerId: c.projection.stripeCustomerId,
        stripeSubscriptionId: c.sub.id,
        stripeSubscriptionItemId: c.projection.stripeSubscriptionItemId,
        stripePriceId: c.projection.stripePriceId,
        livemode: catalog.livemode,
        idempotencyKey: `mailbox-management:${input.teamId}:${id}`,
        previousInvoiceId: idOf(c.sub.latest_invoice),
        stripeScheduleId: reduction?.stripeScheduleId ?? null,
        createdAt: deps.now?.() ?? new Date(),
      })
      .returning();
    if (!row) throw new MailboxLifecycleError("conflict");
    return { id: row.id, done: null };
  });
}

/** Readback under the same lock decides completion. An unknown write never arms itself again. */
async function stage(
  deps: MailboxManagementDeps,
  catalog: MailboxCatalog,
  input: MailboxManagementInput,
  id: string,
) {
  const armed = await deps.db.transaction(async (tx) => {
    const db = tx as unknown as Db,
      c = await context(db, deps, catalog, input);
    const [row] = await db
      .select()
      .from(requests)
      .where(and(eq(requests.id, id), eq(requests.teamId, input.teamId)))
      .for("update");
    if (!row || !compatible(row, c)) throw new MailboxLifecycleError("conflict");
    if (row.status !== "prepared" || deps.readOnly) return false;
    if (!c.sendingPlanEligible && ["increase", "resume"].includes(row.action)) {
      // Only prepared proves no provider write was armed. Preserve its journal,
      // close the abandoned intent and allow cancellation/reduction to proceed.
      await save(db, row, { status: "expired" });
      return false;
    }
    await save(db, row, { status: "creating" }); // Commit before the provider call.
    return true;
  });
  return deps.db.transaction(async (tx) => {
    const db = tx as unknown as Db,
      c = await context(db, deps, catalog, input);
    let [row] = await db
      .select()
      .from(requests)
      .where(and(eq(requests.id, id), eq(requests.teamId, input.teamId)))
      .for("update");
    if (!row || !compatible(row, c)) throw new MailboxLifecycleError("conflict");
    if (![...OPEN].includes(row.status as (typeof OPEN)[number]))
      return { again: false, value: result(row, c.sub) };
    if (row.status === "prepared" && deps.readOnly)
      return { again: false, value: result(row, c.sub) };
    let sub = c.sub;
    if (["canceled", "incomplete_expired"].includes(sub.status)) {
      await reconcileExistingMailboxSubscription(db, sub, c.approved);
      row = await save(db, row, { status: "expired" });
      return { again: false, value: result(row, sub) };
    }
    const reread = () =>
      deps.stripe.subscriptions.retrieve(row!.stripeSubscriptionId, {
        expand: ["items.data.price.product", "latest_invoice", "schedule"],
      });
    try {
      if (armed) {
        if (!c.sendingPlanEligible && ["increase", "resume"].includes(row.action))
          throw new MailboxLifecycleError("sending_plan_required");
        if (
          c.projection.periodEnd.getTime() !== row.periodEnd.getTime() ||
          c.projection.seats !== row.seatsBefore ||
          row.periodEnd.getTime() <= (deps.now?.() ?? new Date()).getTime() ||
          sub.pending_update
        )
          throw new MailboxLifecycleError("conflict");
        const options = { idempotencyKey: `${row.idempotencyKey}:${row.step}` };
        if (row.step === "release_schedule") {
          if (!row.stripeScheduleId || idOf(sub.schedule) !== row.stripeScheduleId)
            throw new MailboxLifecycleError("conflict");
          await ownedReduction(db, c);
          await deps.stripe.subscriptionSchedules.release(row.stripeScheduleId, {}, options);
        } else if (row.step === "create_schedule") {
          if (sub.schedule) throw new MailboxLifecycleError("conflict");
          const schedule = await deps.stripe.subscriptionSchedules.create(
            { from_subscription: sub.id },
            options,
          );
          row = await save(db, row, { stripeScheduleId: schedule.id });
          if (!scheduleOwns(schedule, row)) throw new MailboxLifecycleError("pending");
        } else if (row.step === "configure_schedule") {
          if (!row.stripeScheduleId || idOf(sub.schedule) !== row.stripeScheduleId)
            throw new MailboxLifecycleError("conflict");
          if (!deps.stripe.subscriptionSchedules.retrieve)
            throw new MailboxLifecycleError("unavailable");
          const schedule = await deps.stripe.subscriptionSchedules.retrieve(row.stripeScheduleId);
          if (
            !scheduleOwns(schedule, row) ||
            schedule.phases.length !== 1 ||
            schedule.phases[0]!.items.length !== 1 ||
            idOf(schedule.phases[0]!.items[0]!.price) !== row.stripePriceId ||
            schedule.phases[0]!.items[0]!.quantity !== row.seatsBefore
          )
            throw new MailboxLifecycleError("conflict");
          const { itemMetadata, ...settings } = phaseSettings(
            schedule.phases[0]!,
            row,
            c.projection.currency,
          );
          await deps.stripe.subscriptionSchedules.update(
            row.stripeScheduleId,
            {
              end_behavior: "release",
              proration_behavior: "none",
              metadata: { [KEY]: row.idempotencyKey },
              phases: [
                {
                  ...settings,
                  start_date: Math.floor(row.periodStart.getTime() / 1000),
                  end_date: Math.floor(row.periodEnd.getTime() / 1000),
                  items: [
                    { price: row.stripePriceId, quantity: row.seatsBefore, metadata: itemMetadata },
                  ],
                  proration_behavior: "none",
                },
                {
                  ...settings,
                  start_date: Math.floor(row.periodEnd.getTime() / 1000),
                  duration: { interval: c.projection.interval, interval_count: 1 },
                  items: [
                    { price: row.stripePriceId, quantity: row.seats, metadata: itemMetadata },
                  ],
                  proration_behavior: "none",
                },
              ],
            },
            options,
          );
        } else {
          if (sub.schedule) throw new MailboxLifecycleError("conflict");
          if (row.action === "increase")
            await deps.stripe.subscriptions.update(
              sub.id,
              {
                items: [
                  {
                    id: row.stripeSubscriptionItemId,
                    price: row.stripePriceId,
                    quantity: row.seats,
                  },
                ],
                payment_behavior: "pending_if_incomplete",
                proration_behavior: "always_invoice",
                proration_date: Math.floor(row.createdAt.getTime() / 1000),
              },
              options,
            );
          else
            await deps.stripe.subscriptions.update(
              sub.id,
              { cancel_at_period_end: row.action === "cancel", proration_behavior: "none" },
              options,
            );
        }
      }
      sub = await reread();
      const projection = projectMailboxSubscription(sub, c.approved, {
        teamId: input.teamId,
        customerId: row.stripeCustomerId,
      });
      if (
        !projection ||
        sub.id !== row.stripeSubscriptionId ||
        projection.stripeSubscriptionItemId !== row.stripeSubscriptionItemId ||
        projection.stripePriceId !== row.stripePriceId
      )
        throw new MailboxLifecycleError("pending");
      if (["canceled", "incomplete_expired"].includes(sub.status)) {
        await reconcileExistingMailboxSubscription(db, sub, c.approved);
        row = await save(db, row, { status: "expired" });
      } else if (row.step === "release_schedule" && !sub.schedule) {
        await db
          .update(requests)
          .set({ status: "expired", updatedAt: new Date() })
          .where(
            and(
              eq(requests.stripeScheduleId, row.stripeScheduleId!),
              eq(requests.status, "scheduled"),
            ),
          );
        const nextStep =
          row.action === "decrease" && row.seats !== row.seatsBefore ? "create_schedule" : "update";
        if (row.action === "decrease" && row.seats === row.seatsBefore)
          row = await save(db, row, { status: "confirmed", stripeScheduleId: null });
        else
          row = await save(db, row, { status: "prepared", step: nextStep, stripeScheduleId: null });
      } else if (
        row.step === "create_schedule" &&
        row.stripeScheduleId &&
        idOf(sub.schedule) === row.stripeScheduleId
      ) {
        row = await save(db, row, { status: "prepared", step: "configure_schedule" });
      } else if (
        row.step === "configure_schedule" &&
        typeof sub.schedule === "object" &&
        sub.schedule &&
        scheduledMatches(sub.schedule, row)
      ) {
        row = await save(db, row, { status: "scheduled" });
      } else if (row.step === "update" && row.action === "increase") {
        let invoice = sub.latest_invoice;
        if (
          !row.stripeInvoiceId &&
          invoice &&
          typeof invoice === "object" &&
          mailboxIncreaseInvoiceMatches(sub, increaseEvidence(row), invoice)
        )
          row = await save(db, row, { stripeInvoiceId: invoice.id });
        if (row.stripeInvoiceId && idOf(invoice) !== row.stripeInvoiceId && deps.stripe.invoices)
          invoice = await deps.stripe.invoices.retrieve(row.stripeInvoiceId);
        if (
          projection.seats === row.seats &&
          mailboxIncreasePaymentConfirmed(sub, increaseEvidence(row), invoice)
        ) {
          await reconcileExistingMailboxSubscription(
            db,
            sub,
            c.approved,
            typeof invoice === "object" && invoice ? invoice : undefined,
          );
          row = await save(db, row, { status: "confirmed" });
        } else if (
          !sub.pending_update &&
          projection.seats === row.seatsBefore &&
          invoice &&
          typeof invoice === "object" &&
          invoice.id === row.stripeInvoiceId &&
          invoice.status === "void" &&
          idOf(invoice.customer) === row.stripeCustomerId &&
          invoice.livemode === row.livemode &&
          idOf(invoice.parent?.subscription_details?.subscription) === row.stripeSubscriptionId
        )
          row = await save(db, row, { status: "expired" });
        else row = await save(db, row, { status: "pending" });
      } else if (
        row.step === "update" &&
        ["cancel", "resume"].includes(row.action) &&
        sub.cancel_at_period_end === (row.action === "cancel")
      ) {
        await reconcileExistingMailboxSubscription(db, sub, c.approved);
        row = await save(db, row, { status: "confirmed" });
      } else row = await save(db, row, { status: "pending" });
    } catch {
      // A committed creating marker remains pending even when the response/readback is lost.
      row = await save(db, row, { status: "pending" });
    }
    return {
      again:
        !deps.readOnly &&
        row.status === "prepared" &&
        (c.sendingPlanEligible || !["increase", "resume"].includes(row.action)),
      value: result(row, sub),
    };
  });
}

export async function manageMailboxSubscription(
  deps: MailboxManagementDeps,
  catalog: MailboxCatalog | null,
  input: MailboxManagementInput,
): Promise<MailboxManagementResult> {
  if (!catalog) throw new MailboxLifecycleError("unavailable");
  if (deps.readOnly && input.action !== "reconcile") throw new MailboxLifecycleError("unavailable");
  if (
    input.action === "quantity" &&
    (!Number.isSafeInteger(input.seats) || input.seats! < 1 || input.seats! > 10000)
  )
    throw new MailboxLifecycleError("invalid");
  const prepared = await prepare(deps, catalog, input);
  if (prepared.done) return prepared.done;
  if (!prepared.id) throw new MailboxLifecycleError("conflict");
  for (let i = 0; i < 4; i++) {
    const step = await stage(deps, catalog, input, prepared.id);
    if (!step.again) return step.value;
  }
  throw new MailboxLifecycleError("pending");
}
