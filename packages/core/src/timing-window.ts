/**
 * Latency samples per name over a fixed window, summarized as one log line and then
 * reset: count, p50, p95 and max in milliseconds, plus failures. Memory is bounded (the
 * last `max` samples per name). Names come from code (a procedure path, a stage), never
 * from request input, so a line carries no ids, addresses or content.
 */
export class TimingWindow {
  private readonly samples = new Map<
    string,
    { values: number[]; count: number; failures: number }
  >();

  constructor(private readonly max = 2000) {}

  record(name: string, ms: number, ok = true): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    let entry = this.samples.get(name);
    if (!entry) {
      entry = { values: [], count: 0, failures: 0 };
      this.samples.set(name, entry);
    }
    entry.count += 1;
    if (!ok) entry.failures += 1;
    if (entry.values.length >= this.max) entry.values.shift();
    entry.values.push(ms);
  }

  /** "name n=… p50=…ms p95=…ms max=…ms[ failed=…]" per name, sorted; null when empty. */
  summary(): string | null {
    if (!this.samples.size) return null;
    const parts: string[] = [];
    for (const [name, { values, count, failures }] of [...this.samples].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const sorted = [...values].sort((a, b) => a - b);
      const at = (p: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
      const ms = (value: number) => `${Math.round(value)}ms`;
      parts.push(
        `${name} n=${count} p50=${ms(at(0.5))} p95=${ms(at(0.95))} max=${ms(at(1))}` +
          (failures ? ` failed=${failures}` : ""),
      );
    }
    return parts.join("; ");
  }

  /** The summary of the window that just ended; the next window starts empty. */
  flush(): string | null {
    const line = this.summary();
    this.samples.clear();
    return line;
  }
}

/** Logs `window` every `everyMs` (when it has samples) without keeping the process alive. */
export function startTimingLog(
  window: TimingWindow,
  label: string,
  everyMs: number,
  log: (line: string) => void = console.log,
): () => void {
  const timer = setInterval(() => {
    const line = window.flush();
    if (line) log(`${label} ${line}`);
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
