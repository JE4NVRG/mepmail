import {
  getGraduatedSendingContext,
  monthlySendDailyRate,
  PLAN_RUNG_KEYS,
  type PlanRungKey,
  rungByKey,
  teamQuota,
} from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { sql } from "drizzle-orm";

type RuntimeGraduatedContext = Awaited<ReturnType<typeof getGraduatedSendingContext>>;
type RuntimeCapacityReceipt = NonNullable<RuntimeGraduatedContext["capacityReceipt"]>;

import { sendNewPurchaseAvailability } from "./send-launch-offer.js";

export class SendSaleCapacityError extends Error {
  constructor(
    readonly reason: "capacity_unknown" | "capacity_insufficient" | "enterprise_required",
  ) {
    super(reason);
    this.name = "SendSaleCapacityError";
  }
}

export type SendSaleCapacitySource = () => Promise<RuntimeGraduatedContext>;
export interface SendSaleObservation {
  readonly context: RuntimeGraduatedContext;
}
const observations = new WeakSet<SendSaleObservation>();
/** Internal server source only. No HTTP or JSON payload can acquire this capability. */
export async function captureSendSaleCapacity(
  source: SendSaleCapacitySource = getGraduatedSendingContext,
): Promise<SendSaleObservation> {
  try {
    const context = await source();
    const observation = Object.freeze({ context });
    observations.add(observation);
    return observation;
  } catch {
    throw new SendSaleCapacityError("capacity_unknown");
  }
}
const resultRows = <T>(r: unknown): T[] => (Array.isArray(r) ? r : (r as { rows: T[] }).rows);
function freshObservation(
  observation: SendSaleObservation | undefined,
  now: number,
): RuntimeGraduatedContext {
  const c = observation?.context,
    j = c?.judgeEnvelope;
  if (
    !observation ||
    !observations.has(observation) ||
    !c ||
    !j ||
    j.accountKey !== "commandcode-primary" ||
    (j.throughputMode === "bounded-concurrency"
      ? j.rpm !== 120 || j.tenantRpm !== 120 || j.concurrency !== 2
      : j.rpm !== 3 || j.tenantRpm > 3 || j.concurrency !== 1) ||
    j.maxInputTokens !== 1000000 ||
    j.maxOutputTokens !== 2048 ||
    j.reservedCreditUnits !== 302457600 ||
    !Number.isSafeInteger(j.remainingCreditUnits) ||
    j.remainingCreditUnits < 0 ||
    !Number.isFinite(now) ||
    ![Date.parse(j.meterAt), Date.parse(j.meterExpiresAt)].every(Number.isFinite) ||
    Date.parse(j.meterAt) > now ||
    now >= Date.parse(j.meterExpiresAt) ||
    now - Date.parse(j.meterAt) >= 5000 ||
    Date.parse(j.meterExpiresAt) - Date.parse(j.meterAt) > 5000
  )
    throw new SendSaleCapacityError("capacity_unknown");
  return c;
}
export async function assertSendSaleObservationFresh(
  db: Db,
  observation: SendSaleObservation,
): Promise<void> {
  const [row] = resultRows<{ at: string }>(
    await db.execute(sql`select clock_timestamp()::text as at`),
  );
  freshObservation(observation, Date.parse(row?.at ?? ""));
}
const dailyOf = (key: PlanRungKey): number => {
  const rung = rungByKey(key);
  return rung.period === "month" ? monthlySendDailyRate(rung.included) : rung.included;
};

