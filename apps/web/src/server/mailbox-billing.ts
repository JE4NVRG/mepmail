import {
  isLiveKey,
  MailboxLifecycleError,
  recoverMailboxCheckoutSession,
  type MailboxCatalog,
  type MailboxPurchaseDeps,
} from "@millionsend/billing";
import { env, isCloudDeployment } from "@millionsend/config";
import { type Db, schema } from "@millionsend/db";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getStripe } from "./billing";

const terms = z
  .object({
    priceId: z.string().regex(/^price_[A-Za-z0-9_]+$/),
    currency: z.string().regex(/^[a-z]{3}$/),
    unitAmount: z.number().int().positive().max(2147483647),
    interval: z.enum(["month", "year"]),
    storageBytesPerMailbox: z.number().int().min(1).max(10995116277760),
    includedOutboundPerMailbox: z.number().int().min(0).max(1000000),
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
      prices: z.array(terms).max(100),
    })
    .strict()
    .safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.livemode !== isLiveKey(env.STRIPE_SECRET_KEY ?? "") ||
    new Set(parsed.data.prices.map((p) => p.priceId)).size !== parsed.data.prices.length
  )
    return null;
  return parsed.data;
}

/** An offer describes approved terms, never a provider identifier or a grant. */
export function mailboxBillingOffer() {
  if (
    !isCloudDeployment() ||
    !/^(sk|rk)_(test|live)_\S+$/.test(env.STRIPE_SECRET_KEY ?? "") ||
    ["1", "true"].includes(process.env.BILLING_MUTATIONS_PAUSED ?? "")
  )
    return null;
  const catalog = mailboxBillingCatalog();
  const price = catalog?.prices.find((entry) => entry.priceId === catalog.checkoutPriceId);
  if (!price) return null;
  return {
    currency: price.currency,
    unitAmount: price.unitAmount,
    interval: price.interval,
    storageBytesPerMailbox: price.storageBytesPerMailbox,
    includedOutboundPerMailbox: price.includedOutboundPerMailbox,
  };
}

/** Read-only presentation, rechecking membership rather than trusting a cached session role. */
export async function mailboxBillingPresentation(
  db: Db,
  actor: { teamId: string; userId: string },
) {
  const [member] = await db
    .select({
      role: schema.teamMembers.role,
      suspendedAt: schema.teams.suspendedAt,
      plan: schema.teams.plan,
    })
    .from(schema.teamMembers)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
    .where(
      and(eq(schema.teamMembers.teamId, actor.teamId), eq(schema.teamMembers.userId, actor.userId)),
    );
  if (!member) throw new MailboxLifecycleError("forbidden");
  const canManage = member.role === "owner" || member.role === "admin";
  const [subscription] = await db
    .select({ teamId: schema.mailboxSubscriptions.teamId })
    .from(schema.mailboxSubscriptions)
    .where(eq(schema.mailboxSubscriptions.teamId, actor.teamId));
  const [completedCheckout] = await db
    .select({ status: schema.mailboxCheckouts.status })
    .from(schema.mailboxCheckouts)
    .where(
      and(
        eq(schema.mailboxCheckouts.teamId, actor.teamId),
        eq(schema.mailboxCheckouts.status, "completed"),
      ),
    )
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
  const offer = mailboxBillingOffer();
  const catalog = mailboxBillingCatalog();
  const sameOffer =
    !checkout ||
    (!!offer &&
      !!catalog &&
      checkout.priceId === catalog.checkoutPriceId &&
      checkout.livemode === catalog.livemode &&
      checkout.currency === offer.currency &&
      checkout.unitAmount === offer.unitAmount &&
      checkout.interval === offer.interval &&
      checkout.storageBytesPerMailbox === offer.storageBytesPerMailbox &&
      checkout.includedOutboundPerMailbox === offer.includedOutboundPerMailbox);
  const availability =
    !canManage || member.suspendedAt || member.plan === "system"
      ? ("forbidden" as const)
      : subscription || completedCheckout
        ? ("existing_subscription" as const)
        : !offer
          ? ("unavailable" as const)
          : !sameOffer
            ? ("recovery_required" as const)
            : ("available" as const);
  return {
    canManage,
    canPurchase: availability === "available",
    availability,
    offer,
    checkoutPending: !!checkout || customerRequest?.status === "creating",
    pendingCheckoutSeats: checkout?.seats ?? null,
  };
}

/** SDK-backed readback stays server-side and receives only the persisted, authorized lease. */
export function mailboxPurchaseDeps(db: Db): MailboxPurchaseDeps {
  const stripe = getStripe();
  return {
    db,
    stripe,
    recoverCheckout: (lease) => recoverMailboxCheckoutSession(stripe, lease),
  };
}
