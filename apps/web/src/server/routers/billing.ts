import {
  ADVERTISING_CONSENT_COOKIE,
  advertisingCookie,
  type BillingStripe,
  beginSendCheckout,
  changeRung,
  createPortalSession,
  decodeConsentProof,
  hasLiveSubscription,
  isLiveKey,
  metaConversionConfigured,
  readMetaConversionConfig,
  rungFromSubscription,
  SendCheckoutError,
  SUBSCRIPTION_EXPAND,
  setOverage as setSubscriptionOverage,
} from "@millionsend/billing";
import { env } from "@millionsend/config";
import {
  PLAN_RUNG_KEYS,
  type Plan,
  QUOTA_COLUMNS,
  raisesQuota,
  readPeriodUsage,
  rungByKey,
  type TeamQuota,
  teamFunnelProps,
  teamQuota,
  teamRung,
  utcDay,
  verifiedSendBillingContract,
} from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { z } from "zod";
import { LAUNCH_OFFER } from "@/lib/launch-offer";
import { recordAudit } from "../audit";
import { resolveBaseUrl } from "../auth";
import { getStripe, mailPlanMove } from "../billing";
import { emitFunnel } from "../funnel";
import { getQueue } from "../queue";
import { adminProcedure, router, teamProcedure } from "../trpc";

/** Stripe seam for tests, mirroring SystemSesDeps. */
export interface BillingDeps {
  stripe(): BillingStripe;
}

// Billing does not exist on self-host: not forbidden, absent.
function requireCloud(): void {
  if (!env.IS_CLOUD) throw new TRPCError({ code: "NOT_FOUND" });
}

async function loadTeam(db: Db, teamId: string) {
  const [team] = await db
    .select({
      ...QUOTA_COLUMNS,
      id: schema.teams.id,
      name: schema.teams.name,
      planStatus: schema.teams.planStatus,
      stripeCustomerId: schema.teams.stripeCustomerId,
      stripeSubscriptionId: schema.teams.stripeSubscriptionId,
      cancelAt: schema.teams.cancelAt,
      pendingRung: schema.teams.pendingRung,
      sendBillingContract: schema.teams.sendBillingContract,
    })
    .from(schema.teams)
    .where(eq(schema.teams.id, teamId));
  if (!team) throw new TRPCError({ code: "NOT_FOUND" });
  return team;
}

/** The instance's own team has no subscription to start, move or manage. */
function assertBillable(team: { plan: Plan }): void {
  if (team.plan === "system") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "The system team is never billed; its plan is set by the operator.",
    });
  }
}

/** Sends counted against the quota so far: the UTC day on a daily cap, the billing period on a monthly one. */
async function readUsage(db: Db, teamId: string, quota: TeamQuota) {
  if (quota.kind === "month") return readPeriodUsage(db, teamId, quota.periodStart);
  const c = schema.usageCounters;
  const [row] = await db
    .select({ accepted: c.accepted })
    .from(c)
    .where(and(eq(c.teamId, teamId), eq(c.day, utcDay())));
  return { accepted: row?.accepted ?? 0, reportedOverage: 0 };
}

/** Rungs for sale; Free is reached by cancelling in the portal. */
const paidRung = z.enum(PLAN_RUNG_KEYS).refine((key) => rungByKey(key).priceCents > 0);

/**
 * Mail parked over the old cap would otherwise wait for the next scheduled
 * drain. Best-effort: the plan is already committed, and the scheduled
 * drain releases the mail regardless.
 */
async function kickQuotaDrain(): Promise<void> {
  try {
    await (await getQueue()).runCronNow("quota.drain");
  } catch (err) {
    console.error(
      "billing: quota.drain kick failed; the scheduled drain will release the mail",
      err,
    );
  }
}

const billingPageUrl = () => `${resolveBaseUrl(env.APP_BASE_URL)}/settings/billing`;

/** Only trusted request cookies enter the server-only advertising context. */
async function checkoutAdvertising() {
  const config = readMetaConversionConfig(process.env);
  if (!metaConversionConfigured(config)) return {};
  const cookieHeader = (await headers()).get("cookie");
  return {
    advertising: {
      config,
      cookieHeader,
      proof: decodeConsentProof(
        advertisingCookie(cookieHeader, ADVERTISING_CONSENT_COOKIE),
        env.BETTER_AUTH_SECRET ?? "",
      ),
    },
  };
}

const launchOfferEnabled = () => process.env.SEND_LAUNCH_OFFER_ENABLED === "true";

const billingMutationProcedure = adminProcedure.use(({ next }) => {
  const paused = process.env.BILLING_MUTATIONS_PAUSED;
  if (paused === "true" || paused === "1") {
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: "Billing changes are temporarily paused. Please try again later.",
    });
  }
  return next();
});

