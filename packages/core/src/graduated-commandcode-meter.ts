import { JudgeError } from "./abuse-judge/types.js";

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
    { used: number; cap: number; remaining: number; resetAtMs: number }
  >;
  windowExceeded: unknown;
  availableCredits: number;
  autoReload: "unknown";
  exclusivity: "unknown";
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
        (input.orgId ? "?orgId=" + encodeURIComponent(input.orgId) : ""),
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
    !Object.hasOwn(w, "exceeded")
  )
    return refused();
  const windows = {} as CommandCodeMeter["windows"];
  for (const name of ["fiveHour", "weekly"] as const) {
    const v = object(w[name]);
    if (
      !v ||
      !nonnegative(v.used) ||
      !nonnegative(v.cap) ||
      !nonnegative(v.resetAt) ||
      v.cap <= 0 ||
      v.resetAt <= now()
    )
      return refused();
    windows[name] = {
      used: v.used,
      cap: v.cap,
      remaining: Math.max(0, v.cap - v.used),
      resetAtMs: v.resetAt,
    };
  }
  const end = now();
  if (end < start || end - start >= 5000) return refused();
  const remaining = c.monthlyCredits + c.purchasedCredits + c.freeCredits;
  if (!Number.isFinite(remaining)) return refused();
  return {
    schema: "mepmail.account-meter.v2",
    scope: "existing-key-personal-or-explicit-org-account-shared-not-exclusive",
    requestStartedAtMs: start,
    fetchedAtMs: end,
    latencyMs: end - start,
    ttlMs: 5000,
    httpStatus: response.status,
    credits: {
      monthlyRemaining: c.monthlyCredits,
      purchasedRemaining: c.purchasedCredits,
      freeRemaining: c.freeCredits,
      totalRemaining: remaining,
      belowThreshold: c.belowThreshold,
    },
    windows,
    windowExceeded: w.exceeded,
    availableCredits: Math.min(remaining, windows.fiveHour.remaining, windows.weekly.remaining),
    autoReload: "unknown",
    exclusivity: "unknown",
  };
}
