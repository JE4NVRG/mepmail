/** Server-owned policy inputs only. No account age, payment or admin bypass. */
export type SendingState =
  | "unverified"
  | "verified"
  | "domain_verified"
  | "established"
  | "suspended";
export interface CapacityReceipt {
  version: 1;
  expiresAt: string;
  globalPerMinute: number;
  globalDaily: number;
  tenantPerMinute: number;
  /** Measured judge budget, expressed as worst-case admission units. */
  judgePerMinute: number;
}
export function parseCapacityReceipt(raw: string | undefined, now: Date): CapacityReceipt | null {
  if (!raw) return null;
  let v: CapacityReceipt;
  try {
    v = JSON.parse(raw) as CapacityReceipt;
  } catch {
    return null;
  }
  if (
    !v ||
    v.version !== 1 ||
    !Number.isFinite(Date.parse(v.expiresAt)) ||
    Date.parse(v.expiresAt) <= now.getTime()
  )
    return null;
  if (
    ![v.globalPerMinute, v.globalDaily, v.tenantPerMinute, v.judgePerMinute].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    )
  )
    return null;
  return v;
}
export interface GraduatedInputs {
  principalEmail: string | null;
  principalVerified: boolean;
  dnsReady: boolean;
  suspended: boolean;
  reviewHeld: boolean;
  plan: string;
  planDaily: number;
  nominalMonthly: number | null;
  /** Real confirmed active clean UTC days after DNS verification / latest adverse outcome. */
  cleanSendingDays: number;
  operatorCeiling: number | null;
  sent24h: number;
  hardBounced24h: number;
  complained24h: number;
}
export interface TenantReputationDto {
  state: SendingState;
  plan: string;
  nominalMonthly: number | null;
  effectiveDaily: number;
  effectivePerMinute: number | null;
  dailyUsed: number;
  dailyLeft: number;
  newRecipientWindows: Array<{
    hours: 1 | 24 | 168;
    limit: number;
    used: number;
    left: number;
    retryAfterSeconds: number;
  }>;
  complaintRate: number | null;
  bounceRate: number | null;
  reputationDenominator24h: number;
  warmupPercent: 25 | 50 | 75 | 100;
  nextEligibleAt: string | null;
  nextDaily: number | null;
  campaignEligible: boolean;
  capacityKnown: boolean;
  capacityAvailable: boolean;
  reason:
    | "capacity_unavailable"
    | "sending_suspended"
    | "review_required"
    | "verify_identity"
    | "verify_domain"
    | "warming"
    | "ready";
  nextStep:
    | "verify_identity"
    | "verify_domain"
    | "continue_clean_sending"
    | "request_review"
    | "retry_later"
    | "none";
}
export const NEW_RECIPIENT_WINDOWS = [
  { hours: 1, limit: 3 },
  { hours: 24, limit: 5 },
  { hours: 168, limit: 10 },
] as const;
/** One circuit predicate for both projection and durable provider-event handling. */
export function tenantSendingMinuteCeiling(
  state: SendingState,
  planDaily: number,
  warmupPercent: number,
): number {
  if (state === "suspended") return 0;
  const daily =
    state === "unverified"
      ? 10
      : state === "verified"
        ? 100
        : Number.isSafeInteger(planDaily) && planDaily > 0
          ? Math.floor((planDaily * (state === "established" ? 100 : warmupPercent)) / 100)
          : 0;
  return daily > 0 ? Math.max(1, Math.ceil(daily / 1440)) : 0;
}
/** A fresh credit inventory is an additional deliverable buffer, not an absolute
 * daily quota. Completed attempts release unused reserve; they do not reduce
 * an otherwise unchanged state/plan entitlement. */
