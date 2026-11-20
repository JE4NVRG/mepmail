import { describe, expect, it } from "vitest";
import {
  SEND_GATE_MAX_BOUNCE_RATE,
  SEND_GATE_MAX_COMPLAINT_RATE,
  SEND_GATE_MAX_HARD_BOUNCES_DAY,
  SEND_GATE_MIN_COMPLAINTS,
  SEND_GATE_MIN_SENT,
  sendGateDecision,
} from "../src/platform-breaker.js";

const env = (halt?: string) => (halt === undefined ? {} : { PLATFORM_SENDING_HALT: halt });

describe("account-level send gate", () => {
  it("does not judge a window without a sample", () => {
    expect(sendGateDecision({ sent: 5, hardBounced: 1, complained: 1 }, env()).halt).toBe(false);
  });

  it("stops the whole platform on the owner's brake, even with no traffic", () => {
    for (const value of ["1", "true", "on", " TRUE "]) {
      const d = sendGateDecision({ sent: 0, hardBounced: 0, complained: 0 }, env(value));
      expect(d.halt).toBe(true);
      expect(d.reason).toBe("manual_halt");
    }
    expect(sendGateDecision({ sent: 0, hardBounced: 0, complained: 0 }, env("0")).halt).toBe(false);
  });

  it("waits for the second complaint before freezing everyone", () => {
    const one = sendGateDecision({ sent: 400, hardBounced: 0, complained: 1 }, env());
    expect(one.complaintRate).toBeGreaterThan(SEND_GATE_MAX_COMPLAINT_RATE);
    expect(one.halt).toBe(false);
    const two = sendGateDecision(
      { sent: 400, hardBounced: 0, complained: SEND_GATE_MIN_COMPLAINTS },
      env(),
    );
    expect(two.halt).toBe(true);
    expect(two.reason).toBe("complaint_ceiling");
  });

  it("trips on the bounce ceiling at volume", () => {
    const d = sendGateDecision({ sent: SEND_GATE_MIN_SENT, hardBounced: 8, complained: 0 }, env());
    expect(d.bounceRate).toBeGreaterThanOrEqual(SEND_GATE_MAX_BOUNCE_RATE);
    expect(d.halt).toBe(true);
    expect(d.reason).toBe("bounce_ceiling");
  });

  it("trips on the absolute daily ceiling that many small offenders add up to", () => {
    const d = sendGateDecision(
      { sent: 2000, hardBounced: SEND_GATE_MAX_HARD_BOUNCES_DAY, complained: 0 },
      env(),
    );
    expect(d.bounceRate).toBeLessThan(SEND_GATE_MAX_BOUNCE_RATE);
    expect(d.halt).toBe(true);
    expect(d.reason).toBe("bounce_ceiling");
  });

  it("leaves a healthy window open", () => {
    const d = sendGateDecision({ sent: 5000, hardBounced: 20, complained: 2 }, env());
    expect(d.halt).toBe(false);
    expect(d.reason).toBeNull();
  });
});
