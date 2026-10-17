import { type Db, schema } from "@millionsend/db";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { verifiedSendBillingContract } from "./send-billing-contract.js";

export type SignupReviewBillingTeam = Pick<
  typeof schema.teams.$inferSelect,
  | "id"
  | "planStatus"
  | "stripeCustomerId"
  | "stripeSubscriptionId"
  | "currentPeriodStart"
  | "currentPeriodEnd"
  | "sendBillingContract"
>;
export type SignupReviewBillingMailbox = Pick<
  typeof schema.mailboxSubscriptions.$inferSelect,
  | "status"
  | "seats"
  | "stripeCustomerId"
  | "stripeSubscriptionId"
  | "stripePriceId"
  | "stripeSubscriptionItemId"
  | "unitAmount"
  | "currency"
  | "interval"
  | "livemode"
  | "periodStart"
  | "periodEnd"
>;

/** Current commercial terms are a separate fact; they are not evidence of a collected payment. */
export function hasActiveSignupReviewCommercialTerms(
  team: SignupReviewBillingTeam,
  mailbox: SignupReviewBillingMailbox | null | undefined,
  now: Date,
): boolean {
  if (
    (team.planStatus === "active" || team.planStatus === "past_due") &&
    verifiedSendBillingContract(
      team.sendBillingContract,
      {
        teamId: team.id,
        customerId: team.stripeCustomerId,
        subscriptionId: team.stripeSubscriptionId,
        financialPeriodStart: team.currentPeriodStart,
        financialPeriodEnd: team.currentPeriodEnd,
      },
      now,
    )
  )
    return true;
  return Boolean(
    mailbox &&
      (mailbox.status === "active" || mailbox.status === "past_due") &&
      mailbox.livemode === true &&
      mailbox.seats > 0 &&
      Number.isSafeInteger(mailbox.unitAmount) &&
      (mailbox.unitAmount ?? 0) > 0 &&
      /^[a-z]{3}$/.test(mailbox.currency ?? "") &&
      (mailbox.interval === "month" || mailbox.interval === "year") &&
      /^cus_[A-Za-z0-9_]+$/.test(mailbox.stripeCustomerId ?? "") &&
      /^sub_[A-Za-z0-9_]+$/.test(mailbox.stripeSubscriptionId ?? "") &&
      /^price_[A-Za-z0-9_]+$/.test(mailbox.stripePriceId ?? "") &&
      /^si_[A-Za-z0-9_]+$/.test(mailbox.stripeSubscriptionItemId ?? "") &&
      Number.isFinite(now.getTime()) &&
      mailbox.periodStart.getTime() <= now.getTime() &&
      now.getTime() < mailbox.periodEnd.getTime(),
  );
}

export type SignupReviewPaymentStatus = "confirmed" | "not_observed" | "unknown";
export type SignupReviewPaymentReader = (
  customerIds: string[],
) => Promise<Record<string, SignupReviewPaymentStatus>>;

/** Only provider-confirmed positive payment is paid; terms or missing evidence never suffice. */
export function isSignupReviewPaidTeam(paymentStatus: SignupReviewPaymentStatus): boolean {
  return paymentStatus === "confirmed";
}

export interface SignupRiskReviewCandidate {
  teamId: string;
  level: "good" | "sandbox" | "hold" | null;
  reasons: string[];
  policyVersion: number | null;
  profileCreatedAt: Date | null;
  sendReviewAt: Date | null;
  suspendedAt: Date | null;
  reviewRequestedAt: Date | null;
  /** Provider-confirmed payment history, including a subscription that later ended. */
  paid: boolean;
  paidHistory: boolean;
  paymentStatus: SignupReviewPaymentStatus;
  /** Terms alone must never be labelled as a confirmed payment. */
  commercialActive: boolean;
  domains: string[];
}

/** Only DNS names can leave the review source; no email/local part, URL, IP or free text. */
export function signupReviewDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const domain = value.toLowerCase().replace(/\.$/, "");
  if (
    domain.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)
  )
    return null;
  return domain;
}

/**
 * One read-only source for the operator queue and its daily digest. Legacy holds
 * are derived in place: listing never enrolls, clears, backfills or releases a team.
 * Private review context and signup signals are deliberately not selected.
 */
