import { describe, expect, it } from "vitest";
import {
  REPUTATION_MIN_SAMPLE,
  REPUTATION_REPEAT_HARD_BOUNCES,
  suspensionFloorMet,
} from "../src/graduated-sending-policy.js";

describe("suspension floor", () => {
  it("does not lock an account on one mistyped address", () => {
    expect(suspensionFloorMet({ sent: 1, hardBounced: 1, complained: 0 })).toBe(false);
    expect(suspensionFloorMet({ sent: 5, hardBounced: 2, complained: 0 })).toBe(false);
  });

  it("locks on repeated hard bounces whatever the volume", () => {
    expect(
      suspensionFloorMet({ sent: 5, hardBounced: REPUTATION_REPEAT_HARD_BOUNCES, complained: 0 }),
    ).toBe(true);
  });

  it("needs the sample to reach the rate line", () => {
    expect(
      suspensionFloorMet({ sent: REPUTATION_MIN_SAMPLE - 1, hardBounced: 1, complained: 0 }),
    ).toBe(false);
    // Exactly five percent is not above the line.
    expect(suspensionFloorMet({ sent: REPUTATION_MIN_SAMPLE, hardBounced: 1, complained: 0 })).toBe(
      false,
    );
    expect(suspensionFloorMet({ sent: REPUTATION_MIN_SAMPLE, hardBounced: 2, complained: 0 })).toBe(
      true,
    );
  });

  it("never lets a complaint wait for a sample", () => {
    expect(suspensionFloorMet({ sent: 0, hardBounced: 0, complained: 1 })).toBe(true);
  });

  it("leaves a clean or healthy window alone", () => {
    expect(suspensionFloorMet({ sent: 0, hardBounced: 0, complained: 0 })).toBe(false);
    expect(suspensionFloorMet({ sent: 5000, hardBounced: 10, complained: 0 })).toBe(false);
  });
});
