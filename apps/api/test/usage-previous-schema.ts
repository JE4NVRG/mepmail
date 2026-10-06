import { z } from "@hono/zod-openapi";

/**
 * Frozen pre-offer /usage success DTO. Keep its numeric rate and nullable period
 * independent of today's schema, so old consumers still parse annual hard caps.
 * README.md promises Resend compatibility for Emails; /usage is a MepMail
 * extension and this fixture verifies its own existing wire contract.
 */
export const usageResponseSchema = z
  .object({
    object: z.literal("usage"),
    cloud: z.boolean().describe("True on MepMail Cloud, where plan limits apply"),
    plan: z
      .enum(["free", "starter", "pro", "scale"])
      .nullable()
      .describe("Effective plan; null self-hosted or on the instance's own (system) team"),
    limits: z.object({
      emails_per_day: z
        .number()
        .int()
        .nullable()
        .describe("Daily cap (UTC day) on Free and Starter; null on monthly plans and self-hosted"),
      emails_per_month: z
        .number()
        .int()
        .nullable()
        .describe(
          "Emails included per billing period on Pro and Scale; null on daily plans and self-hosted",
        ),
      domains: z.number().int().nullable().describe("null = unlimited or self-hosted"),
      contacts: z
        .number()
        .int()
        .nullable()
        .describe("Contacts the team may hold; null = unlimited or self-hosted"),
    }),
    today: z.object({
      emails_sent: z.number().int().describe("Emails accepted so far this UTC day"),
      resets_at: z.string().describe("Next UTC midnight, when the daily counter resets"),
    }),
    period: z
      .object({
        emails_sent: z.number().int().describe("Emails accepted so far this billing period"),
        included: z.number().int().describe("Emails the plan includes per period"),
        overage_enabled: z
          .boolean()
          .describe("Whether sends past `included` bill overage instead of being refused"),
        overage_usd_per_1k: z.number().describe("Overage price per 1,000 emails, in USD"),
        starts_at: z.string().describe("Billing period start"),
        ends_at: z.string().describe("Billing period end, when the counter resets"),
      })
      .nullable()
      .describe("Billing-period usage on monthly plans; null on daily plans and self-hosted"),
    team: z.object({ id: z.uuid(), name: z.string() }),
    app_url: z
      .string()
      .nullable()
      .describe("Dashboard origin, for building links; null when unset"),
  })
  .openapi("UsageResponse");
