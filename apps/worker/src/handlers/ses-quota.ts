import { SES_QUOTA_MARGIN } from "@millionsend/core";

export { SES_QUOTA_MARGIN };

/**
 * SES's rolling 24-hour sending quota, as the worker last read it. Sends hold
 * once the account is within the margin of its ceiling, so SES never has to
 * refuse them; a refusal that might be the quota rather than the rate asks
 * for a fresh read and lets the numbers decide.
 */
export interface SesQuotaGate {
  /**
   * True while the account is at (or within the margin of) its 24-hour quota
   * in the send's region. The quota is per region: a multi-region gate routes
   * on it, a single-region gate ignores it.
   */
  exhausted(region?: string): boolean;
  /** Re-read the account now; resolves to the new `exhausted`. A failed read keeps the last answer. */
  refresh(region?: string): Promise<boolean>;
  /** True while SES itself has paused the account in the region (enforcement, not the quota). */
  accountPaused?(region?: string): boolean;
}

/**
 * What the send lane asks beyond the total gate: bulk rows park on the
 * broadcast share and on a held region, transactional rows only at the
 * total; the notes feed the room ledger and the parked-transactional probe.
 * Every method is optional so a bare gate (tests, the drain) still fits.
 */
export interface SendQuotaControls extends SesQuotaGate {
  bulkExhausted?(region?: string): boolean;
  paused?(region?: string): boolean;
  noteBulkSent?(region?: string): void;
  noteTransactionalParked?(region?: string): void;
}

/**
 * `accountPaused` is SES's own stop (EnforcementStatus SHUTDOWN, or sending
 * disabled): every send would come back MessageRejected, so the gate reads it
 * as no room at all. Mail parks as queued_quota instead of failing, and the
 * drain lets it out once a probe sees the account sending again.
 */
export function createSesQuotaGate(
  read: () => Promise<{ max24h: number; sentLast24h: number; accountPaused?: boolean }>,
  onError: (err: unknown) => void = (err) => console.warn("SES quota read failed", err),
): SesQuotaGate {
  let exhausted = false;
  let paused = false;
  return {
    exhausted: () => exhausted,
    accountPaused: () => paused,
    async refresh() {
      try {
        const quota = await read();
        paused = quota.accountPaused === true;
        exhausted =
          paused || (quota.max24h > 0 && quota.sentLast24h >= quota.max24h * SES_QUOTA_MARGIN);
      } catch (err) {
        onError(err);
      }
      return exhausted;
    },
  };
}

const THROTTLE_NAMES = new Set(["TooManyRequestsException", "Throttling", "ThrottlingException"]);

/** SES refused for load: the rate, or the 24-hour quota (same exception, different message). */
export function isSesThrottle(err: unknown): boolean {
  return THROTTLE_NAMES.has((err as { name?: string }).name ?? "");
}

/** The refusal names the daily quota outright. The gate's numbers are the arbiter when it does not. */
export function isSesQuotaRefusal(err: unknown): boolean {
  return isSesThrottle(err) && /daily (message|sending) quota/i.test((err as Error).message ?? "");
}
