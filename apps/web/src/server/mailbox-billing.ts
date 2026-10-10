import { createHash } from "node:crypto";
import {
  isLiveKey,
  isStandaloneMailboxPrice,
  type MailboxCatalog,
  MailboxLifecycleError,
  type MailboxPriceTerms,
  type MailboxPurchaseDeps,
  recoverMailboxCheckoutSession,
} from "@millionsend/billing";
import { env, isCloudDeployment } from "@millionsend/config";
import { type Db, schema } from "@millionsend/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { mailboxIncludedSeats } from "../../../../packages/billing/src/mailbox";
import { hasPaidSendingPlanForMailbox } from "../../../../packages/billing/src/mailbox-addon";
import { mailboxTrialDays } from "../../../../packages/billing/src/mailbox-trial-eligibility";
import {
  mailboxLaunchCohortAllows,
  mailboxLaunchCohortOpen,
} from "../../../../packages/core/src/mailbox-launch-cohort";
import { mailboxManagementRequests } from "../../../../packages/db/src/schema/mailbox-management-requests";
import { getStripe } from "./billing";
import { mailboxEarlyAccessCohort, mailboxStandaloneOpen } from "./mailboxes";
import { newSubscriptionsPaused } from "./new-subscriptions";

const terms = z
  .object({
    priceId: z.string().regex(/^price_[A-Za-z0-9_]+$/),
    currency: z.string().regex(/^[a-z]{3}$/),
    unitAmount: z.number().int().positive().max(2147483647),
    interval: z.enum(["month", "year"]),
    storageBytesPerMailbox: z.number().int().min(1).max(10995116277760),
    includedOutboundPerMailbox: z.number().int().min(0).max(1000000),
    quotaScope: z.enum(["mailbox", "team"]).optional(),
    includedMailboxes: z.number().int().min(1).max(10000).optional(),
    extraUnitAmount: z.number().int().positive().max(2147483647).optional(),
    trialDays: z.number().int().min(0).max(30).optional(),
    localCurrency: z
      .object({
        currency: z.string().regex(/^[a-z]{3}$/),
        unitAmount: z.number().int().positive().max(2147483647),
        extraUnitAmount: z.number().int().positive().max(2147483647).optional(),
      })
      .strict()
      .optional(),
    planCode: z.enum(["solo", "duo", "equipe"]).optional(),
    inboundDeliveriesPerPeriod: z.number().int().min(0).max(10000000).optional(),
    inboundBytesPerPeriod: z.number().int().min(0).max(10995116277760).optional(),
    outboundBytesPerPeriod: z.number().int().min(0).max(10995116277760).optional(),
  })
  .strict();
/** Operator-controlled catalog; an absent value cannot create or price a purchase.
 * Historical price entries remain while contracts reference them.
 */
export function mailboxBillingCatalog(): MailboxCatalog | null {
  let raw: unknown;
  try {
    raw = JSON.parse(process.env.MAILBOX_BILLING_CATALOG ?? "null");
  } catch {
    return null;
  }
  const parsed = z
    .object({
      livemode: z.boolean(),
      checkoutPriceId: z.string().nullable(),
      checkoutPriceIds: z
        .array(z.string().regex(/^price_[A-Za-z0-9_]+$/))
        .max(10)
        .optional(),
      standalonePriceIds: z
        .array(z.string().regex(/^price_[A-Za-z0-9_]+$/))
        .max(10)
        .optional(),
      prices: z.array(terms).max(100),
    })
    .strict()
    .safeParse(raw);
  const standalone = parsed.success ? (parsed.data.standalonePriceIds ?? []) : [];
  if (
    !parsed.success ||
    new Set(standalone).size !== standalone.length ||
    standalone.some(
      (id) =>
        !parsed.data.prices.some((p) => p.priceId === id) ||
        (parsed.data.checkoutPriceIds ?? []).includes(id) ||
        parsed.data.checkoutPriceId === id,
    ) ||
    parsed.data.livemode !== isLiveKey(env.STRIPE_SECRET_KEY ?? "") ||
    new Set(parsed.data.prices.map((p) => p.priceId)).size !== parsed.data.prices.length ||
    (parsed.data.checkoutPriceIds !== undefined &&
      (new Set(parsed.data.checkoutPriceIds).size !== parsed.data.checkoutPriceIds.length ||
        parsed.data.checkoutPriceIds.some(
          (id) => !parsed.data.prices.some((p) => p.priceId === id),
        ) ||
        (parsed.data.checkoutPriceId !== null &&
          !parsed.data.checkoutPriceIds.includes(parsed.data.checkoutPriceId))))
  )
    return null;
  return parsed.data;
}

