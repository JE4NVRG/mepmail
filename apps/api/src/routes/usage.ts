import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  nextUtcDayStart,
  PLAN_CONTACT_LIMIT,
  PLAN_DOMAIN_LIMIT,
  readPeriodUsage,
  teamQuota,
  utcDay,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";
import type { ApiDeps, Env } from "../app.js";
import { errorSchema, usageResponseSchema } from "../schemas.js";

const unavailableSchema = errorSchema
  .extend({
    usage: z.object({
      today: usageResponseSchema.shape.today,
      period: z.object({
        emails_sent: z.number().int(),
        included: z.number().int(),
        overage_enabled: z.boolean(),
        starts_at: z.string(),
        ends_at: z.string(),
      }),
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
            "Effective plan, its send, domain and contact limits, today's accepted send count (UTC day) and, on a monthly plan, the billing period's usage. MepMail extension; plan, limits and period are null on a self-hosted instance and on the instance's own (system) team.",
        },
        409: {
          content: { "application/json": { schema: unavailableSchema } },
          description:
            "Monthly contract terms missing, invalid or expired. Counters remain available under usage; no estimated or null rate is returned.",
        },
        403: {
          content: { "application/json": { schema: errorSchema } },
          description: "Restricted API key",
        },
      },
    }),
    async (c) => {
      const auth = c.get("auth");
      const quota = teamQuota(auth.billing, deps.isCloud);
      const counters = schema.usageCounters;
      const [[team], [today], period] = await Promise.all([
        deps.db.select().from(schema.teams).where(eq(schema.teams.id, auth.teamId)),
        deps.db
          .select({ accepted: counters.accepted })
          .from(counters)
          .where(and(eq(counters.teamId, auth.teamId), eq(counters.day, utcDay()))),
        quota.kind === "month" ? readPeriodUsage(deps.db, auth.teamId, quota.periodStart) : null,
      ]);
      if (!team) throw new Error("authenticated key has no team row");
      const terms = team.billingTerms;
      const rate =
        quota.kind === "month" &&
        terms?.version === 1 &&
        terms.teamId === team.id &&
        terms.customerId === team.stripeCustomerId &&
        terms.subscriptionId === team.stripeSubscriptionId &&
        terms.overageItemId === team.stripeOverageItemId &&
        terms.baseItemId &&
        terms.basePriceId &&
        terms.overagePriceId &&
        terms.currency === "usd" &&
        terms.blockSize === 1000 &&
        terms.rounding === "up" &&
        Number.isSafeInteger(terms.centsPerBlock) &&
        terms.centsPerBlock >= 0 &&
        terms.included === quota.included &&
        terms.periodStart === quota.periodStart.toISOString() &&
        terms.periodEnd === quota.periodEnd.toISOString() &&
        new Date(terms.periodStart).getTime() <= Date.now() &&
        Date.now() < new Date(terms.periodEnd).getTime() &&
        (team.planStatus === "active" ||
          team.planStatus === "trialing" ||
          team.planStatus === "past_due")
          ? terms.centsPerBlock / 100
          : null;
      if (quota.kind === "month" && rate === null) {
        return c.json(
          {
            statusCode: 409,
            name: "billing_terms_unavailable",
            message:
              "Verified contract terms are unavailable. Usage counters are preserved; contact Billing.",
            usage: {
              today: {
                emails_sent: today?.accepted ?? 0,
                resets_at: nextUtcDayStart().toISOString(),
              },
              period: {
                emails_sent: period?.accepted ?? 0,
                included: quota.included,
                overage_enabled: quota.overage,
                starts_at: quota.periodStart.toISOString(),
                ends_at: quota.periodEnd.toISOString(),
              },
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
            resets_at: nextUtcDayStart().toISOString(),
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
