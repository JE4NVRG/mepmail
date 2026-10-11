import { startTimingLog, TimingWindow } from "@millionsend/core";

/**
 * Server time of the Correio procedures (mailboxes.*), one log line every 10 minutes:
 * count, p50, p95 and max per procedure path. Measures the procedure itself (database
 * and decryption), after the request context; the network and the browser are not in it.
 */
const TIMED_PREFIX = "mailboxes.";
const WINDOW_MS = 10 * 60_000;
const timings = new TimingWindow();
let logging = false;

export function timedProcedure(path: string): boolean {
  return path.startsWith(TIMED_PREFIX);
}

export function recordProcedureTiming(path: string, ms: number, ok: boolean): void {
  if (!logging) {
    logging = true;
    startTimingLog(timings, "[web] timings 10m", WINDOW_MS);
  }
  timings.record(path, ms, ok);
}
