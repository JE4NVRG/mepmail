"use client";

import { useEffect, useState } from "react";
import { formatCountdown } from "./format";

/**
 * "mm:ss" until `deadline`, ticking every second and calling `onZero` once
 * when it runs out. Client-side only: the server enforces the deadline
 * regardless of what the clock here says.
 */
export function useCountdown(deadline: Date | string | number, onZero?: () => void): string {
  const target = new Date(deadline).getTime();
  const [left, setLeft] = useState(() => formatCountdown(target - Date.now()));
  useEffect(() => {
    let fired = false;
    const tick = () => {
      const ms = target - Date.now();
      setLeft(formatCountdown(ms));
      if (ms <= 0 && !fired) {
        fired = true;
        onZero?.();
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [target, onZero]);
  return left;
}