export function createBillingRouter(deps: BillingDeps = { stripe: getStripe }) {
  return router({
    status: teamProcedure.query(async ({ ctx }) => {
      requireCloud();
      const team = await loadTeam(ctx.db, ctx.teamId);
      const live = hasLiveSubscription(team.planStatus);
      const contract = verifiedSendBillingContract(team.sendBillingContract, {
        teamId: team.id,
        customerId: team.stripeCustomerId,
        subscriptionId: team.stripeSubscriptionId,
        financialPeriodStart: team.currentPeriodStart,
        financialPeriodEnd: team.currentPeriodEnd,
      });
      let subscriptionState: "none" | "confirmed" | "pending_confirmation" =
        live && team.plan !== "system" ? "pending_confirmation" : "none";
      let effectiveRung = null;
      let effectiveInterval: "month" | "year" | null = null;
      if (team.plan !== "free" && team.plan !== "system" && team.stripeSubscriptionId) {
        try {
          const subscription = await deps
            .stripe()
            .subscriptions.retrieve(team.stripeSubscriptionId, { expand: SUBSCRIPTION_EXPAND });
          const resolved = rungFromSubscription(subscription);
          const base = subscription.items.data.find(
            (item) => item.price.recurring?.usage_type === "licensed",
          );
          const interval = base?.price.recurring?.interval;
          const customerId =
            typeof subscription.customer === "string"
              ? subscription.customer
              : subscription.customer.id;
          const bound =
            subscription.id === team.stripeSubscriptionId &&
            customerId === team.stripeCustomerId &&
            subscription.status === team.planStatus;
          const consistent =
            !contract ||
            (base?.id === contract.baseItemId &&
              base.price.id === contract.basePriceId &&
              base.price.unit_amount === contract.baseAmountCents &&
              interval === contract.billingInterval &&
              resolved?.included === contract.included &&
              base.current_period_start * 1000 ===
                new Date(contract.financialPeriodStart).getTime() &&
              base.current_period_end * 1000 === new Date(contract.financialPeriodEnd).getTime());
          if (resolved && bound && consistent && (interval === "month" || interval === "year")) {
            effectiveRung = resolved;
            effectiveInterval = interval === "year" ? "year" : "month";
            subscriptionState = "confirmed";
          }
        } catch {
          // Falha de leitura não autoriza usar preço do catálogo como contrato vigente.
          effectiveRung = null;
        }
      }
      const operationalQuota = teamQuota(
        { ...team, overageCentsPer1k: effectiveRung?.overageCentsPer1k ?? null },
        true,
      );
      // Contract identifiers stay server-side. An inconsistent provider read cannot
      // advertise a confirmed metered tariff from the persisted snapshot.
      const confirmedRate =
        operationalQuota.kind === "month" &&
        effectiveRung?.overageCentsPer1k !== null &&
        effectiveRung?.overageCentsPer1k === operationalQuota.overageCentsPer1k;
      const quota =
        operationalQuota.kind === "month"
          ? {
              kind: operationalQuota.kind,
              plan: operationalQuota.plan,
              included: operationalQuota.included,
              periodStart: operationalQuota.periodStart,
              periodEnd: operationalQuota.periodEnd,
              overage: operationalQuota.overage && confirmedRate,
              overageCentsPer1k: confirmedRate ? operationalQuota.overageCentsPer1k : null,
              ...(operationalQuota.dailyCeiling === undefined
                ? {}
                : { dailyCeiling: operationalQuota.dailyCeiling }),
            }
          : operationalQuota;
      return {
        effectiveRung,
        subscriptionState,
        plan: team.plan,
        planQuota: team.planQuota,
        rung: team.plan === "system" ? null : teamRung(team.plan, team.planQuota).key,
        pendingRung: team.pendingRung,
        planStatus: team.planStatus,
        currentPeriodEnd: team.currentPeriodEnd,
        quota,
        usage: await readUsage(ctx.db, ctx.teamId, quota),
        hasCustomer: team.stripeCustomerId !== null,
        hasLiveSubscription: live,
        billingInterval: contract?.billingInterval ?? effectiveInterval,
        launchOffer:
          launchOfferEnabled() && !live && team.plan !== "system"
            ? {
                rung: "pro_100k" as const,
                monthlyCents: LAUNCH_OFFER.sending.monthlyCents,
                firstMonthlyCents: LAUNCH_OFFER.sending.firstMonthlyCents,
                annualCents: LAUNCH_OFFER.sending.monthlyCents * LAUNCH_OFFER.annualChargedMonths,
                monthlyRecipientDeliveries: LAUNCH_OFFER.sending.monthlyRecipientDeliveries,
              }
            : null,
      };
    }),

    checkout: billingMutationProcedure
      .input(z.object({ rung: paidRung, interval: z.enum(["month", "year"]).default("month") }))
      .mutation(async ({ ctx, input }) => {
        requireCloud();
        const team = await loadTeam(ctx.db, ctx.teamId);
        assertBillable(team);
        // Plan changes on a live subscription go through changePlan; a second
        // Checkout would create a second subscription.
        if (hasLiveSubscription(team.planStatus)) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "SEND_CHECKOUT_SUBSCRIPTION_EXISTS",
          });
        }
        const offerEnabled = launchOfferEnabled();
        if (input.interval === "year" && (!offerEnabled || input.rung !== "pro_100k")) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "SEND_CHECKOUT_INVALID" });
        }
        let checkout: Awaited<ReturnType<typeof beginSendCheckout>>;
        try {
          checkout = await beginSendCheckout(
            {
              db: ctx.db,
              stripe: deps.stripe(),
              livemode: isLiveKey(env.STRIPE_SECRET_KEY ?? ""),
              launchOfferEnabled: offerEnabled,
              ...(await checkoutAdvertising()),
            },
            {
              team,
              userId: ctx.session.user.id,
              rung: input.rung,
              interval: input.interval,
              email: ctx.session.user.email,
              successUrl: `${billingPageUrl()}?checkout=success`,
              cancelUrl: billingPageUrl(),
              automaticTax: env.STRIPE_AUTOMATIC_TAX ?? true,
            },
          );
        } catch (error) {
          if (!(error instanceof SendCheckoutError)) throw error;
          const code =
            error.code === "forbidden"
              ? "FORBIDDEN"
              : error.code === "not_found"
                ? "NOT_FOUND"
                : error.code === "invalid"
                  ? "BAD_REQUEST"
                  : error.code === "subscription_exists"
                    ? "PRECONDITION_FAILED"
                    : "CONFLICT";
          throw new TRPCError({ code, message: `SEND_CHECKOUT_${error.code.toUpperCase()}` });
        }
        await recordAudit(ctx, {
          action: "billing.checkout_started",
          target: { type: "team", id: ctx.teamId },
          metadata: {
            rung: input.rung,
            interval: input.interval,
            checkoutAttemptId: checkout.attemptId,
          },
        });
        // A persisted Session defines intent; reopening it is never a new purchase.
        await emitFunnel(ctx.db, {
          name: "checkout_started",
          dedupeKey: `checkout_started:${ctx.teamId}:${checkout.attemptId}`,
          teamId: ctx.teamId,
          props: { plan: input.rung.split("_")[0] ?? null },
          resolve: (tx) => teamFunnelProps(tx, ctx.teamId),
        });
        return { url: checkout.url };
      }),

    /**
     * Moves a live subscription to another rung with Stripe prorations. The
     * portal cannot switch plans on a subscription carrying a metered item,
     * so every plan change happens here.
     */
    changePlan: billingMutationProcedure
      .input(z.object({ rung: paidRung }))
      .mutation(async ({ ctx, input }) => {
        requireCloud();
        const team = await loadTeam(ctx.db, ctx.teamId);
        assertBillable(team);
        if (!hasLiveSubscription(team.planStatus)) {
          throw new TRPCError({ code: "PRECONDITION_FAILED" });
        }
        const change = await changeRung(
          { db: ctx.db, stripe: deps.stripe() },
          { teamId: ctx.teamId, rung: input.rung },
        );
        await recordAudit(ctx, {
          action: "billing.plan_changed",
          target: { type: "team", id: ctx.teamId },
          metadata: { rung: input.rung, applied: change.applied },
        });
        const after = await loadTeam(ctx.db, ctx.teamId);
        if (raisesQuota(teamQuota(team, true), teamQuota(after, true))) await kickQuotaDrain();
        // The row already moved, so the webhook that follows sees no move; the
        // owners hear it from here. Best-effort: the plan change is committed.
        try {
          await mailPlanMove(ctx.db, { id: team.id, name: team.name }, team, after);
        } catch (err) {
          console.error("billing: plan change mail skipped", err);
        }
        return change;
      }),

    setOverage: billingMutationProcedure
      .input(z.object({ enabled: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        requireCloud();
        const team = await loadTeam(ctx.db, ctx.teamId);
        assertBillable(team);
        if (
          !hasLiveSubscription(team.planStatus) ||
          teamRung(team.plan, team.planQuota).period !== "month"
        ) {
          throw new TRPCError({ code: "PRECONDITION_FAILED" });
        }
        await setSubscriptionOverage(
          { db: ctx.db, stripe: deps.stripe() },
          { teamId: ctx.teamId, enabled: input.enabled },
        );
        await recordAudit(ctx, {
          action: "billing.overage_toggled",
          target: { type: "team", id: ctx.teamId },
          metadata: { enabled: input.enabled },
        });
        if (input.enabled) await kickQuotaDrain();
        return { enabled: input.enabled };
      }),

    portal: billingMutationProcedure.mutation(async ({ ctx }) => {
      requireCloud();
      const team = await loadTeam(ctx.db, ctx.teamId);
      assertBillable(team);
      if (!team.stripeCustomerId) throw new TRPCError({ code: "PRECONDITION_FAILED" });
      const url = await createPortalSession(deps.stripe(), {
        customerId: team.stripeCustomerId,
        returnUrl: billingPageUrl(),
        configuration: env.STRIPE_PORTAL_CONFIG,
      });
      await recordAudit(ctx, {
        action: "billing.portal_opened",
        target: { type: "team", id: ctx.teamId },
      });
      return { url };
    }),
  });
}

export const billingRouter = createBillingRouter();