/** Pause new Mail purchases and financial changes without hiding persisted contracts.
 * An explicitly configured Mail flag must be a known false value to permit writes.
 * Keep the existing global billing pause semantics.
 */
export function mailboxBillingMutationsPaused() {
  const mailboxPause = process.env.MAILBOX_BILLING_PAUSED;
  return (
    ["1", "true"].includes(process.env.BILLING_MUTATIONS_PAUSED ?? "") ||
    (mailboxPause !== undefined && !["0", "false"].includes(mailboxPause))
  );
}

function purchasesAvailable() {
  return (
    isCloudDeployment() &&
    /^(sk|rk)_(test|live)_\S+$/.test(env.STRIPE_SECRET_KEY ?? "") &&
    !mailboxBillingMutationsPaused()
  );
}

/**
 * Who a purchase is for: teams with a paid Envio contract buy the add-on
 * prices; everyone else, only the standalone ones (when that offer is open).
 */
export type MailboxAudience = "with_sending" | "standalone";

function purchasableTerms(
  catalog: MailboxCatalog | null,
  audience: MailboxAudience | "any" = "with_sending",
) {
  if (!catalog) return [];
  const addOn =
    catalog.checkoutPriceIds ?? (catalog.checkoutPriceId ? [catalog.checkoutPriceId] : []);
  const standalone = mailboxStandaloneOpen() ? (catalog.standalonePriceIds ?? []) : [];
  // The Correio plans sell to everyone; a team with paid Envio also keeps the
  // per-mailbox add-ons. Other standalone prices (pre-plan) sell only without Envio.
  const plans = standalone.filter((id) =>
    catalog.prices.some((p) => p.priceId === id && p.planCode),
  );
  const ids =
    audience === "with_sending"
      ? [...plans, ...addOn]
      : audience === "standalone"
        ? standalone
        : [...addOn, ...standalone];
  return ids.flatMap((id) => {
    const price = catalog.prices.find((p) => p.priceId === id);
    return price ? [price] : [];
  });
}

function publicTerms(price: MailboxPriceTerms) {
  return {
    currency: price.currency,
    unitAmount: price.unitAmount,
    interval: price.interval,
    storageBytesPerMailbox: price.storageBytesPerMailbox,
    includedOutboundPerMailbox: price.includedOutboundPerMailbox,
    /** "team": the storage and outbound figures are shared by all the team's mailboxes. */
    quotaScope: price.quotaScope ?? ("mailbox" as const),
    /** Mailboxes unitAmount covers; every one above them costs extraUnitAmount. */
    includedMailboxes: mailboxIncludedSeats(price),
    extraUnitAmount: price.extraUnitAmount ?? null,
    /** Display only: Stripe Checkout picks the currency it charges. */
    localCurrency: price.localCurrency
      ? {
          currency: price.localCurrency.currency,
          unitAmount: price.localCurrency.unitAmount,
          extraUnitAmount: price.localCurrency.extraUnitAmount ?? null,
        }
      : null,
    /** A Correio plan: fixed mailboxes and team-wide allowances per billing period. */
    plan: price.planCode
      ? {
          code: price.planCode,
          inboundDeliveriesPerPeriod: price.inboundDeliveriesPerPeriod ?? 0,
          inboundBytesPerPeriod: price.inboundBytesPerPeriod ?? 0,
          outboundBytesPerPeriod: price.outboundBytesPerPeriod ?? 0,
        }
      : null,
  };
}

function publicOffer(catalog: MailboxCatalog, price: MailboxPriceTerms) {
  // A pre-plan offer hashes without the plan field, so its id stays what it was.
  const { plan, ...shape } = publicTerms(price);
  const offerId = `mbo_${createHash("sha256")
    .update(JSON.stringify([catalog.livemode, price.priceId, plan ? { ...shape, plan } : shape]))
    .digest("base64url")}`;
  // The trial a first purchase of this price carries; the presentation zeroes it
  // for a team that is not eligible. Not part of the offer id.
  return { offerId, ...publicTerms(price), trialDays: price.trialDays ?? 0 };
}

/** Provider IDs and historical-only terms never become client-selectable offers. */
export function mailboxBillingOffers(audience: MailboxAudience = "with_sending") {
  if (!purchasesAvailable()) return [];
  const catalog = mailboxBillingCatalog();
  return catalog
    ? purchasableTerms(catalog, audience).map((price) => publicOffer(catalog, price))
    : [];
}