/** New acquisitions only. Signed contracts, renewals and cancellations never call this. */
export async function assertSendSaleCapacity(
  db: Db,
  teamId: string,
  rungKey: PlanRungKey,
  observation?: SendSaleObservation,
): Promise<void> {
  if (sendNewPurchaseAvailability(rungKey) === "enterprise")
    throw new SendSaleCapacityError("enterprise_required");
  const clock = await db.execute<{ at: string }>(sql`select clock_timestamp()::text as at`);
  const clockRows = Array.isArray(clock)
    ? clock
    : (clock as unknown as { rows: { at: string }[] }).rows;
  const now = Date.parse(clockRows[0]?.at ?? "");
  const context = freshObservation(observation, now);
  const j = context.judgeEnvelope!;
  // Same ROOT accounting fence as actual attempt reservation/reconciliation. No writes or settlement here.
  await db.execute(sql`select pg_advisory_xact_lock(18475923,48)`);
  const [budget] = resultRows<{
    held: string;
    debt: string;
    last_at: string | null;
    last_id: string | null;
    last_remaining: string | null;
  }>(
    await db.execute(sql`
    select coalesce((select sum(reserved_units) from sending_judge_attempts where account_key=${j.accountKey} and state<>'settled'),0)::text as held,
      coalesce((select debt_units from sending_judge_account_debt where account_key=${j.accountKey}),0)::text as debt,
      (select last_meter_at::text from sending_judge_account_debt where account_key=${j.accountKey}) as last_at,
      (select last_meter_id from sending_judge_account_debt where account_key=${j.accountKey}) as last_id,
      (select last_remaining_units::text from sending_judge_account_debt where account_key=${j.accountKey}) as last_remaining`),
  );
  const held = Number(budget?.held ?? NaN),
    debt = Number(budget?.debt ?? NaN);
  if (
    ![held, debt].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    (budget?.last_at && Date.parse(budget.last_at) > Date.parse(j.meterAt)) ||
    (budget?.last_id === j.meterId && Number(budget.last_remaining) !== j.remainingCreditUnits)
  )
    throw new SendSaleCapacityError("capacity_unknown");
  // New Send purchases use the explicitly chosen commercial region. Never
  // select an arbitrary existing domain or mutate its routing/region.
  const receipt = context.regionalCapacity?.["us-east-1"];
  const at = new Date(now);
  const teams = await db.select().from(schema.teams);
  // Held purchase promises survive transport resolution, PIX waiting and provider uncertainty.
  const holds = await db.execute<{ team_id: string; rung: string; target: string }>(sql`
    select h.team_id::text, h.data->>'rung' as rung, h.target from ${schema.auditLog} h
    where h.action='sending.sale_reserved' and not exists
      (select 1 from ${schema.auditLog} r where r.action='sending.sale_released' and r.team_id=h.team_id and r.target=h.target)`);
  const pendingRows = Array.isArray(holds)
    ? holds
    : (holds as unknown as { rows: { team_id: string; rung: string; target: string }[] }).rows;
  // Preserve pre-ledger pending attempts too; a resolved PIX transport is NOT a financial release.
  const pending = await db
    .select()
    .from(schema.sendCheckoutAttempts)
    .where(
      sql`${schema.sendCheckoutAttempts.status} <> 'resolved' or ${schema.sendCheckoutAttempts.parameters}->>'method' = 'pix'`,
    );
  const commitments = new Map<string, number>();
  for (const team of teams) {
    if (
      !["active", "trialing", "past_due", "unpaid", "paused", "incomplete"].includes(
        team.planStatus,
      )
    )
      continue;
    if (team.plan === "free" || team.plan === "system") continue;
    const quota = teamQuota(
      { ...team, dailySendCeiling: null, betaDailySendCeiling: null },
      true,
      at,
    );
    commitments.set(
      team.id,
      quota.kind === "month"
        ? monthlySendDailyRate(quota.included, { start: quota.periodStart, end: quota.periodEnd })
        : quota.kind === "day"
          ? quota.limit
          : 0,
    );
  }
  for (const hold of pendingRows) {
    if (!PLAN_RUNG_KEYS.includes(hold.rung as PlanRungKey))
      throw new SendSaleCapacityError("capacity_unknown");
    commitments.set(
      hold.team_id,
      Math.max(commitments.get(hold.team_id) ?? 0, dailyOf(hold.rung as PlanRungKey)),
    );
  }
  for (const attempt of pending) {
    if (!PLAN_RUNG_KEYS.includes(attempt.rung as PlanRungKey)) continue;
    // Own ledger lifecycle supersedes its transport-only status.
    if (pendingRows.some((h) => h.target === attempt.id)) continue;
    const released = await db.execute(
      sql`select 1 from ${schema.auditLog} where action='sending.sale_released' and team_id=${attempt.teamId} and target=${attempt.id} limit 1`,
    );
    const releasedRows = Array.isArray(released)
      ? released
      : (released as unknown as { rows: unknown[] }).rows;
    if (releasedRows.length) continue;
    commitments.set(
      attempt.teamId,
      Math.max(commitments.get(attempt.teamId) ?? 0, dailyOf(attempt.rung as PlanRungKey)),
    );
  }
  const existingDaily = commitments.get(teamId) ?? 0;
  commitments.delete(teamId);
  const meter = await db.execute<{ daily: string; minute: string }>(
    sql`select coalesce(sum((data->>'units')::bigint),0)::text as daily, coalesce(sum((data->>'units')::bigint) filter(where created_at > ${at}::timestamptz - interval '1 minute'),0)::text as minute from ${schema.auditLog} where action='sending.graduated_reserved' and created_at > ${at}::timestamptz - interval '24 hours' and created_at <= ${at}`,
  );
  const rows = Array.isArray(meter)
    ? meter
    : (meter as unknown as { rows: { daily: string; minute: string }[] }).rows;
  evaluateRuntimeSendSaleCapacity(
    receipt,
    context,
    now,
    Math.max(existingDaily, dailyOf(rungKey)),
    [...commitments.values()],
    Number(rows[0]?.daily ?? NaN),
    Number(rows[0]?.minute ?? NaN),
    Math.max(0, dailyOf(rungKey) - existingDaily),
    held,
    debt,
  );
  await assertSendSaleObservationFresh(db, observation!);
}

