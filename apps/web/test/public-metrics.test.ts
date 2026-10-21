import { describe, expect, it, vi } from "vitest";
import {
  computePublicDeliveryRates,
  type DeliveryCounts,
  metricsWindow,
  PUBLIC_METRICS_MIN_RESOLVED,
  PUBLIC_METRICS_WINDOW_DAYS,
} from "../src/lib/public-metrics";
import { createPublicMetricsReader, PUBLIC_METRICS_TTL_MS } from "../src/server/public-delivery";

describe("public delivery rates", () => {
  it("derives delivery, bounce and complaint rates from the resolved counts", () => {
    // 978 delivered-ish, 12 bounced, 5 complained, 5 failed: 1000 resolved.
    const rates = computePublicDeliveryRates({
      delivered: 958,
      opened: 15,
      clicked: 5,
      bounced: 12,
      complained: 5,
      failed: 5,
    });
    expect(rates).not.toBeNull();
    expect(rates?.resolved).toBe(1000);
    expect(rates?.deliveryRate).toBeCloseTo(0.978, 6);
    expect(rates?.bounceRate).toBeCloseTo(0.012, 6);
    expect(rates?.complaintRate).toBeCloseTo(0.005, 6);
  });

  it("counts opened and clicked as delivered, and failed only as resolved", () => {
    const rates = computePublicDeliveryRates(
      { opened: 400, clicked: 100, failed: 500 },
      PUBLIC_METRICS_MIN_RESOLVED,
    );
    expect(rates?.resolved).toBe(1000);
    expect(rates?.deliveryRate).toBe(0.5);
    expect(rates?.bounceRate).toBe(0);
    expect(rates?.complaintRate).toBe(0);
  });

  it("ignores statuses that were never attempted (canceled, queued_quota, queued)", () => {
    const unsent = { delivered: 600, canceled: 5_000, queued_quota: 5_000, queued: 5_000 };
    const rates = computePublicDeliveryRates(unsent as DeliveryCounts);
    expect(rates?.resolved).toBe(600);
    expect(rates?.deliveryRate).toBe(1);
  });

  it("publishes nothing below the resolved floor, and a rate at it", () => {
    expect(computePublicDeliveryRates({ delivered: PUBLIC_METRICS_MIN_RESOLVED - 1 })).toBeNull();
    const at = computePublicDeliveryRates({ delivered: PUBLIC_METRICS_MIN_RESOLVED });
    expect(at?.deliveryRate).toBe(1);
  });

  it("publishes nothing for an empty window", () => {
    expect(computePublicDeliveryRates({})).toBeNull();
  });

  it("ends the window 30 days after it starts", () => {
    const now = Date.UTC(2026, 9, 21, 12, 0, 0);
    const { since, until } = metricsWindow(now);
    expect(until.getTime()).toBe(now);
    expect(until.getTime() - since.getTime()).toBe(PUBLIC_METRICS_WINDOW_DAYS * 86_400_000);
  });
});

describe("memoized public metrics reader", () => {
  it("shares one read between concurrent requests and reuses it for an hour", async () => {
    let time = Date.UTC(2026, 9, 21, 12, 0, 0);
    const read = vi.fn(async () => ({ delivered: 999, bounced: 1 }));
    const snapshot = createPublicMetricsReader(read, () => time);

    const [first, parallel] = await Promise.all([snapshot(), snapshot()]);
    expect(parallel).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
    expect(first?.rates?.resolved).toBe(1000);
    expect(first?.since).toBe(
      new Date(time - PUBLIC_METRICS_WINDOW_DAYS * 86_400_000).toISOString(),
    );
    expect(first?.computedAt).toBe(new Date(time).toISOString());

    time += PUBLIC_METRICS_TTL_MS - 1;
    expect(await snapshot()).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);

    time += 1;
    expect(await snapshot()).not.toBe(first);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reports too little data as null rates, never as a perfect score", async () => {
    const snapshot = createPublicMetricsReader(async () => ({ delivered: 12 }));
    const first = await snapshot();
    expect(first).not.toBeNull();
    expect(first?.rates).toBeNull();
  });

  it("keeps serving the last good snapshot when a read fails, without leaking the error", async () => {
    let time = Date.UTC(2026, 9, 21, 12, 0, 0);
    const read = vi
      .fn<() => Promise<DeliveryCounts>>()
      .mockResolvedValueOnce({ delivered: 500, bounced: 500 })
      .mockRejectedValueOnce(new Error("connection refused: internal-host"))
      .mockResolvedValueOnce({ delivered: 900, bounced: 100 });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const snapshot = createPublicMetricsReader(read, () => time);

    const good = await snapshot();
    expect(good?.rates?.deliveryRate).toBe(0.5);

    time += PUBLIC_METRICS_TTL_MS;
    const stale = await snapshot();
    expect(stale).toBe(good);
    expect(JSON.stringify(stale)).not.toContain("internal-host");

    // A failure backs off for a minute instead of retrying the database per view.
    expect(await snapshot()).toBe(good);
    expect(read).toHaveBeenCalledTimes(2);
    time += 60_000;
    expect((await snapshot())?.rates?.deliveryRate).toBe(0.9);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });
});