/** Resolve only a server-approved offer; client amounts, prices and limits are never inputs. */
export function mailboxBillingCatalogForOffer(
  offerId?: string,
  audience: MailboxAudience = "with_sending",
): MailboxCatalog | null {
  if (!purchasesAvailable()) return null;
  const catalog = mailboxBillingCatalog();
  if (!catalog) return null;
  if (offerId !== undefined && !/^mbo_[A-Za-z0-9_-]{43}$/.test(offerId)) return null;
  const choices = purchasableTerms(catalog, audience);
  const price = choices.find((entry) =>
    offerId !== undefined
      ? publicOffer(catalog, entry).offerId === offerId
      : audience === "with_sending"
        ? entry.priceId === catalog.checkoutPriceId
        : entry === choices[0],
  );
  return price ? { ...catalog, checkoutPriceId: price.priceId } : null;
}

/** Preserve the legacy default DTO without granting a purchase or exposing its provider ID. */
export function mailboxBillingOffer() {
  const catalog = mailboxBillingCatalogForOffer();
  const price = catalog?.prices.find((entry) => entry.priceId === catalog.checkoutPriceId);
  return price ? publicTerms(price) : null;
}

export function mailboxManagementEnabled() {
  return (
    ["1", "true"].includes(process.env.MAILBOX_BILLING_MANAGEMENT_ENABLED ?? "") &&
    isCloudDeployment() &&
    /^(sk|rk)_(test|live)_\S+$/.test(env.STRIPE_SECRET_KEY ?? "") &&
    !["1", "true"].includes(process.env.BILLING_MUTATIONS_PAUSED ?? "")
  );
}

