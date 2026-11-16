import { GetAccountCommand, type GetAccountResponse, SESv2Client } from "@aws-sdk/client-sesv2";
import type { CommandCodeMeter } from "./graduated-commandcode-meter.js";
import type { CapacityReceipt } from "./graduated-sending-policy.js";

export type CapacityRegion = "us-east-1" | "eu-west-1";
export const CAPACITY_REGIONS = ["us-east-1", "eu-west-1"] as const;
const TTL_MS = 5000;
const FRAME_TOKENS = 1002048;
const FRAME_CREDIT_UNITS = 302457600;
const TOKEN_RESERVATIONS_PER_MINUTE = 3 * FRAME_TOKENS;
const MAX = Number.MAX_SAFE_INTEGER;
/** Resource inventory at the observation origin, NOT a flow/day allowance.
 * The parent must atomically reconcile its held reservations and unsettled debt;
 * neither a meter decline nor a fresh snapshot settles either commitment. */
export interface RuntimeCapacityBuffers {
  /** Useful nominal SES quota minus the separately observed rolling SES usage.
   * Compare against NEW recipients, never subtract already-counted SES usage again.
   * External/unmapped sends and local in-flight reservations remain caller concerns. */
  sesRemaining24Hours: number;
  /** Original shared CommandCode inventory, after its five-dollar safety floor,
   * BEFORE any local held reservations or unsettled debt are accounted for. */
  modelCreditUnitsAfterSafetyFloor: number;
  modelFramesBeforeLocalCommitments: number;
  localCommitments: "parent-ledger-required";
}
export interface RuntimeCapacityReceipt extends CapacityReceipt {
  issuedAt: string;
  region: CapacityRegion;
  /** globalDaily is only a nominal operational flow ceiling. It is neither a
   * resource balance nor a promise that this many recipients can be funded. */
  dailySemantics: "nominal-flow-ceiling-not-resource-guarantee";
  commercial: {
    /** Reservation units per minute, not vendor TPM entitlement. */
    judgeTokensPerMinute: number;
    nominalJudgeDailyTokens: number;
    worstCaseTokensPerAdmission: number;
    worstCaseCostUsd: number;
  };
  observations: {
    sesMax24HourSend: number;
    sesSentLast24Hours: number;
    sesUsefulNominalDaily: number;
    sesMaxSendRate: number;
    modelBudgetScope: "original-primary-shared-not-exclusive";
  };
  buffers: Readonly<RuntimeCapacityBuffers>;
}
export interface RuntimeCapacityObservation {
  requestStartedAtMs: number;
  expiresAtMs: number;
  meter: CommandCodeMeter;
  remainingCreditUnits: number;
  regionalCapacity: Readonly<Record<CapacityRegion, RuntimeCapacityReceipt | null>>;
}
export interface CapacityObservationDependencies {
  now?: () => number;
  readAccount?: (region: CapacityRegion, signal: AbortSignal) => Promise<GetAccountResponse>;
}
const integer = (n: unknown, positive = false): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= (positive ? 1 : 0);
const finite = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= MAX;
export function fundedCreditUnits(meter: CommandCodeMeter, now: number): number {
  if (
    !integer(meter.requestStartedAtMs) ||
    !integer(meter.fetchedAtMs) ||
    meter.requestStartedAtMs > now ||
    meter.fetchedAtMs < meter.requestStartedAtMs ||
    meter.fetchedAtMs > now ||
    now - meter.requestStartedAtMs >= TTL_MS ||
    meter.windowExceeded !== false ||
    !finite(meter.availableCredits)
  )
    throw new Error("capacity_unavailable");
  for (const w of [meter.windows.fiveHour, meter.windows.weekly]) {
    if (
      !finite(w.used) ||
      !finite(w.cap) ||
      !finite(w.remaining) ||
      w.cap <= 0 ||
      w.used >= w.cap ||
      w.remaining <= 0 ||
      !integer(w.resetAtMs) ||
      w.resetAtMs <= now
    )
      throw new Error("capacity_unavailable");
  }
  const units = Math.floor(Math.max(0, meter.availableCredits - 5) * 1e9);
  if (!integer(units, true) || units < FRAME_CREDIT_UNITS) throw new Error("capacity_unavailable");
  return units;
}
/** Default SDK custody/provider chain is retained. No credential fields, profiles,
 * AWS environment rewriting, account discovery or writes are introduced here. */
