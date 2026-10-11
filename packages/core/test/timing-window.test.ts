import { afterEach, describe, expect, it, vi } from "vitest";
import { startTimingLog, TimingWindow } from "../src/timing-window.js";

describe("timing window", () => {
  afterEach(() => vi.useRealTimers());

  it("summarizes count, p50, p95, max and failures per name, then starts empty", () => {
    const window = new TimingWindow();
    for (let ms = 1; ms <= 100; ms++) window.record("mailboxes.items", ms);
    window.record("mailboxes.setTrash", 40, false);
    window.record("mailboxes.setTrash", 60);
    // Not a duration: ignored.
    window.record("mailboxes.item", Number.NaN);
    window.record("mailboxes.item", -1);
    expect(window.flush()).toBe(
      "mailboxes.items n=100 p50=51ms p95=96ms max=100ms; mailboxes.setTrash n=2 p50=60ms p95=60ms max=60ms failed=1",
    );
    expect(window.flush()).toBeNull();
  });

  it("keeps only the last samples per name while counting them all", () => {
    const window = new TimingWindow(3);
    for (const ms of [1000, 1000, 5, 6, 7]) window.record("stage", ms);
    expect(window.summary()).toBe("stage n=5 p50=6ms p95=7ms max=7ms");
  });

  it("logs a non-empty window on its interval only", () => {
    vi.useFakeTimers();
    const window = new TimingWindow();
    const log = vi.fn();
    const stop = startTimingLog(window, "[test] timings", 1000, log);
    vi.advanceTimersByTime(1000);
    expect(log).not.toHaveBeenCalled();
    window.record("stage", 12);
    vi.advanceTimersByTime(1000);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "[test] timings stage n=1 p50=12ms p95=12ms max=12ms",
    );
    stop();
  });
});
