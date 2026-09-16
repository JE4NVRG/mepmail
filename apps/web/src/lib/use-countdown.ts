"use client";

import { useEffect, useState } from "react";

/**
 * Milliseconds left until `until`, ticking once a second and floored at zero;
 * the interval is cleared when the target changes or the caller unmounts.
 * Zero while `until` is null, so a first render before the data arrives — and
 * the server's own render — agree.
 */
export function useCountdown(until: Date | null): number {
  const target = until?.getTime() ?? 0;
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (target === 0) {
      setLeft(0);
      return;
    }
    const tick = () => setLeft(Math.max(0, target - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [target]);
  return left;
}
