import { isLiveKey } from "@millionsend/billing";
import { customerSmtpRelay, env, isCloudDeployment, supportViewEnabled } from "@millionsend/config";
import {
  accountMailPhrase,
  claimNotification,
  clearTeamSignupRisk,
  fetchAccountScore,
  fetchDeliverabilityHealth,
  formatMailDateTime,
  getSignupSendingRestriction,
  getTeamSignupRisk,
  isSendReviewHeld,
  liveSupportViewForTeam,
  type MailLocale,
  PLAN_RUNGS,
  type Plan,
  raisesQuota,
  SUPPORT_VIEW_REASONS,
  SUSPENSION_REASONS,
  type SupportViewReason,
  sendReviewMailReason,
  startSupportView,
  supportViewNeedsReference,
  teamQuota,
} from "@millionsend/core";
import { schema } from "@millionsend/db";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, ilike, isNotNull, isNull, or, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { isUniqueViolation } from "@/lib/db-errors";
import { escapeLike } from "@/lib/sql";
import { cutTeamSendingAccess } from "../../console/suspension";
import { mailboxRegistryEnabled } from "../../mailboxes";
import { operatorProcedure, router } from "../../trpc";
import { auditOperator, kickQuotaDrain, loadTeam, mailTeamOwners } from "./shared";
import { consoleTeamInvitationsRouter } from "./team-invitations";

