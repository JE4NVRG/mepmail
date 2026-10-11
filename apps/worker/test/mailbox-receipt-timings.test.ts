import { TimingWindow } from "@millionsend/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordReceiptTimings } from "../src/mailbox-receiver.js";

describe("receipt timings", () => {
  afterEach(() => vi.useRealTimers());

  it("records SES->stored, the queue wait and processing, and flags a redelivery", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-11T03:00:10.000Z"));
    const timings = new TimingWindow();
    const input = {
      topicArn: "t",
      snsMessageId: "m",
      event: {},
      queuedAt: Date.parse("2026-10-11T03:00:02.000Z"),
    };
    recordReceiptTimings(
      timings,
      { ...input, receiveCount: 1 },
      "2026-10-11T03:00:01.000Z",
      Date.parse("2026-10-11T03:00:07.000Z"),
    );
    recordReceiptTimings(
      timings,
      { ...input, receiveCount: 3 },
      "2026-10-11T02:59:10.000Z",
      Date.parse("2026-10-11T03:00:09.500Z"),
    );
    expect(timings.flush()).toBe(
      "receipt.processing n=2 p50=3000ms p95=3000ms max=3000ms; " +
        "receipt.queue_wait n=2 p50=7500ms p95=7500ms max=7500ms; " +
        "receipt.redelivered n=1 p50=60000ms p95=60000ms max=60000ms; " +
        "receipt.ses_to_stored n=2 p50=60000ms p95=60000ms max=60000ms",
    );
  });

  it("skips what it cannot know and records nothing without a window", () => {
    const timings = new TimingWindow();
    recordReceiptTimings(
      timings,
      { topicArn: "t", snsMessageId: "m", event: {} },
      undefined,
      Date.now(),
    );
    expect(timings.flush()).toMatch(/^receipt\.processing n=1 /);
    expect(() =>
      recordReceiptTimings(undefined, { topicArn: "t", snsMessageId: "m", event: {} }, "x", 0),
    ).not.toThrow();
  });
});
