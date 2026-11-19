import { describe, expect, it } from "vitest";
import {
  REPUTATION_MIN_SAMPLE,
  REPUTATION_REPEAT_HARD_BOUNCES,
  reputationCircuitDecision,
  reputationCircuitTriggered,
} from "../src/graduated-sending-policy.js";

describe("reputation circuit sample floor", () => {
  it("holds a single mistyped address for review instead of suspending", () => {
    expect(reputationCircuitDecision({ sent: 1, hardBounced: 1, complained: 0 })).toBe("review");
    expect(reputationCircuitTriggered({ sent: 1, hardBounced: 1, complained: 0 })).toBe(false);
  });

  it("keeps a short window under review until the repeat threshold", () => {
    const justBelow = REPUTATION_REPEAT_HARD_BOUNCES - 1;
    expect(reputationCircuitDecision({ sent: 5, hardBounced: justBelow, complained: 0 })).toBe(
      "review",
    );
    expect(
      reputationCircuitDecision({
        sent: 5,
        hardBounced: REPUTATION_REPEAT_HARD_BOUNCES,
        complained: 0,
      }),
    ).toBe("suspend");
  });

  it("applies the bounce rate only once the sample can carry it", () => {
    expect(
      reputationCircuitDecision({
        sent: REPUTATION_MIN_SAMPLE - 1,
        hardBounced: 1,
        complained: 0,
      }),
    ).toBe("review");
    // Exactly 5% is not above the line, at any volume.
    expect(
      reputationCircuitDecision({ sent: REPUTATION_MIN_SAMPLE, hardBounced: 1, complained: 0 }),
    ).toBe("none");
    expect(
      reputationCircuitDecision({ sent: REPUTATION_MIN_SAMPLE, hardBounced: 2, complained: 0 }),
    ).toBe("suspend");
  });

  it("still stops sending on a complaint at any volume", () => {
    expect(reputationCircuitDecision({ sent: 0, hardBounced: 0, complained: 1 })).toBe("suspend");
    expect(reputationCircuitDecision({ sent: 500, hardBounced: 0, complained: 1 })).toBe("suspend");
  });

  it("leaves a clean window alone", () => {
    expect(reputationCircuitDecision({ sent: 0, hardBounced: 0, complained: 0 })).toBe("none");
    expect(reputationCircuitDecision({ sent: 5000, hardBounced: 10, complained: 0 })).toBe("none");
  });
});