export async function listSignupRiskReviewCandidates(
  db: Db,
  now = new Date(),
  readPayments?: SignupReviewPaymentReader,
): Promise<SignupRiskReviewCandidate[]> {
  const t = schema.teams;
  const p = schema.teamSignupRisk;
  const r = schema.signupRiskReviewRequests;
  const m = schema.mailboxSubscriptions;
  const rows = await db
    .select({
      team: {
        id: t.id,
        planStatus: t.planStatus,
        stripeCustomerId: t.stripeCustomerId,
        stripeSubscriptionId: t.stripeSubscriptionId,
        currentPeriodStart: t.currentPeriodStart,
        currentPeriodEnd: t.currentPeriodEnd,
        sendBillingContract: t.sendBillingContract,
      },
      level: p.level,
      clearedAt: p.clearedAt,
      reasons: p.reasons,
      policyVersion: p.policyVersion,
      profileCreatedAt: p.createdAt,
      signupDomain: sql<string | null>`${p.signals}->>'domain'`,
      sendReviewAt: t.sendReviewAt,
      suspendedAt: t.suspendedAt,
      reviewRequestedAt: r.requestedAt,
      reviewResolvedAt: r.resolvedAt,
    })
    .from(t)
    .leftJoin(p, eq(p.teamId, t.id))
    .leftJoin(r, eq(r.teamId, t.id))
    .where(
      or(
        and(isNull(p.clearedAt), inArray(p.level, ["sandbox", "hold"])),
        isNotNull(t.sendReviewAt),
        isNotNull(t.suspendedAt),
        and(isNotNull(r.requestedAt), isNull(r.resolvedAt)),
      ),
    );
  if (!rows.length) return [];
  const ids = rows.map((row) => row.team.id);
  // Correio is an optional extension: the queue must still work on Send-only instances.
  const [extension] = await db
    .select({ installed: sql<boolean>`to_regclass('public.mailbox_subscriptions') is not null` })
    .from(sql`(select 1) as mailbox_extension`);
  const mailboxes = extension?.installed
    ? await db
        .select({
          teamId: m.teamId,
          status: m.status,
          seats: m.seats,
          stripeCustomerId: m.stripeCustomerId,
          stripeSubscriptionId: m.stripeSubscriptionId,
          stripePriceId: m.stripePriceId,
          stripeSubscriptionItemId: m.stripeSubscriptionItemId,
          unitAmount: m.unitAmount,
          currency: m.currency,
          interval: m.interval,
          livemode: m.livemode,
          periodStart: m.periodStart,
          periodEnd: m.periodEnd,
        })
        .from(m)
        .where(inArray(m.teamId, ids))
    : [];
  const mailboxByTeam = new Map(mailboxes.map((mailbox) => [mailbox.teamId, mailbox]));
  const customerIds = (team: SignupReviewBillingTeam) => [
    ...new Set(
      [team.stripeCustomerId, mailboxByTeam.get(team.id)?.stripeCustomerId].filter(
        (id): id is string => typeof id === "string" && /^cus_[A-Za-z0-9_]+$/.test(id),
      ),
    ),
  ];
  const protectedIds = [...new Set(rows.flatMap((row) => customerIds(row.team)))];
  let paymentEvidence: Record<string, SignupReviewPaymentStatus> = {};
  if (readPayments && protectedIds.length) {
    try {
      paymentEvidence = await readPayments(protectedIds);
    } catch {
      /* Unknown is not non-payment. */
    }
  }
  const paymentStatusOf = (team: SignupReviewBillingTeam): SignupReviewPaymentStatus => {
    const ids = customerIds(team);
    if (!ids.length) return "unknown";
    const statuses = ids.map((id) => paymentEvidence[id]);
    if (statuses.includes("confirmed")) return "confirmed";
    return statuses.every((status) => status === "not_observed") ? "not_observed" : "unknown";
  };
  const domains = await db
    .select({ teamId: schema.domains.teamId, name: schema.domains.name })
    .from(schema.domains)
    .where(inArray(schema.domains.teamId, ids));
  const byTeam = new Map<string, Set<string>>();
  for (const row of domains) {
    const domain = signupReviewDomain(row.name);
    if (!domain) continue;
    const names = byTeam.get(row.teamId) ?? new Set<string>();
    names.add(domain);
    byTeam.set(row.teamId, names);
  }
  return rows.map((row) => {
    const names = byTeam.get(row.team.id) ?? new Set<string>();
    const signupDomain = signupReviewDomain(row.signupDomain);
    if (signupDomain) names.add(signupDomain);
    const paymentStatus = paymentStatusOf(row.team);
    const paidHistory = isSignupReviewPaidTeam(paymentStatus);
    return {
      teamId: row.team.id,
      level: row.clearedAt ? null : row.level,
      reasons: row.clearedAt ? [] : (row.reasons ?? []),
      policyVersion: row.policyVersion,
      profileCreatedAt: row.profileCreatedAt,
      sendReviewAt: row.sendReviewAt,
      suspendedAt: row.suspendedAt,
      reviewRequestedAt: row.reviewResolvedAt ? null : row.reviewRequestedAt,
      paid: paidHistory,
      paidHistory,
      paymentStatus,
      commercialActive: hasActiveSignupReviewCommercialTerms(
        row.team,
        mailboxByTeam.get(row.team.id),
        now,
      ),
      domains: [...names].sort(),
    };
  });
}
