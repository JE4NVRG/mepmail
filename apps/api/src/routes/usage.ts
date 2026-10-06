import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  nextUtcDayStart,
  PLAN_CONTACT_LIMIT,
  PLAN_DOMAIN_LIMIT,
  readPeriodUsage,
  teamQuota,
  utcDay,
  verifiedSendBillingContract,
  verifiedSendOverageTerms,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import type { ApiDeps, Env } from "../app.js";
import { errorSchema, usageResponseSchema } from "../schemas.js";

const unavailableSchema = errorSchema
  .extend({
    usage: z.object({
      today: usageResponseSchema.shape.today,
      period: z
        .object({
          emails_sent: z.number().int(),
          included: z.number().int(),
          overage_enabled: z.boolean(),
          starts_at: z.string(),
          ends_at: z.string(),
        })
        .nullable(),
    }),
  })
  .openapi("UsageTermsUnavailable");

export function registerUsageRoutes(
  app: OpenAPIHono<Env>,
  deps: Pick<ApiDeps, "db" | "isCloud" | "appBaseUrl">,
): void {
  app.openapi(
    createRoute({
      method: "get",
      path: "/usage",
      responses: {
        200: {
          content: { "application/json": { schema: usageResponseSchema } },
          description:
            "Effective plan and usage limits. Annual Send contracts renew their 110K allowance monthly within the paid year; overage is disabled and its numeric rate is zero. MepMail extension; plan, limits and period are null on self-hosted and system teams.",
        },
        409: {
          content: { "application/json": { schema: unavailableSchema } },
          description:
            "Contract terms or bindings unavailable. Counters remain under usage; period is null when no monthly allowance is verified. No estimated or null overage rate is returned.",
        },
        403: {
          content: { "application/json": { schema: errorSchema } },
          description: "Restricted API key",
        },
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const now = new Date();
      const [team] = await deps.db
        .select()
        .from(schema.teams)
        .where(eq(schema.teams.id, auth.teamId));
      if (!team) throw new Error("authenticated key has no team row");
      // The authenticated team id selects the authoritative financial row. An
      // older auth DTO may not yet carry the signed annual contract fields.
      const quota = teamQuota(team, deps.isCloud, now);
      const counters = schema.usageCounters;
      const [[today], period] = await Promise.all([
        deps.db
          .select({ accepted: counters.accepted })
          .from(counters)
          .where(and(eq(counters.teamId, auth.teamId), eq(counters.day, utcDay(now)))),
        quota.kind === "month" ? readPeriodUsage(deps.db, auth.teamId, quota.periodStart) : null,
      ]);
      const binding = {
        teamId: team.id,
        customerId: team.stripeCustomerId,
        subscriptionId: team.stripeSubscriptionId,
        financialPeriodStart: team.currentPeriodStart,
        financialPeriodEnd: team.currentPeriodEnd,
      };
      const contract = verifiedSendBillingContract(team.sendBillingContract, binding);
      const currentContract = verifiedSendBillingContract(team.sendBillingContract, binding, now);
      const active = ["active", "trialing", "past_due"].includes(team.planStatus);
      const invalidBinding =
        deps.isCloud && team.plan !== "system" && team.sendBillingContract !== null && !contract;
      const annual =
        quota.kind === "month" &&
        active &&
        currentContract?.billingInterval === "year" &&
        currentContract.included === quota.included;
      const terms =
        quota.kind === "month"
          ? verifiedSendOverageTerms(team.billingTerms, {
              teamId: team.id,
              customerId: team.stripeCustomerId,
              subscriptionId: team.stripeSubscriptionId,
              overageItemId: team.stripeOverageItemId,
              periodStart: quota.periodStart,
              periodEnd: quota.periodEnd,
            })
          : null;
      const rate = annual
        ? 0
        : quota.kind === "month" &&
            active &&
            terms &&
            terms.included === quota.included &&
            quota.periodStart <= now &&
            now < quota.periodEnd &&
            (!contract ||
              (contract.baseItemId === terms.baseItemId &&
                contract.basePriceId === terms.basePriceId))
          ? terms.centsPerBlock / 100
          : null;
      if (invalidBinding || (quota.kind === "month" && rate === null)) {
        return c.json(
          {
            statusCode: 409,
            name: "billing_terms_unavailable",
            message:
              "Verified contract terms are unavailable. Usage counters are preserved; contact Billing.",
            usage: {
              today: {
                emails_sent: today?.accepted ?? 0,
                resets_at: nextUtcDayStart(now).toISOString(),
              },
              period:
                quota.kind === "month"
                  ? {
                      emails_sent: period?.accepted ?? 0,
                      included: quota.included,
                      overage_enabled: quota.overage,
                      starts_at: quota.periodStart.toISOString(),
                      ends_at: quota.periodEnd.toISOString(),
                    }
                  : null,
            },
          },
          409,
        );
      }
      const plan = quota.kind === "none" ? null : quota.plan;
      return c.json(
        {
          object: "usage" as const,
          cloud: deps.isCloud,
          plan,
          limits: {
            emails_per_day: quota.kind === "day" ? quota.limit : null,
            emails_per_month: quota.kind === "month" ? quota.included : null,
            domains: plan ? PLAN_DOMAIN_LIMIT[plan] : null,
            contacts: plan ? PLAN_CONTACT_LIMIT[plan] : null,
          },
          today: {
            emails_sent: today?.accepted ?? 0,
            resets_at: nextUtcDayStart(now).toISOString(),
          },
          period:
            quota.kind === "month"
              ? {
                  emails_sent: period?.accepted ?? 0,
                  included: quota.included,
                  overage_enabled: quota.overage,
                  overage_usd_per_1k: rate as number,
                  starts_at: quota.periodStart.toISOString(),
                  ends_at: quota.periodEnd.toISOString(),
                }
              : null,
          team: { id: team.id, name: team.name },
          app_url: deps.appBaseUrl ?? null,
        },
        200,
      );
    },
  );
}