/** Entitlement is a usage cap, not dedicated infrastructure or immediate delivery.
 * New sales require healthy regional capacity and one currently funded admission.
 * Financial holds remain durable, but nominal plan caps do not reserve a month's
 * worst-case model frames or permanently partition the shared SES rolling quota.
 * Actual sends independently join ROOT holds/debt, concurrency and SES usage. */
export function evaluateRuntimeSendSaleCapacity(
  v: RuntimeCapacityReceipt | null | undefined,
  context: RuntimeGraduatedContext,
  now: number,
  requiredDaily: number,
  commitments: readonly number[],
  usedDaily: number,
  usedMinute: number,
  incrementalDaily: number,
  held: number,
  debt: number,
): void {
  const j = context.judgeEnvelope!;
  const c = v?.commercial,
    b = v?.buffers;
  const issued = Date.parse(v?.issuedAt ?? ""),
    expires = Date.parse(v?.expiresAt ?? "");
  const positive = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n > 0;
  if (
    !v ||
    v.version !== 1 ||
    v.region !== "us-east-1" ||
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    expires <= issued ||
    v.dailySemantics !== "nominal-flow-ceiling-not-resource-guarantee" ||
    b?.localCommitments !== "parent-ledger-required" ||
    !c ||
    Date.parse(v.issuedAt) > now ||
    now - Date.parse(v.issuedAt) >= 5000 ||
    now >= Date.parse(v.expiresAt) ||
    Date.parse(v.expiresAt) - Date.parse(v.issuedAt) > 5000 ||
    ![
      v.globalDaily,
      v.globalPerMinute,
      v.tenantPerMinute,
      v.judgePerMinute,
      c.judgeTokensPerMinute,
      c.worstCaseTokensPerAdmission,
      b.sesRemaining24Hours,
      b.modelCreditUnitsAfterSafetyFloor,
    ].every(positive) ||
    b.modelCreditUnitsAfterSafetyFloor !== j.remainingCreditUnits ||
    c.worstCaseTokensPerAdmission !== j.maxInputTokens + j.maxOutputTokens ||
    Math.round(c.worstCaseCostUsd * 1e9) !== j.reservedCreditUnits
  )
    throw new SendSaleCapacityError("capacity_unknown");
  if (
    ![requiredDaily, usedDaily, usedMinute, incrementalDaily, held, debt, ...commitments].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    throw new SendSaleCapacityError("capacity_unknown");
  // A finite current admission, not a forecast or a recurring funded SLA.
  const credits = j.reservedCreditUnits + held + debt;
  if (
    !Number.isSafeInteger(credits) ||
    requiredDaily > v.globalDaily ||
    usedDaily >= v.globalDaily ||
    usedMinute >= v.globalPerMinute ||
    b.sesRemaining24Hours < 1 ||
    credits > j.remainingCreditUnits
  )
    throw new SendSaleCapacityError("capacity_insufficient");
}

/** Legacy numeric fixture helper only; no production runtime caller reads its old ABI. */
/** Numeric, unit-consistent decision. Missing, malformed or stale evidence fails closed for new sales. */
export function evaluateSendSaleCapacity(
  raw: unknown,
  now: number,
  requiredDaily: number,
  commitments: readonly number[],
  usedDaily: number,
  usedMinute: number,
  incrementalDaily: number = requiredDaily,
): void {
  const v = raw as Record<string, unknown> | null;
  const c = (v?.commercial ?? null) as Record<string, unknown> | null;
  const issued = Date.parse(String(v?.issuedAt ?? ""));
  const expires = Date.parse(String(v?.expiresAt ?? ""));
  const ints = [
    v?.globalDaily,
    v?.globalPerMinute,
    v?.tenantPerMinute,
    v?.judgePerMinute,
    c?.judgeTokensPerMinute,
    c?.judgeDailyTokens,
    c?.worstCaseTokensPerAdmission,
  ];
  const fresh =
    Number.isFinite(now) &&
    Number.isFinite(issued) &&
    issued <= now &&
    now - issued <= 300000 &&
    Number.isFinite(expires) &&
    expires > now &&
    expires - issued <= 300000;
  const positive = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
  const money = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x > 0;
  if (
    !v ||
    v.version !== 1 ||
    !c ||
    !ints.every(positive) ||
    ![c.creditDailyUsd, c.worstCaseCostUsd].every(money) ||
    !fresh
  )
    throw new SendSaleCapacityError("capacity_unknown");
  if (
    ![requiredDaily, incrementalDaily, usedDaily, usedMinute, ...commitments].every(
      (x) => Number.isSafeInteger(x) && x >= 0,
    )
  )
    throw new SendSaleCapacityError("capacity_unknown");
  const n = (x: unknown) => x as number;
  const tokens = Math.floor(n(c.judgeTokensPerMinute) / n(c.worstCaseTokensPerAdmission));
  const credits = Math.floor(n(c.creditDailyUsd) / n(c.worstCaseCostUsd));
  // This is the shared account pool, not an individual tenant allocation.
  const sharedPerMinute = Math.min(n(v.globalPerMinute), n(v.judgePerMinute), tokens);
  const tenantPerMinute = Math.min(n(v.tenantPerMinute), sharedPerMinute);
  const dailyCapacity = Math.min(
    n(v.globalDaily),
    sharedPerMinute * 1440,
    Math.floor(n(c.judgeDailyTokens) / n(c.worstCaseTokensPerAdmission)),
    credits,
  );
  const committed = commitments.reduce((a, b) => a + b, 0);
  if (
    !Number.isSafeInteger(committed) ||
    requiredDaily > tenantPerMinute * 1440 ||
    committed + requiredDaily > dailyCapacity ||
    usedDaily + incrementalDaily > dailyCapacity ||
    usedMinute >= sharedPerMinute
  )
    throw new SendSaleCapacityError("capacity_insufficient");
}
