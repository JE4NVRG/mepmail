import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Billing concept only — deployment mode lives exclusively in env.IS_CLOUD;
// self-host ignores plan entirely (quota code guards on IS_CLOUD first).
// "system" marks the instance's own team (the one holding the account-mail
// sender domain): never billed, never capped, set by an operator, never by
// Stripe.
export const planEnum = pgEnum("plan", ["free", "starter", "pro", "scale", "system"]);

// Mirrors Stripe subscription statuses; "none" = never subscribed. The
// entitlement is `teams.plan`, written only by the verified Stripe webhook.
export const planStatusEnum = pgEnum("plan_status", [
  "none",
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "canceled",
  "incomplete",
]);

// Corner radius of the team logo on the hosted unsubscribe page.
export const unsubscribeLogoRadiusEnum = pgEnum("unsubscribe_logo_radius", [
  "square",
  "gentle",
  "rounded",
  "circle",
]);

/** Why an operator suspended a team; owners hear about every reason but phishing. */
export const suspensionReasonEnum = pgEnum("suspension_reason", [
  "manual",
  "reputation",
  "phishing",
  "non_payment",
]);

/** Why sending is held until an operator reviews the team. */
export const sendReviewReasonEnum = pgEnum("send_review_reason", ["impersonation", "payment_risk"]);

export interface BillingTerms {
  version: 1;
  teamId: string;
  customerId: string;
  subscriptionId: string;
  baseItemId: string;
  basePriceId: string;
  overageItemId: string;
  overagePriceId: string;
  currency: "usd";
  centsPerBlock: number;
  blockSize: 1000;
  rounding: "up";
  included: number;
  periodStart: string;
  periodEnd: string;
  verifiedAt: string;
}

/** Provider-verified base terms, independent of first-invoice discounts and usage windows. */
export interface SendBillingContract {
  version: 1;
  teamId: string;
  customerId: string;
  subscriptionId: string;
  baseItemId: string;
  basePriceId: string;
  currency: "usd";
  baseAmountCents: number;
  billingInterval: "month" | "year";
  intervalCount: 1;
  included: number;
  usageInterval: "day" | "month";
  regularMonthlyCents: number;
  financialPeriodStart: string;
  financialPeriodEnd: string;
  usageAnchor: string;
  verifiedAt: string;
}

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    plan: planEnum("plan").notNull().default("free"),
    // Emails included per billing period on a monthly plan — the rung the
    // team bought; null on daily plans. Written by the Stripe webhook only.
    planQuota: integer("plan_quota"),
    // Cloud-only Stripe linkage; all null/"none" on self-host.
    stripeCustomerId: text("stripe_customer_id").unique(),
    stripeSubscriptionId: text("stripe_subscription_id"),
    billingTerms: jsonb("billing_terms").$type<BillingTerms>(),
    sendBillingContract: jsonb("send_billing_contract").$type<SendBillingContract>(),
    stripeSubscriptionCreated: integer("stripe_subscription_created"),
    // The metered overage item on the subscription (every monthly plan
    // carries one); what it bills is what the worker reports, so the switch
    // below is the customer's choice, not the item's presence.
    stripeOverageItemId: text("stripe_overage_item_id"),
    // Sends past the included volume bill instead of stopping, up to the hard
    // cap. On by default, like the market; the customer turns it off in Billing.
    overageEnabled: boolean("overage_enabled").notNull().default(true),
    // The rung a scheduled downgrade moves to when the period renews; null
    // while none is pending. Mirrors the Stripe subscription schedule.
    pendingRung: text("pending_rung"),
    planStatus: planStatusEnum("plan_status").notNull().default("none"),
    // The Stripe billing period: monthly quotas count sends from its start.
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    // When Stripe will end the subscription (cancel_at); null while it renews.
    // Mirrored so a scheduled cancellation is a visible transition and the
    // reminder before it needs no Stripe call.
    cancelAt: timestamp("cancel_at", { withTimezone: true }),
    // SES tenant name for cloud reputation isolation; null on self-host.
    sesTenantName: text("ses_tenant_name"),
    // Per-team customization of the hosted unsubscribe pages. All null =
    // the built-in defaults (wordmark, generic copy, in-place done state).
    unsubscribeBrandName: text("unsubscribe_brand_name"),
    unsubscribeMessage: text("unsubscribe_message"),
    unsubscribeRedirectUrl: text("unsubscribe_redirect_url"),
    // Page theme colors: 6-digit '#rrggbb' enforced by CHECK; null = default.
    unsubscribeBackgroundColor: text("unsubscribe_background_color"),
    unsubscribeTextColor: text("unsubscribe_text_color"),
    unsubscribeAccentColor: text("unsubscribe_accent_color"),
    // Default on: recipients should see the sender's brand, not MepMail's.
    unsubscribeHideBranding: boolean("unsubscribe_hide_branding").notNull().default(true),
    unsubscribeLogoRadius: unsubscribeLogoRadiusEnum("unsubscribe_logo_radius")
      .notNull()
      .default("gentle"),
    // Success-state copy shown after preferences are saved.
    unsubscribeSuccessMessage: text("unsubscribe_success_message"),
    // "Powered by MepMail" under the page. Default on; on the cloud a free
    // plan cannot turn it off (the settings router and the page enforce it).
    unsubscribePoweredBy: boolean("unsubscribe_powered_by").notNull().default(true),
    // Public URL of the uploaded team logo (S3-compatible storage), including a
    // ?v= cache-buster stamped at upload. Null = the initial-letter tile.
    logoUrl: text("logo_url"),
    // Operator overrides (instance console). A ceiling caps the team's UTC
    // day under its plan's limit (min of the two), on monthly plans too.
    dailySendCeiling: integer("daily_send_ceiling"),
    // While set, broadcasts park like a guardrail pause; transactional mail flows.
    broadcastsPausedByOperatorAt: timestamp("broadcasts_paused_by_operator_at", {
      withTimezone: true,
    }),
    // While set, every send is refused (API 403 team_suspended, SMTP 5xx) and
    // broadcasts in flight park; keys still authenticate, data stays.
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    suspensionReason: suspensionReasonEnum("suspension_reason"),
    suspensionNote: text("suspension_note"),
    // While set, accepted mail parks instead of sending until an operator
    // releases it: a young team whose sender or subject imitates a bank, a
    // carrier or an account-security notice, or whose card Stripe's fraud
    // screening blocked. Nothing is lost; a release drains it, a suspension
    // keeps it.
    sendReviewAt: timestamp("send_review_at", { withTimezone: true }),
    sendReviewReason: sendReviewReasonEnum("send_review_reason"),
    sendReviewNote: text("send_review_note"),
    // The operator heard about the current hold (once per hold).
    sendReviewNotifiedAt: timestamp("send_review_notified_at", { withTimezone: true }),
    // An operator released a hold: the impersonation screen stops holding
    // this team (a payment block still does).
    sendReviewClearedAt: timestamp("send_review_cleared_at", { withTimezone: true }),
    sendReviewClearedBy: text("send_review_cleared_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "teams_unsubscribe_background_color_hex",
      sql`${t.unsubscribeBackgroundColor} ~ '^#[0-9a-fA-F]{6}$'`,
    ),
    check("teams_unsubscribe_text_color_hex", sql`${t.unsubscribeTextColor} ~ '^#[0-9a-fA-F]{6}$'`),
    check(
      "teams_unsubscribe_accent_color_hex",
      sql`${t.unsubscribeAccentColor} ~ '^#[0-9a-fA-F]{6}$'`,
    ),
  ],
);