const SORT_KEYS = [
  "name",
  "type",
  "domains",
  "contacts",
  "sent30d",
  "score",
  "guardrail",
  "created",
] as const;
const PAUSE_REASONS = ["complaints", "report", "manual"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const t = schema.teams;
const st = schema.teamStandings;

// Correlated subqueries the list and the detail share; each is an index range on the team id.
const ownerEmail = sql<
  string | null
>`(select u.email from ${schema.teamMembers} m join ${schema.user} u on u.id = m.user_id where m.team_id = ${t}."id" and m.role = 'owner' order by m.created_at, m.user_id limit 1)`;
/** This is the current displayed owner's signup, never the team's acquisition history. */
const ownerSignupAttribution = sql<{
  source: string;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
  referrer: string | null;
  landingPath: string | null;
} | null>`(select jsonb_build_object('source', a.source, 'medium', a.medium, 'campaign', a.campaign, 'content', a.content, 'term', a.term, 'referrer', a.referrer, 'landingPath', a.landing_path) from ${schema.signupAttribution} a where a.user_id = (select m.user_id from ${schema.teamMembers} m where m.team_id = ${t}."id" and m.role = 'owner' order by m.created_at, m.user_id limit 1))`;
/** One indexed local projection per team; rendering never calls Stripe. */
const mailboxSubscription = sql<{
  planCode: string | null;
  status: string;
  periodEnd: string;
  cancelAtPeriodEnd: boolean;
} | null>`(select jsonb_build_object('planCode', s.plan_code, 'status', s.status, 'periodEnd', s.period_end, 'cancelAtPeriodEnd', s.cancel_at_period_end) from ${schema.mailboxSubscriptions} s where s.team_id = ${t}."id")`;
const memberCount = sql<number>`(select count(*)::int from ${schema.teamMembers} m where m.team_id = ${t}."id")`;
const domainCount = sql<number>`(select count(*)::int from ${schema.domains} d where d.team_id = ${t}."id" and d.status = 'verified')`;
const contactCount = sql<number>`(select count(*)::int from ${schema.contacts} c where c.team_id = ${t}."id")`;
// The team's region is that of its most recently verified domain, the breaker's own convention.
const teamRegion = sql<
  string | null
>`(select d.region from ${schema.domains} d where d.team_id = ${t}."id" order by d.verified_at desc nulls last, d.created_at desc limit 1)`;
const planRank = sql<number>`case ${t.plan}::text when 'free' then 0 when 'starter' then 1 when 'pro' then 2 when 'scale' then 3 else 4 end`;
const guardrailRank = sql<number>`case ${st.guardrail} when 'warning' then 1 when 'paused' then 2 else 0 end`;

const SORT_EXPR: Record<(typeof SORT_KEYS)[number], SQL | AnyPgColumn> = {
  name: t.name,
  type: planRank,
  domains: domainCount,
  contacts: contactCount,
  sent30d: sql`${st.sent30d}`,
  score: sql`${st.scoreTenths}`,
  guardrail: guardrailRank,
  created: t.createdAt,
};

/** The columns every row and the detail carry. */
const ROW = {
  id: t.id,
  name: t.name,
  slug: t.slug,
  logoUrl: t.logoUrl,
  plan: sql<string>`${t.plan}::text`,
  planQuota: t.planQuota,
  ownerEmail,
  ownerSignupAttribution,
  get mailboxSubscription() {
    return mailboxRegistryEnabled() ? mailboxSubscription : sql<null>`null::jsonb`;
  },
  get mailboxProjectionEnabled() {
    return mailboxRegistryEnabled() ? sql<boolean>`true` : sql<boolean>`false`;
  },
  members: memberCount,
  domains: domainCount,
  contacts: contactCount,
  region: teamRegion,
  createdAt: t.createdAt,
  suspendedAt: t.suspendedAt,
  suspensionReason: t.suspensionReason,
  suspensionNote: t.suspensionNote,
  broadcastsPausedByOperatorAt: t.broadcastsPausedByOperatorAt,
  dailySendCeiling: t.dailySendCeiling,
  stripeCustomerId: t.stripeCustomerId,
  stripeSubscriptionId: t.stripeSubscriptionId,
  planStatus: t.planStatus,
  scoreTenths: st.scoreTenths,
  guardrail: st.guardrail,
  sent30d: st.sent30d,
  standingAt: st.computedAt,
};

/** Search by anything an operator has in hand: names, ids, member and owner emails, domains, Stripe ids. */
function searchWhere(q: string): SQL | undefined {
  const like = `%${escapeLike(q)}%`;
  return or(
    ilike(t.name, like),
    ilike(t.slug, like),
    UUID.test(q) ? eq(t.id, q) : undefined,
    eq(t.stripeCustomerId, q),
    eq(t.stripeSubscriptionId, q),
    sql`exists (select 1 from ${schema.teamMembers} m join ${schema.user} u on u.id = m.user_id where m.team_id = ${t}."id" and u.email ilike ${like})`,
    sql`exists (select 1 from ${schema.domains} d where d.team_id = ${t}."id" and d.name ilike ${like})`,
  );
}

const planValues = schema.planEnum.enumValues as readonly string[];

/** The rungs an operator may put a team on: every plan rung, plus system when the enum carries it. */
export function operatorRungs(): { plan: string; planQuota: number | null; key: string }[] {
  const rungs = PLAN_RUNGS.map((r) => ({
    plan: r.plan,
    planQuota: r.period === "month" ? r.included : null,
    key: r.key,
  }));
  return planValues.includes("system")
    ? [...rungs, { plan: "system", planQuota: null, key: "system" }]
    : rungs;
}

/** The clause the owner's notice gives for a support view: "at your request, support ticket #4812". */
function supportViewReasonText(
  locale: MailLocale,
  reason: SupportViewReason,
  reference: string | null,
): string {
  const kind = "support.view_started";
  const needed = supportViewNeedsReference(reason);
  const ref =
    reference && !needed
      ? accountMailPhrase({ locale, kind, key: "ref", values: { reference } })
      : (reference ?? "");
  return accountMailPhrase({ locale, kind, key: reason, values: { reference: ref } });
}

/** What a pause or suspension mail says in the reason slot: the phrase, then the operator's note. */
function reasonText(
  locale: Parameters<typeof accountMailPhrase>[0]["locale"],
  kind: "team.broadcasts_paused" | "team.suspended",
  reason: string,
  note: string | undefined,
): string {
  const phrase = accountMailPhrase({ locale, kind, key: reason });
  return note
    ? `${phrase} ${accountMailPhrase({ locale, kind, key: "note", values: { note } })}`
    : phrase;
}

export const consoleTeamsRouter = router({
  /** Invitations into any team, from the console (console/team-invitations.ts). */
  invitations: consoleTeamInvitationsRouter,

  list: operatorProcedure
    .input(
      z.object({
        search: z.string().trim().max(200).optional(),
        type: z.string().max(32).optional(),
        region: z.string().max(32).optional(),
        guardrail: z.enum(["ok", "warning", "paused"]).optional(),
        /** Omitted = every team (the original contract). */
        status: z.enum(["active", "suspended"]).optional(),
        sort: z.enum(SORT_KEYS).default("sent30d"),
        dir: z.enum(["asc", "desc"]).default("desc"),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const filters: (SQL | undefined)[] = [];
      if (input.search) filters.push(searchWhere(input.search));
      if (input.type) filters.push(sql`${t.plan}::text = ${input.type}`);
      if (input.region) filters.push(sql`${teamRegion} = ${input.region}`);
      if (input.status === "active") filters.push(isNull(t.suspendedAt));
      if (input.status === "suspended") filters.push(isNotNull(t.suspendedAt));
      if (input.guardrail) {
        filters.push(
          input.guardrail === "ok"
            ? or(eq(st.guardrail, "ok"), isNull(st.guardrail))
            : eq(st.guardrail, input.guardrail),
        );
      }
      const where = filters.length > 0 ? and(...filters) : undefined;
      const expr = SORT_EXPR[input.sort];
      const order =
        input.dir === "asc" ? sql`${expr} asc nulls last` : sql`${expr} desc nulls last`;
      const [rows, [count]] = await Promise.all([
        ctx.db
          .select(ROW)
          .from(t)
          .leftJoin(st, eq(st.teamId, t.id))
          .where(where)
          .orderBy(order, asc(t.id))
          .limit(input.limit + 1)
          .offset(input.offset),
        ctx.db
          .select({ total: sql<number>`count(*)::int` })
          .from(t)
          .leftJoin(st, eq(st.teamId, t.id))
          .where(where),
      ]);
      const items = rows.slice(0, input.limit);
      return {
        items,
        total: count?.total ?? 0,
        nextOffset: rows.length > input.limit ? input.offset + input.limit : null,
        rungs: operatorRungs(),
        supportViewEnabled: supportViewEnabled(),
      };
    }),

  /** One team, the way the console's team dialog and the review page read it: counters live, standing fresh. */
  signupRisk: operatorProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const team = await loadTeam(ctx.db, input.id);
    const risk = await getTeamSignupRisk(ctx.db, input.id);
    const restriction = await getSignupSendingRestriction(ctx.db, input.id, env.IS_CLOUD);
    const [request] = await ctx.db
      .select({
        context: schema.signupRiskReviewRequests.context,
        requestedAt: schema.signupRiskReviewRequests.requestedAt,
        resolvedAt: schema.signupRiskReviewRequests.resolvedAt,
      })
      .from(schema.signupRiskReviewRequests)
      .where(eq(schema.signupRiskReviewRequests.teamId, input.id));
    return risk || team.sendReviewAt || request
      ? {
          level: risk?.level ?? null,
          reasons: risk?.reasons ?? [],
          policyVersion: risk?.policyVersion ?? null,
          clearedAt: risk?.clearedAt ?? null,
          restriction: restriction.kind,
          sendReviewAt: team.sendReviewAt,
          suspendedAt: team.suspendedAt,
          request: request ?? null,
        }
      : null;
  }),

  clearSignupRisk: operatorProcedure
    .input(
      z.object({
        id: z.uuid(),
        reason: z.string().trim().min(15).max(500),
        reviewed: z.literal(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await loadTeam(ctx.db, input.id);
      const changed = await clearTeamSignupRisk(ctx.db, {
        teamId: input.id,
        operatorId: ctx.operator.id,
        reason: input.reason,
      });
      return { changed, existingHoldAndSuspensionUnchanged: true, noQueueAction: true };
    }),

  /** Acknowledges only the request. Sending restrictions require their own explicit decisions. */
  resolveSignupReview: operatorProcedure
    .input(z.object({ id: z.uuid(), reviewed: z.literal(true) }))
    .mutation(async ({ ctx, input }) => {
      await loadTeam(ctx.db, input.id);
      return ctx.db.transaction(async (tx) => {
        const [request] = await tx
          .select({ resolvedAt: schema.signupRiskReviewRequests.resolvedAt })
          .from(schema.signupRiskReviewRequests)
          .where(eq(schema.signupRiskReviewRequests.teamId, input.id))
          .for("update");
        if (!request || request.resolvedAt) return { changed: false };
        const now = new Date();
        await tx
          .update(schema.signupRiskReviewRequests)
          .set({ resolvedAt: now })
          .where(eq(schema.signupRiskReviewRequests.teamId, input.id));
        await tx.insert(schema.auditLog).values({
          teamId: input.id,
          actorId: `user:${ctx.operator.id}`,
          action: "team.signup_risk_review_resolved",
          target: `team:${input.id}`,
          data: { existingRestrictionsUnchanged: true },
        });
        return { changed: true };
      });
    }),

  detail: operatorProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .select(ROW)
      .from(t)
      .leftJoin(st, eq(st.teamId, t.id))
      .where(eq(t.id, input.id));
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    const viewEnabled = supportViewEnabled();
    const relay = customerSmtpRelay();
    const [owners, health, score, view, relayDomains] = await Promise.all([
      ctx.db
        .select({ email: schema.user.email, name: schema.user.name, role: schema.teamMembers.role })
        .from(schema.teamMembers)
        .innerJoin(schema.user, eq(schema.user.id, schema.teamMembers.userId))
        .where(eq(schema.teamMembers.teamId, input.id))
        .orderBy(asc(schema.teamMembers.createdAt)),
      fetchDeliverabilityHealth(ctx.db, input.id),
      fetchAccountScore(ctx.db, input.id),
      viewEnabled ? liveSupportViewForTeam(ctx.db, input.id) : null,
      relay
        ? ctx.db
            .select({
              id: schema.domains.id,
              name: schema.domains.name,
              region: schema.domains.region,
              status: schema.domains.status,
              relayEnabledAt: schema.domains.relayEnabledAt,
            })
            .from(schema.domains)
            .where(eq(schema.domains.teamId, input.id))
            .orderBy(asc(schema.domains.name))
        : [],
    ]);
    return {
      ...row,
      stripeSubscriptionUrl: row.stripeSubscriptionId
        ? `https://dashboard.stripe.com/${isLiveKey(env.STRIPE_SECRET_KEY ?? "") ? "" : "test/"}subscriptions/${row.stripeSubscriptionId}`
        : null,
      members: owners,
      guardrail: health.status,
      scoreTenths: score.scoreTenths,
      complaintRate7d: health.complaintRate,
      hardBounceRate7d: health.bounceRate,
      sent7d: health.sent,
      cloud: isCloudDeployment(),
      rungs: operatorRungs(),
      supportViewEnabled: viewEnabled,
      supportView: view ? { operatorEmail: view.operator.email, expiresAt: view.expiresAt } : null,
      // Only the relay's label reaches the browser, never its URL.
      relay: relay ? { name: relay.name, domains: relayDomains } : null,
    };
  }),

  /**
   * The operator's word that a domain is verified at the customer SMTP
   * relay's provider: while SES has paused the account, the domain's
   * transactional mail leaves through that relay instead of parking.
   * Offered only while CUSTOMER_SMTP_RELAY_URL is configured.
   */
  setDomainRelay: operatorProcedure
    .input(z.object({ id: z.uuid(), domainId: z.uuid(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const relay = customerSmtpRelay();
      if (!relay) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "relay_off" });
      const team = await loadTeam(ctx.db, input.id);
      const [domain] = await ctx.db
        .select({
          id: schema.domains.id,
          name: schema.domains.name,
          status: schema.domains.status,
          relayEnabledAt: schema.domains.relayEnabledAt,
        })
        .from(schema.domains)
        .where(and(eq(schema.domains.id, input.domainId), eq(schema.domains.teamId, team.id)));
      if (!domain) throw new TRPCError({ code: "NOT_FOUND" });
      if (input.enabled === (domain.relayEnabledAt !== null)) return;
      // A domain MepMail itself does not send from has nothing to relay.
      if (input.enabled && domain.status !== "verified") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "domain_not_verified" });
      }
      await ctx.db
        .update(schema.domains)
        .set({ relayEnabledAt: input.enabled ? new Date() : null })
        .where(eq(schema.domains.id, domain.id));
      await auditOperator(ctx, {
        teamId: team.id,
        action: input.enabled ? "team.domain_relay_enabled" : "team.domain_relay_disabled",
        target: { type: "domain", id: domain.id },
        // `name` labels the row in the team's own log, as every domain row
        // does; the console's detail skips it, so the domain rides again.
        metadata: { name: domain.name, domain: domain.name, relay: relay.name },
      });
      // The domain's mail parked since the pause began leaves now, not at the next drain.
      if (input.enabled) await kickQuotaDrain();
    }),

  /**
   * Opens the team's dashboard as its owner sees it, read-only, for 30
   * minutes: a grant on the operator's own session (never a session for the
   * owner), named by a cookie the context re-checks on every request. The
   * owners are emailed at once and both audit trails carry the start.
   */
  startSupportView: operatorProcedure
    .input(
      z.object({
        id: z.uuid(),
        reason: z.enum(SUPPORT_VIEW_REASONS),
        reference: z.string().trim().max(200).optional(),
        note: z.string().trim().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!supportViewEnabled()) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "support_view_off" });
      }
      // No nesting: a live view is left through its banner, not replaced from inside.
      if (ctx.supportView) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "support_view_live" });
      }
      const team = await loadTeam(ctx.db, input.id);
      const [own] = await ctx.db
        .select({ id: schema.teamMembers.id })
        .from(schema.teamMembers)
        .where(
          and(
            eq(schema.teamMembers.teamId, team.id),
            eq(schema.teamMembers.userId, ctx.operator.id),
          ),
        )
        .limit(1);
      if (own) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "own_team" });
      const reference = input.reference || null;
      if (supportViewNeedsReference(input.reason) && !reference) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "reference_required" });
      }
      let grant: Awaited<ReturnType<typeof startSupportView>>;
      try {
        grant = await startSupportView(ctx.db, {
          teamId: team.id,
          operatorUserId: ctx.operator.id,
          reason: input.reason,
          reference,
          note: input.note || null,
        });
      } catch (error) {
        // The one-live-view-per-operator index, tripped by two starts racing:
        // the other one won, so this reads as a view already being live.
        if (!isUniqueViolation(error)) throw error;
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "support_view_live" });
      }
      ctx.setSupportViewCookie?.({ id: grant.id, expiresAt: grant.expiresAt });
      const notified = await mailTeamOwners(
        ctx.db,
        team,
        "support.view_started",
        "/settings",
        (locale) => ({
          operator: `${ctx.operator.name} (${ctx.operator.email})`,
          reason: supportViewReasonText(locale, input.reason, reference),
          until: formatMailDateTime(locale, grant.expiresAt),
        }),
      );
      // Stamped only when a notice actually went out: a team with no owner to
      // write to, or an instance with no sender, must not read as notified.
      if (notified > 0) {
        await ctx.db
          .update(schema.supportViewGrants)
          .set({ notifiedAt: new Date() })
          .where(eq(schema.supportViewGrants.id, grant.id));
      }
      return { grantId: grant.id, expiresAt: grant.expiresAt };
    }),

  /** Write the plan directly; never for a team Stripe manages, and never touching Stripe. */
  changePlan: operatorProcedure
    .input(
      z.object({
        id: z.uuid(),
        plan: z.string().max(32),
        planQuota: z.number().int().positive().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.id);
      // A live subscription owns the plan; an ended one (canceled, never
      // completed) leaves the row to the operator.
      if (
        team.stripeSubscriptionId &&
        !["none", "canceled", "incomplete"].includes(team.planStatus)
      ) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "managed_by_stripe" });
      }
      const rung = operatorRungs().find(
        (r) => r.plan === input.plan && r.planQuota === input.planQuota,
      );
      if (!rung) throw new TRPCError({ code: "BAD_REQUEST", message: "unknown_rung" });
      const before = { plan: team.plan as string, planQuota: team.planQuota };
      if (before.plan === rung.plan && before.planQuota === rung.planQuota) return;
      await ctx.db
        .update(t)
        .set({ plan: rung.plan as Plan, planQuota: rung.planQuota })
        .where(eq(t.id, team.id));
      const typeChange = before.plan === "system" || rung.plan === "system";
      await auditOperator(ctx, {
        teamId: team.id,
        action: typeChange ? "team.type_changed" : "billing.plan_changed",
        target: { type: "team", id: team.id },
        metadata: {
          from: before,
          to: { plan: rung.plan, planQuota: rung.planQuota },
          name: team.name,
        },
      });
      const cloud = isCloudDeployment();
      if (
        raisesQuota(
          teamQuota(team, cloud),
          teamQuota({ ...team, plan: rung.plan as Plan, planQuota: rung.planQuota }, cloud),
        )
      ) {
        await kickQuotaDrain();
      }
    }),

  /** The daily ceiling beside the plan, and the broadcast switch. */
  adjustLimits: operatorProcedure
    .input(
      z.object({
        id: z.uuid(),
        dailySendCeiling: z.number().int().min(1).max(100_000_000).nullable(),
        broadcastsPaused: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.id);
      const now = new Date();
      const pausedBefore = team.broadcastsPausedByOperatorAt !== null;
      await ctx.db
        .update(t)
        .set({
          dailySendCeiling: input.dailySendCeiling,
          // An explicit operator decision supersedes the signup allowance,
          // including reaffirming the same number or restoring the plan limit.
          betaDailySendCeiling: null,
          broadcastsPausedByOperatorAt: input.broadcastsPaused
            ? (team.broadcastsPausedByOperatorAt ?? now)
            : null,
        })
        .where(eq(t.id, team.id));
      if (!input.broadcastsPaused) {
        // Lifting the hold lifts the monitor's pause too, as Resume does.
        await ctx.db
          .update(schema.teamMonitor)
          .set({ broadcastsPausedAt: null, broadcastsResumedAt: now })
          .where(
            and(
              eq(schema.teamMonitor.teamId, team.id),
              isNotNull(schema.teamMonitor.broadcastsPausedAt),
            ),
          );
      }
      await auditOperator(ctx, {
        teamId: team.id,
        action: "team.limits_updated",
        target: { type: "team", id: team.id },
        metadata: {
          name: team.name,
          dailySendCeiling: input.dailySendCeiling,
          broadcastsPaused: input.broadcastsPaused,
        },
      });
      if (pausedBefore !== input.broadcastsPaused) {
        await auditOperator(ctx, {
          teamId: team.id,
          action: input.broadcastsPaused ? "team.broadcasts_paused" : "team.broadcasts_resumed",
          target: { type: "team", id: team.id },
          metadata: { name: team.name, reason: "manual" },
        });
        if (input.broadcastsPaused) {
          await mailTeamOwners(ctx.db, team, "team.broadcasts_paused", "/broadcasts", (locale) => ({
            reason: reasonText(locale, "team.broadcasts_paused", "manual", undefined),
          }));
        }
      }
      const cloud = isCloudDeployment();
      // A lifted ceiling frees parked rows even when the month's capacity
      // reads the same, so the ceiling is compared on its own.
      const lifted =
        (input.dailySendCeiling ?? Number.POSITIVE_INFINITY) >
        (team.dailySendCeiling ?? Number.POSITIVE_INFINITY);
      if (
        lifted ||
        (team.betaDailySendCeiling !== null && input.dailySendCeiling === null) ||
        (pausedBefore && !input.broadcastsPaused) ||
        raisesQuota(
          teamQuota(team, cloud),
          teamQuota(
            { ...team, dailySendCeiling: input.dailySendCeiling, betaDailySendCeiling: null },
            cloud,
          ),
        )
      ) {
        await kickQuotaDrain();
      }
    }),

  pauseBroadcasts: operatorProcedure
    .input(
      z.object({
        id: z.uuid(),
        reason: z.enum(PAUSE_REASONS),
        note: z.string().trim().max(1000).optional(),
        notify: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.id);
      if (team.broadcastsPausedByOperatorAt) return;
      await ctx.db
        .update(t)
        .set({ broadcastsPausedByOperatorAt: new Date() })
        .where(eq(t.id, team.id));
      await auditOperator(ctx, {
        teamId: team.id,
        action: "team.broadcasts_paused",
        target: { type: "team", id: team.id },
        metadata: {
          name: team.name,
          reason: input.reason,
          note: input.note ?? null,
          notified: input.notify,
        },
      });
      if (input.notify) {
        await mailTeamOwners(ctx.db, team, "team.broadcasts_paused", "/broadcasts", (locale) => ({
          reason: reasonText(locale, "team.broadcasts_paused", input.reason, input.note),
        }));
      }
    }),

  resumeBroadcasts: operatorProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.id);
      if (!team.broadcastsPausedByOperatorAt) return;
      await ctx.db.update(t).set({ broadcastsPausedByOperatorAt: null }).where(eq(t.id, team.id));
      // The monitor's pause rides on the same hold; lifting one lifts both.
      await ctx.db
        .update(schema.teamMonitor)
        .set({ broadcastsPausedAt: null, broadcastsResumedAt: new Date() })
        .where(
          and(
            eq(schema.teamMonitor.teamId, team.id),
            isNotNull(schema.teamMonitor.broadcastsPausedAt),
          ),
        );
      await auditOperator(ctx, {
        teamId: team.id,
        action: "team.broadcasts_resumed",
        target: { type: "team", id: team.id },
        metadata: { name: team.name },
      });
      await kickQuotaDrain();
    }),

  /**
   * Every send refused until reinstated, with every credential and SES identity
   * of the team taken away; owners hear about it unless it is phishing.
   */
  suspend: operatorProcedure
    .input(
      z.object({
        id: z.uuid(),
        reason: z.enum(SUSPENSION_REASONS),
        note: z.string().trim().max(1000).optional(),
        notify: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.id);
      await ctx.db
        .update(t)
        .set({
          suspendedAt: team.suspendedAt ?? new Date(),
          suspensionReason: input.reason,
          suspensionNote: input.note ?? null,
        })
        .where(eq(t.id, team.id));
      // The flag stops the send lanes at once; the cut takes away every
      // credential and the SES identities, so nothing remains to send with.
      const cut = await cutTeamSendingAccess(ctx.db, team, {
        cancelParked: input.reason === "phishing",
      });
      const mailboxSubscription = mailboxRegistryEnabled()
        ? (
            await ctx.db
              .select({ status: schema.mailboxSubscriptions.status })
              .from(schema.mailboxSubscriptions)
              .where(eq(schema.mailboxSubscriptions.teamId, team.id))
          )[0]
        : undefined;
      const paidNoticeRequired =
        (team.plan !== "free" && team.plan !== "system") ||
        ["active", "trialing", "past_due"].includes(mailboxSubscription?.status ?? "");
      const notify = paidNoticeRequired || (input.notify && input.reason !== "phishing");
      let noticeRecipients = 0;
      let noticePreparationFailed = false;
      if (notify) {
        try {
          noticeRecipients = await mailTeamOwners(
            ctx.db,
            team,
            "team.suspended",
            "/support",
            (locale) => ({
              reason:
                input.reason === "phishing"
                  ? accountMailPhrase({ locale, kind: "team.suspended", key: "security_review" })
                  : reasonText(locale, "team.suspended", input.reason, input.note),
            }),
          );
        } catch {
          noticePreparationFailed = true;
          console.error("console: suspension notice could not be prepared", { teamId: team.id });
        }
      }
      await auditOperator(ctx, {
        teamId: team.id,
        action: "team.suspended",
        target: { type: "team", id: team.id },
        metadata: {
          name: team.name,
          reason: input.reason,
          note: input.note ?? null,
          notified: noticeRecipients > 0,
          notificationRequested: notify,
          notificationRecipients: noticeRecipients,
          notificationPreparationFailed: noticePreparationFailed,
          paidNoticeRequired,
          revokedApiKeys: cut.apiKeys,
          revokedAgentKeys: cut.agentKeys,
          canceledParked: cut.parkedCanceled,
          sesIdentitiesRemoved: cut.domains.filter((d) => d.removed).map((d) => d.name),
          sesIdentitiesFailed: cut.domains.filter((d) => !d.removed).map((d) => d.name),
        },
      });
      // The trust & safety list is the register of suspended teams, so a
      // suspension without a flag opens a manual one.
      await ctx.db
        .insert(schema.teamFlags)
        .values({
          teamId: team.id,
          reason: "manual",
          note: input.note ?? null,
          openedBy: ctx.operator.id,
        })
        .onConflictDoNothing();
      return {
        notice: {
          requested: notify,
          recipients: noticeRecipients,
          preparationFailed: noticePreparationFailed,
        },
      };
    }),

  reinstate: operatorProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.id);
      await ctx.db
        .update(t)
        .set({ suspendedAt: null, suspensionReason: null, suspensionNote: null })
        .where(eq(t.id, team.id));
      await auditOperator(ctx, {
        teamId: team.id,
        action: "team.reinstated",
        target: { type: "team", id: team.id },
        metadata: { name: team.name, reason: team.suspensionReason },
      });
      if (team.suspendedAt && team.suspensionReason !== "phishing") {
        await mailTeamOwners(ctx.db, team, "team.reinstated", "/emails", () => ({}));
      }
      await kickQuotaDrain();
    }),

  /**
   * Releases only the hold the operator actually observed. New content,
   * consent, quota and provider guards still apply to every parked delivery.
   */
  releaseSendReview: operatorProcedure
    .input(z.object({ id: z.uuid(), expectedHoldAt: z.iso.datetime() }))
    .mutation(async ({ ctx, input }) => {
      const team = await loadTeam(ctx.db, input.id);
      if (!isSendReviewHeld(team) || !team.sendReviewAt) return;
      if (team.suspendedAt) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "A suspended team cannot have its sending review released.",
        });
      }
      if (team.sendReviewAt.getTime() !== Date.parse(input.expectedHoldAt)) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "The sending review changed. Refresh and inspect the current hold before releasing it.",
        });
      }
      const now = new Date();
      const health = await fetchDeliverabilityHealth(ctx.db, team.id, { now });
      if (health.status === "paused") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "The rolling 24-hour sending safety policy is still paused.",
        });
      }
      const [released] = await ctx.db
        .update(t)
        .set({
          sendReviewAt: null,
          sendReviewReason: null,
          sendReviewNote: null,
          sendReviewNotifiedAt: null,
          sendReviewClearedAt: now,
          sendReviewClearedBy: ctx.operator.id,
        })
        .where(
          and(eq(t.id, team.id), sql`${t.sendReviewAt} = ${input.expectedHoldAt}::timestamptz`),
        )
        .returning({ id: t.id });
      // Concurrent console requests must not release or notify twice, nor
      // remove a newer hold using the state loaded before it was opened.
      if (!released) return;
      await ctx.db
        .update(schema.teamFlags)
        .set({ status: "cleared", clearedAt: now, clearedBy: ctx.operator.id })
        .where(
          and(
            eq(schema.teamFlags.teamId, team.id),
            eq(schema.teamFlags.status, "open"),
            eq(schema.teamFlags.reason, "review"),
          ),
        );
      let noticeRecipients = 0;
      let noticePreparationFailed = false;
      try {
        const current = await loadTeam(ctx.db, team.id);
        if (
          !current.suspendedAt &&
          current.suspensionReason !== "phishing" &&
          !current.sendReviewAt &&
          (await claimNotification(ctx.db, {
            teamId: team.id,
            kind: "review.released",
            periodKey: team.sendReviewAt.toISOString(),
          }))
        ) {
          noticeRecipients = await mailTeamOwners(
            ctx.db,
            team,
            "review.released",
            "/emails",
            (locale) => ({
              reason: sendReviewMailReason({
                locale,
                reason: team.sendReviewReason,
                note: team.sendReviewNote,
              }),
            }),
          );
        }
      } catch {
        noticePreparationFailed = true;
        console.error("console: review release notice could not be prepared", { teamId: team.id });
      }
      await auditOperator(ctx, {
        teamId: team.id,
        action: "team.send_review_released",
        target: { type: "team", id: team.id },
        metadata: {
          name: team.name,
          reason: team.sendReviewReason,
          notificationRecipients: noticeRecipients,
          notificationPreparationFailed: noticePreparationFailed,
        },
      });
      await kickQuotaDrain();
    }),
});
