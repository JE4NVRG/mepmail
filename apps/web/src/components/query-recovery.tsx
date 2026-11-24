"use client";

import type { RecoveryPhase } from "@/lib/query-recovery";

/**
 * A retry stays reachable when a read fails, pauses, or stalls past retryDelayMs,
 * avoiding a distracting "Try again" flash during quick initial loads.
 */
export function QueryRecoveryNotice({
  phase,
  message,
  retryLabel,
  retry,
  className,
  retryDelayMs = 0,
}: {
  phase: RecoveryPhase;
  message: string;
  retryLabel: string;
  retry: () => Promise<unknown>;
  className?: string | undefined;
  retryDelayMs?: number | undefined;
}) {
  const delayRetry = retryDelayMs > 0 && (phase === "loading" || phase === "refreshing");
  return (
    <div className={className} role={phase === "error" ? "alert" : "status"}>
      <p>{message}</p>
      <button
        type="button"
        className="ms-btn ms-btn-ghost ms-btn-sm"
        aria-busy={phase === "loading" || phase === "refreshing"}
        style={
          delayRetry
            ? { animation: `ms-delayed-reveal 180ms ease ${retryDelayMs}ms both` }
            : undefined
        }
        onClick={() => void retry().catch(() => {})}
      >
        {retryLabel}
      </button>
    </div>
  );
}