/** Read-only presentation, rechecking membership rather than trusting a cached session role. */
export async function mailboxBillingPresentation(
  db: Db,
  actor: { teamId: string; userId: string },
) {
  const [member] = await db
    .select({
      role: schema.teamMembers.role,
      id: schema.teams.id,
      sendBillingContract: schema.teams.sendBillingContract,
      suspendedAt: schema.teams.suspendedAt,
      plan: schema.teams.plan,
      planStatus: schema.teams.planStatus,
      stripeCustomerId: schema.teams.stripeCustomerId,
      stripeSubscriptionId: schema.teams.stripeSubscriptionId,
      currentPeriodStart: schema.teams.currentPeriodStart,
      currentPeriodEnd: schema.teams.currentPeriodEnd,
      cancelAt: schema.teams.cancelAt,
    })
    .from(schema.teamMembers)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
    .where(
      and(eq(schema.teamMembers.teamId, actor.teamId), eq(schema.teamMembers.userId, actor.userId)),
    );
  if (!member) throw new MailboxLifecycleError("forbidden");
  const canManage = member.role === "owner" || member.role === "admin";
  const cohort = mailboxEarlyAccessCohort();
  const paidSending = hasPaidSendingPlanForMailbox(member, cohort);
  // Without Envio the team buys the standalone offer, when it is open.
  const audience: MailboxAudience = paidSending ? "with_sending" : "standalone";
  const standaloneOffers = paidSending ? [] : mailboxBillingOffers("standalone");
  const sendingPlanRequired =
    member.plan !== "system" && !paidSending && standaloneOffers.length === 0;
  const earlyAccessRequired =
    member.plan !== "system" &&
    !(audience === "standalone" && standaloneOffers.length > 0
      ? mailboxLaunchCohortOpen(cohort)
      : mailboxLaunchCohortAllows(cohort, {
          teamId: member.id,
          customerId: member.stripeCustomerId,
        }));
  const [subscription] = await db
    .select()
    .from(schema.mailboxSubscriptions)
    .where(eq(schema.mailboxSubscriptions.teamId, actor.teamId));
  const [completedCheckout] = await db
    .select({
      status: schema.mailboxCheckouts.status,
      subscriptionId: schema.mailboxCheckouts.stripeSubscriptionId,
    })
    .from(schema.mailboxCheckouts)
    .where(
      and(
        eq(schema.mailboxCheckouts.teamId, actor.teamId),
        eq(schema.mailboxCheckouts.status, "completed"),
      ),
    )
    .orderBy(desc(schema.mailboxCheckouts.createdAt))
    .limit(1);
  const [checkout] = await db
    .select({
      seats: schema.mailboxCheckouts.seats,
      priceId: schema.mailboxCheckouts.stripePriceId,
      livemode: schema.mailboxCheckouts.livemode,
      currency: schema.mailboxCheckouts.currency,
      unitAmount: schema.mailboxCheckouts.unitAmount,
      interval: schema.mailboxCheckouts.interval,
      storageBytesPerMailbox: schema.mailboxCheckouts.storageBytesPerMailbox,
      includedOutboundPerMailbox: schema.mailboxCheckouts.includedOutboundPerMailbox,
    })
    .from(schema.mailboxCheckouts)
    .where(
      and(
        eq(schema.mailboxCheckouts.teamId, actor.teamId),
        inArray(schema.mailboxCheckouts.status, ["prepared", "creating", "ready"]),
      ),
    );
  const [customerRequest] = await db
    .select({ status: schema.mailboxCustomerRequests.status })
    .from(schema.mailboxCustomerRequests)
    .where(eq(schema.mailboxCustomerRequests.teamId, actor.teamId));
  // A free trial only for a team that never had Correio (the Customer and the
  // card are checked again at Checkout and after it).
  const listed = paidSending ? mailboxBillingOffers("with_sending") : standaloneOffers;
  const trialEligible =
    listed.some((entry) => entry.trialDays > 0) &&
    (await mailboxTrialDays(db, { trialDays: 1 }, actor.teamId, member.stripeCustomerId)) > 0;
  const offers = listed.map((entry) => (trialEligible ? entry : { ...entry, trialDays: 0 }));
  const firstStandalone = offers.find((entry) =>
    standaloneOffers.some((standalone) => standalone.offerId === entry.offerId),
  );
  const offer = paidSending
    ? mailboxBillingOffer()
    : firstStandalone
      ? (({ offerId: _offerId, ...rest }) => rest)(firstStandalone)
      : mailboxBillingOffer();
  const catalog = mailboxBillingCatalog();
  const pendingPrice =
    checkout && catalog && checkout.livemode === catalog.livemode
      ? purchasableTerms(catalog, "any").find(
          (price) =>
            checkout.priceId === price.priceId &&
            checkout.currency === price.currency &&
            checkout.unitAmount === price.unitAmount &&
            checkout.interval === price.interval &&
            checkout.storageBytesPerMailbox === price.storageBytesPerMailbox &&
            checkout.includedOutboundPerMailbox === price.includedOutboundPerMailbox,
        )
      : null;
  const pendingOffer = catalog && pendingPrice ? publicOffer(catalog, pendingPrice) : null;
  const defaultPrice = purchasableTerms(catalog).find(
    (price) => price.priceId === catalog?.checkoutPriceId,
  );
  const defaultOfferId = !paidSending
    ? (firstStandalone?.offerId ?? null)
    : offer && catalog && defaultPrice
      ? publicOffer(catalog, defaultPrice).offerId
      : null;
  // An add-on contract keeps needing Envio to grow or resume; a standalone one never does.
  const contractNeedsSending =
    !paidSending &&
    !!subscription?.stripePriceId &&
    !isStandaloneMailboxPrice(catalog, subscription.stripePriceId);
  const sameOffer = !checkout || pendingOffer !== null;
  const ended =
    subscription?.status === "canceled" &&
    !!subscription.stripeSubscriptionId &&
    subscription.lastEventCreated !== null;
  const completedPending =
    !!completedCheckout &&
    (!ended || completedCheckout.subscriptionId !== subscription?.stripeSubscriptionId);
  const [managementRequest] = await db
    .select({
      action: mailboxManagementRequests.action,
      status: mailboxManagementRequests.status,
      seats: mailboxManagementRequests.seats,
      effectiveAt: mailboxManagementRequests.periodEnd,
    })
    .from(mailboxManagementRequests)
    .where(
      and(
        eq(mailboxManagementRequests.teamId, actor.teamId),
        eq(
          mailboxManagementRequests.stripeSubscriptionId,
          subscription?.stripeSubscriptionId ?? "",
        ),
        eq(mailboxManagementRequests.stripeCustomerId, subscription?.stripeCustomerId ?? ""),
        eq(mailboxManagementRequests.livemode, subscription?.livemode ?? false),
        inArray(mailboxManagementRequests.status, ["prepared", "creating", "pending", "scheduled"]),
      ),
    )
    .orderBy(desc(mailboxManagementRequests.createdAt))
    .limit(1);
  const manageable =
    canManage &&
    !member.suspendedAt &&
    member.plan !== "system" &&
    mailboxManagementEnabled() &&
    !!catalog &&
    !!subscription?.stripeCustomerId &&
    !!subscription.stripeSubscriptionId &&
    !!subscription.stripeSubscriptionItemId &&
    subscription.livemode === catalog.livemode;
  // Reconciliation may read an existing contract while new financial changes are paused.
  // The caller must also enforce the mutation flag and use read-only provider reconciliation.
  const mutable = manageable && !mailboxBillingMutationsPaused();
  const openManagement = !!managementRequest && managementRequest.status !== "scheduled";
  // The Correio plans this team can move to (or migrate into), with the current one marked.
  const planTerms = catalog
    ? purchasableTerms(catalog, "standalone").filter((price) => price.planCode)
    : [];
  const planOffers = catalog
    ? planTerms.map((price) => ({
        ...publicOffer(catalog, price),
        trialDays: 0,
        current: subscription?.stripePriceId === price.priceId,
      }))
    : [];
  const onPlan = !!subscription?.planCode;
  const scheduledReduction =
    managementRequest?.status === "scheduled" &&
    !!subscription &&
    ["active", "trialing", "past_due"].includes(subscription.status);
  const beforeEnd = !!subscription && subscription.periodEnd.getTime() > Date.now();
  const availability =
    !canManage || member.suspendedAt || member.plan === "system"
      ? ("forbidden" as const)
      : (subscription && !ended) || completedPending
        ? ("existing_subscription" as const)
        : sendingPlanRequired
          ? ("sending_plan_required" as const)
          : earlyAccessRequired
            ? ("early_access_required" as const)
            : newSubscriptionsPaused()
              ? ("subscriptions_paused" as const)
              : offers.length === 0
                ? ("unavailable" as const)
                : !sameOffer
                  ? ("recovery_required" as const)
                  : ("available" as const);
  return {
    canManage,
    canPurchase: availability === "available",
    /** Which price list this team buys from; checkout resolves offers within it only. */
    audience,
    sendingPlanRequired,
    earlyAccessRequired,
    availability,
    offer,
    offers,
    defaultOfferId,
    pendingOfferId: pendingOffer?.offerId ?? null,
    pendingOffer,
    checkoutPending: !!checkout || customerRequest?.status === "creating",
    pendingCheckoutSeats: checkout?.seats ?? null,
    /** An unpaid purchase can be left to choose another plan (mailboxes.abandonCheckout). */
    canAbandonCheckout:
      !!checkout && canManage && !member.suspendedAt && !mailboxBillingMutationsPaused(),
    management: {
      canReconcile: manageable,
      canCancel:
        mutable &&
        beforeEnd &&
        ["active", "trialing", "past_due"].includes(subscription!.status) &&
        !subscription!.cancelAtPeriodEnd &&
        !openManagement,
      canResume:
        mutable &&
        !sendingPlanRequired &&
        !contractNeedsSending &&
        !earlyAccessRequired &&
        beforeEnd &&
        ["active", "trialing"].includes(subscription!.status) &&
        subscription!.cancelAtPeriodEnd &&
        !openManagement,
      canAdjust:
        mutable &&
        beforeEnd &&
        subscription!.status === "active" &&
        !subscription!.cancelAtPeriodEnd &&
        !openManagement &&
        !onPlan,
      canIncrease:
        mutable &&
        !sendingPlanRequired &&
        !contractNeedsSending &&
        !earlyAccessRequired &&
        beforeEnd &&
        subscription!.status === "active" &&
        !subscription!.cancelAtPeriodEnd &&
        !openManagement &&
        !onPlan,
      /** A plan changes plan instead of quantity; a pre-plan contract may migrate into one. */
      canChangePlan:
        mutable &&
        beforeEnd &&
        ["active", "trialing"].includes(subscription!.status) &&
        !subscription!.cancelAtPeriodEnd &&
        !openManagement &&
        planOffers.length > 0,
      currentPlan: subscription?.planCode ?? null,
      planOffers,
      pending: openManagement,
      requestedSeats:
        openManagement && managementRequest?.action === "increase" ? managementRequest.seats : null,
      scheduledSeats: scheduledReduction ? managementRequest.seats : null,
      effectiveAt: scheduledReduction ? managementRequest.effectiveAt : null,
    },
  };
}

/** SDK-backed readback stays server-side and receives only the persisted, authorized lease. */
export function mailboxPurchaseDeps(db: Db): MailboxPurchaseDeps {
  const stripe = getStripe();
  return {
    db,
    stripe,
    requirePaidSendingPlan: true,
    earlyAccessCohort: mailboxEarlyAccessCohort(),
    recoverCheckout: (lease) => recoverMailboxCheckoutSession(stripe, lease),
  };
}
