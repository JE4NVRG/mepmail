"use client";

import type { RecoveryPhase } from "@/lib/query-recovery";

/** A retry stays reachable even while a read is slow or waiting for connectivity. */
export function QueryRecoveryNotice({
  phase,
  message,
  retryLabel,
  retry,
  className,
}: {
  phase: RecoveryPhase;
  message: string;
  retryLabel: string;
  retry: () => Promise<unknown>;
  className?: string;
}) {
  return (
    <div className={className} role={phase === "error" ? "alert" : "status"}>
      <p>{message}</p>
      <button
        type="button"
        className="ms-btn ms-btn-ghost ms-btn-sm"
        aria-busy={phase === "loading" || phase === "refreshing"}
        onClick={() => void retry().catch(() => {})}
      >
        {retryLabel}
      </button>
    </div>
  );
}