async function readOriginalAccount(
  region: CapacityRegion,
  signal: AbortSignal,
): Promise<GetAccountResponse> {
  const client = new SESv2Client({ region, maxAttempts: 1 });
  try {
    return await client.send(new GetAccountCommand({}), { abortSignal: signal });
  } finally {
    client.destroy();
  }
}
function receipt(
  region: CapacityRegion,
  account: GetAccountResponse | null,
  issued: number,
  expires: number,
  units: number,
): RuntimeCapacityReceipt | null {
  const q = account?.SendQuota;
  if (
    account?.SendingEnabled !== true ||
    account.ProductionAccessEnabled !== true ||
    account.EnforcementStatus !== "HEALTHY" ||
    !q ||
    !integer(q.Max24HourSend, true) ||
    !integer(q.SentLast24Hours) ||
    !finite(q.MaxSendRate) ||
    q.MaxSendRate <= 0
  )
    return null;
  const nominal = Math.floor(q.Max24HourSend * 0.98);
  const remaining = Math.max(0, nominal - q.SentLast24Hours);
  const minute = Math.min(3, Math.floor(q.MaxSendRate * 60 * 0.98));
  const fundedAdmissions = Math.floor(units / FRAME_CREDIT_UNITS);
  // Flow ceilings and stocks have different dimensions. Neither SES remaining
  // headroom nor the current model inventory is an absolute per-day allowance.
  const daily = Math.min(nominal, minute * 1440);
  const nominalJudgeDailyTokens = TOKEN_RESERVATIONS_PER_MINUTE * 1440;
  if (
    ![nominal, remaining, minute, daily, nominalJudgeDailyTokens, fundedAdmissions].every((n) =>
      integer(n, true),
    )
  )
    return null;
  return Object.freeze({
    version: 1,
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(expires).toISOString(),
    region,
    globalDaily: daily,
    globalPerMinute: minute,
    tenantPerMinute: minute,
    judgePerMinute: 3,
    dailySemantics: "nominal-flow-ceiling-not-resource-guarantee",
    commercial: Object.freeze({
      judgeTokensPerMinute: TOKEN_RESERVATIONS_PER_MINUTE,
      nominalJudgeDailyTokens,
      worstCaseTokensPerAdmission: FRAME_TOKENS,
      worstCaseCostUsd: FRAME_CREDIT_UNITS / 1e9,
    }),
    observations: Object.freeze({
      sesMax24HourSend: q.Max24HourSend,
      sesSentLast24Hours: q.SentLast24Hours,
      sesUsefulNominalDaily: nominal,
      sesMaxSendRate: q.MaxSendRate,
      modelBudgetScope: "original-primary-shared-not-exclusive",
    }),
    buffers: Object.freeze({
      sesRemaining24Hours: remaining,
      modelCreditUnitsAfterSafetyFloor: units,
      modelFramesBeforeLocalCommitments: fundedAdmissions,
      localCommitments: "parent-ledger-required",
    }),
  });
}
/** One static original-product consumer, two nonsecret regional slots. Origin,
 * not response completion or a cache hit, starts the immutable five-second TTL. */
export function createRuntimeCapacityObserver(deps: CapacityObservationDependencies = {}) {
  const now = deps.now ?? Date.now;
  const readAccount = deps.readAccount ?? readOriginalAccount;
  let cached: RuntimeCapacityObservation | undefined;
  let pending: Promise<RuntimeCapacityObservation> | undefined;
  return async (
    readMeter: () => Promise<CommandCodeMeter>,
  ): Promise<RuntimeCapacityObservation> => {
    const at = now();
    if (cached && at >= cached.requestStartedAtMs && at < cached.expiresAtMs) return cached;
    if (pending) return pending;
    const start = at;
    // Set both bounds before ANY provider I/O. An expired in-flight read is never renewed.
    const deadline = start + TTL_MS;
    pending = (async () => {
      const signal = AbortSignal.timeout(TTL_MS - 500);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const accounts = Promise.all(
          CAPACITY_REGIONS.map(async (region) => {
            try {
              return await readAccount(region, signal);
            } catch {
              return null;
            }
          }),
        );
        const [meter, regional] = await Promise.race([
          Promise.all([readMeter(), accounts]),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("capacity_unavailable")), TTL_MS - 250);
          }),
        ]);
        const end = now();
        const units = fundedCreditUnits(meter, end);
        const origin = Math.min(start, meter.requestStartedAtMs);
        const expires = Math.min(deadline, meter.requestStartedAtMs + TTL_MS);
        if (!integer(start) || end < start || end >= expires)
          throw new Error("capacity_unavailable");
        cached = Object.freeze({
          requestStartedAtMs: origin,
          expiresAtMs: expires,
          meter,
          remainingCreditUnits: units,
          regionalCapacity: Object.freeze({
            "us-east-1": receipt("us-east-1", regional[0] ?? null, origin, expires, units),
            "eu-west-1": receipt("eu-west-1", regional[1] ?? null, origin, expires, units),
          }),
        });
        return cached;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}