export function budgetBackedDailyCeiling(
  nominal: number,
  used: number,
  availableFrames: number,
): number {
  if (![nominal, used, availableFrames].every((n) => Number.isSafeInteger(n) && n >= 0))
    throw new Error("capacity_accounting_unknown");
  return Math.min(nominal, Math.min(Number.MAX_SAFE_INTEGER, used + availableFrames));
}
export function reputationCircuitTriggered(c: {
  sent: number;
  hardBounced: number;
  complained: number;
}): boolean {
  return c.sent > 0
    ? c.complained / c.sent > 0.001 || c.hardBounced / c.sent > 0.05
    : c.hardBounced > 0 || c.complained > 0;
}
export function graduatedPolicy(
  i: GraduatedInputs,
  capacity: CapacityReceipt | null,
): TenantReputationDto {
  if (
    ![i.planDaily, i.cleanSendingDays, i.sent24h, i.hardBounced24h, i.complained24h].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    (i.operatorCeiling !== null &&
      (!Number.isSafeInteger(i.operatorCeiling) || i.operatorCeiling < 0))
  )
    throw new Error("graduated_state_invalid");
  const complaintRate = i.sent24h > 0 ? i.complained24h / i.sent24h : null;
  const bounceRate = i.sent24h > 0 ? i.hardBounced24h / i.sent24h : null;
  const circuit = reputationCircuitTriggered({
    sent: i.sent24h,
    hardBounced: i.hardBounced24h,
    complained: i.complained24h,
  });
  const warmupPercent = Math.min(100, 25 + Math.floor(i.cleanSendingDays / 7) * 25) as
    | 25
    | 50
    | 75
    | 100;
  const state: SendingState =
    i.suspended || circuit
      ? "suspended"
      : !i.principalVerified
        ? "unverified"
        : !i.dnsReady
          ? "verified"
          : warmupPercent === 100 &&
              i.cleanSendingDays >= 14 &&
              complaintRate !== null &&
              bounceRate !== null &&
              complaintRate < 0.001 &&
              bounceRate < 0.05
            ? "established"
            : "domain_verified";
  const rawDaily =
    state === "suspended" || i.reviewHeld || !i.principalEmail
      ? 0
      : state === "unverified"
        ? 10
        : state === "verified"
          ? 100
          : Math.floor((i.planDaily * warmupPercent) / 100);
  const effectiveDaily = Math.min(
    rawDaily,
    i.operatorCeiling ?? rawDaily,
    capacity?.globalDaily ?? rawDaily,
    capacity ? Math.min(capacity.tenantPerMinute, capacity.globalPerMinute) * 1440 : rawDaily,
  );
  const reason: TenantReputationDto["reason"] =
    state === "suspended"
      ? "sending_suspended"
      : i.reviewHeld || !i.principalEmail
        ? "review_required"
        : !capacity
          ? "capacity_unavailable"
          : state === "unverified"
            ? "verify_identity"
            : state === "verified"
              ? "verify_domain"
              : state === "domain_verified"
                ? "warming"
                : "ready";
  return {
    state,
    plan: i.plan,
    nominalMonthly: i.nominalMonthly,
    effectiveDaily,
    effectivePerMinute: capacity
      ? Math.min(capacity.tenantPerMinute, capacity.globalPerMinute)
      : null,
    dailyUsed: 0,
    dailyLeft: effectiveDaily,
    newRecipientWindows:
      state === "verified"
        ? NEW_RECIPIENT_WINDOWS.map((w) => ({ ...w, used: 0, left: w.limit, retryAfterSeconds: 0 }))
        : [],
    complaintRate,
    bounceRate,
    reputationDenominator24h: i.sent24h,
    warmupPercent,
    nextEligibleAt: null,
    nextDaily:
      state === "domain_verified" && warmupPercent < 100
        ? Math.floor((i.planDaily * (warmupPercent + 25)) / 100)
        : null,
    campaignEligible: state === "established" && !i.reviewHeld,
    capacityKnown: capacity !== null,
    capacityAvailable: capacity !== null && effectiveDaily > 0,
    reason,
    nextStep:
      reason === "sending_suspended" || reason === "review_required"
        ? "request_review"
        : reason === "capacity_unavailable"
          ? "retry_later"
          : reason === "verify_identity"
            ? "verify_identity"
            : reason === "verify_domain"
              ? "verify_domain"
              : reason === "warming"
                ? "continue_clean_sending"
                : "none",
  };
}
export type AdmissionReason =
  | "capacity_unavailable"
  | "sending_suspended"
  | "review_required"
  | "registered_recipient_required"
  | "registered_sender_required"
  | "campaign_warming"
  | "daily_limit"
  | "minute_limit"
  | "new_recipient_limit";
const MESSAGES: Record<AdmissionReason, { en: string; pt: string }> = {
  capacity_unavailable: {
    en: "Sending capacity is temporarily unavailable. Retry later.",
    pt: "A capacidade de envio está temporariamente indisponível. Tente novamente mais tarde.",
  },
  sending_suspended: {
    en: "Sending is suspended. Your data is preserved; request a review.",
    pt: "O envio está suspenso. Seus dados estão preservados; solicite uma revisão.",
  },
  review_required: {
    en: "Sending is held for account review.",
    pt: "O envio aguarda revisão da conta.",
  },
  registered_recipient_required: {
    en: "Before verification, send only to your registered email address.",
    pt: "Antes da verificação, envie apenas ao seu e-mail de cadastro.",
  },
  registered_sender_required: {
    en: "Use your registered identity with an authorized sending address.",
    pt: "Use sua identidade de cadastro com um remetente autorizado.",
  },
  campaign_warming: {
    en: "Campaigns require a verified domain and completed clean sending warm-up.",
    pt: "Campanhas exigem domínio verificado e aquecimento concluído com envios limpos.",
  },
  daily_limit: {
    en: "The effective daily sending limit has been reached.",
    pt: "O limite diário efetivo de envio foi atingido.",
  },
  minute_limit: {
    en: "The sending rate limit has been reached. Retry later.",
    pt: "O limite de frequência de envio foi atingido. Tente novamente mais tarde.",
  },
  new_recipient_limit: {
    en: "The new-recipient warm-up limit has been reached.",
    pt: "O limite de novos destinatários durante o aquecimento foi atingido.",
  },
};
export class GraduatedAdmissionError extends Error {
  readonly status: 403 | 429;
  readonly code: "message_rejected" | "rate_limit_exceeded";
  readonly publicReason: { en: string; pt: string };
  constructor(
    readonly reason: AdmissionReason,
    readonly plan: string,
    readonly effectiveDaily: number,
    readonly safeRetryAfter: number = 60,
  ) {
    super(MESSAGES[reason].en);
    this.name = "GraduatedAdmissionError";
    this.status = [
      "capacity_unavailable",
      "daily_limit",
      "minute_limit",
      "new_recipient_limit",
    ].includes(reason)
      ? 429
      : 403;
    this.code = this.status === 429 ? "rate_limit_exceeded" : "message_rejected";
    this.publicReason = MESSAGES[reason];
  }
}
