import { JudgeError } from "./abuse-judge/types.js";

/** Local conservative policy proof, not a provider aggregate interpretation.
 * Only the original adapter can bind this proof to an in-memory observation. */
export interface CommandCodeWindowHeadroomProof {
  readonly policy: "explicit-limited-dual-window-headroom.v1";
  readonly aggregateExceeded: null;
  readonly limited: true;
  readonly fiveHourExceeded: false;
  readonly weeklyExceeded: false;
}
export interface CommandCodeMeter {
  schema: "mepmail.account-meter.v2";
  scope: "existing-key-personal-or-explicit-org-account-shared-not-exclusive";
  requestStartedAtMs: number;
  fetchedAtMs: number;
  latencyMs: number;
  ttlMs: 5000;
  httpStatus: number;
  credits: {
    monthlyRemaining: number;
    purchasedRemaining: number;
    freeRemaining: number;
    totalRemaining: number;
    belowThreshold: boolean;
  };
  windows: Record<
    "fiveHour" | "weekly",
    {
      used: number;
      cap: number;
      remaining: number;
      resetAtMs: number;
      resetState?: "unscheduled-empty";
    }
  >;
  windowExceeded: unknown;
  windowHeadroomProof?: Readonly<CommandCodeWindowHeadroomProof>;
  availableCredits: number;
  autoReload: "unknown";
  exclusivity: "unknown";
}
// Not serializable, copyable or issuable through an HTTP DTO. This is adapter
// custody, not a capability granted by the public proof's structural shape.
const windowHeadroomProofs = new WeakMap<CommandCodeMeter, CommandCodeWindowHeadroomProof>();
export function hasCommandCodeWindowHeadroomProof(meter: CommandCodeMeter): boolean {
  const proof = windowHeadroomProofs.get(meter);
  return (
    proof !== undefined && meter.windowHeadroomProof === proof && meter.windowExceeded === null
  );
}
type MeterWindow = CommandCodeMeter["windows"]["fiveHour"];
const resetUnscheduledProofs = new WeakMap<CommandCodeMeter, ReadonlySet<MeterWindow>>();
/** Original, authenticated finite observation only. Zero is NOT a promised future
 * reset, refill, inactive-window contract, or permission carried by a DTO. */
export function hasCommandCodeResetUnscheduledProof(
  meter: CommandCodeMeter,
  window: MeterWindow,
): boolean {
  return (
    resetUnscheduledProofs.get(meter)?.has(window) === true &&
    window.resetState === "unscheduled-empty" &&
    window.resetAtMs === 0 &&
    window.used === 0 &&
    window.cap > 0 &&
    window.remaining === window.cap
  );
}
const nonnegative = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const refused = (): never => {
  throw new JudgeError("throttled", "fresh funded account meter unavailable");
};
/** Read-only original-custody adapter. No generation, credit purchase, auto-reload,
 * inferred entitlement, memoized balance, or ledger release. Account-pool debit
 * and reconciliation belong to the atomic Core ledger, not this meter read. */
export async function getCommandCodeMeter(input: {
  apiKey: string | undefined;
  orgId?: string | null;
  fetch?: typeof fetch;
  now?: () => number;
}): Promise<CommandCodeMeter> {
  if (!input.apiKey) return refused();
  const now = input.now ?? Date.now;
  const start = now();
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(
      "https://api.commandcode.ai/alpha/billing/credits" +
        (input.orgId ? `?orgId=${encodeURIComponent(input.orgId)}` : ""),
      {
        method: "GET",
        headers: { authorization: `Bearer ${input.apiKey}` },
        signal: AbortSignal.timeout(5000),
      },
    );
  } catch {
    return refused();
  }
  if (!response.ok) return refused();
  let payload: Record<string, unknown> | null;
  try {
    payload = object(await response.json());
  } catch {
    return refused();
  }
  const d = object(payload?.data) ?? payload;
  const c = object(d?.credits),
    w = object(d?.windowLimits);
  if (
    !c ||
    !w ||
    typeof c.belowThreshold !== "boolean" ||
    !nonnegative(c.monthlyCredits) ||
    !nonnegative(c.purchasedCredits) ||
    !nonnegative(c.freeCredits) ||
    !Object.hasOwn(w, "exceeded") ||
    (w.exceeded !== false && w.exceeded !== null) ||
    (Object.hasOwn(w, "limited") && typeof w.limited !== "boolean") ||
    (w.exceeded === null && w.limited !== true)
  )
    return refused();
  const windows = {} as CommandCodeMeter["windows"];
  const unscheduled = new Set<MeterWindow>();
  for (const name of ["fiveHour", "weekly"] as const) {
    const v = object(w[name]);
    // Local finite-inventory compatibility policy, NOT a provider sentinel
    // contract. No reset/refill is inferred. Both explicit headroom flags,
    // original adapter custody and the unchanged five-second origin are required.
    const emptyUnscheduled =
      v?.resetAt === 0 &&
      !Object.is(v.resetAt, -0) &&
      v.used === 0 &&
      w.limited === true &&
      object(w.fiveHour)?.exceeded === false &&
      object(w.weekly)?.exceeded === false;
    if (
      !v ||
      (w.exceeded === null && v.exceeded !== false) ||
      (Object.hasOwn(v, "exceeded") && v.exceeded !== false) ||
      !nonnegative(v.used) ||
      !nonnegative(v.cap) ||
      !nonnegative(v.resetAt) ||
      v.cap <= 0 ||
      v.used >= v.cap ||
      (v.resetAt <= now() && !emptyUnscheduled)
    )
      return refused();
    windows[name] = Object.freeze({
      used: v.used,
      cap: v.cap,
      remaining: Math.max(0, v.cap - v.used),
      resetAtMs: v.resetAt,
      ...(emptyUnscheduled ? { resetState: "unscheduled-empty" as const } : {}),
    });
    if (emptyUnscheduled) unscheduled.add(windows[name]);
  }
  const end = now();
  if (end < start || end - start >= 5000) return refused();
  const remaining = c.monthlyCredits + c.purchasedCredits + c.freeCredits;
  if (!Number.isFinite(remaining)) return refused();
  const meter: CommandCodeMeter = {
    schema: "mepmail.account-meter.v2",
    scope: "existing-key-personal-or-explicit-org-account-shared-not-exclusive",
    requestStartedAtMs: start,
    fetchedAtMs: end,
    latencyMs: end - start,
    ttlMs: 5000,
    httpStatus: response.status,
    credits: Object.freeze({
      monthlyRemaining: c.monthlyCredits,
      purchasedRemaining: c.purchasedCredits,
      freeRemaining: c.freeCredits,
      totalRemaining: remaining,
      belowThreshold: c.belowThreshold,
    }),
    windows: Object.freeze(windows),
    windowExceeded: w.exceeded,
    availableCredits: Math.min(remaining, windows.fiveHour.remaining, windows.weekly.remaining),
    autoReload: "unknown",
    exclusivity: "unknown",
  };
  if (w.exceeded === null) {
    const proof: CommandCodeWindowHeadroomProof = Object.freeze({
      policy: "explicit-limited-dual-window-headroom.v1",
      aggregateExceeded: null,
      limited: true,
      fiveHourExceeded: false,
      weeklyExceeded: false,
    });
    meter.windowHeadroomProof = proof;
    windowHeadroomProofs.set(meter, proof);
  }
  // Bind the proof to immutable raw/numeric/freshness evidence. A clone, JSON
  // round trip or hand-built proof cannot acquire this process-local custody.
  if (unscheduled.size) resetUnscheduledProofs.set(meter, unscheduled);
  return Object.freeze(meter);
}
