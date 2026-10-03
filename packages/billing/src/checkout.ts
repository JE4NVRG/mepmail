import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { beginSendCheckout, type SendCheckoutInput } from "./send-checkout.js";
import type { BillingStripe } from "./stripe.js";

export interface BillingDeps {
  db: Db;
  stripe: BillingStripe;
  log?: ((message: string) => void) | undefined;
}

export interface BillingTeam {
  id: string;
  name: string;
  stripeCustomerId: string | null;
}

type PlanStatus = (typeof schema.planStatusEnum.enumValues)[number];

/**
 * Stripe still holds a subscription for the team under these statuses; a
 * second Checkout would stack another one and bill twice. Changes go through
 * changeRung instead.
 */
const LIVE_SUBSCRIPTION_STATUSES: ReadonlySet<PlanStatus> = new Set<PlanStatus>([
  "active",
  "trialing",
  "past_due",
  "unpaid",
]);

export function hasLiveSubscription(status: PlanStatus): boolean {
  return LIVE_SUBSCRIPTION_STATUSES.has(status);
}

/** Financial intent and the real Session ID are durable; this compatibility API returns its URL. */
export async function createCheckoutSession(
  deps: BillingDeps & { livemode: boolean },
  input: SendCheckoutInput,
): Promise<string> {
  return (await beginSendCheckout(deps, input)).url;
}

export async function createPortalSession(
  stripe: BillingStripe,
  input: { customerId: string; returnUrl: string; configuration?: string | undefined },
): Promise<string> {
  const session = await stripe.billingPortal.sessions.create({
    customer: input.customerId,
    return_url: input.returnUrl,
    ...(input.configuration ? { configuration: input.configuration } : {}),
  });
  return session.url;
}
