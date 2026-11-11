import { describe, expect, it } from "vitest";
import { probationCeiling } from "../src/sender-probation.js";

const proven = { reviewed: true, dnsReady: true, clean: true };

describe("probationCeiling", () => {
  it("holds an unproven team at 25 a day whatever its age", () => {
    expect(
      probationCeiling({ ...proven, reviewed: false, ageDays: 90, operatorCeiling: null }),
    ).toBe(25);
    expect(
      probationCeiling({ ...proven, dnsReady: false, ageDays: 90, operatorCeiling: null }),
    ).toBe(25);
    expect(probationCeiling({ ...proven, clean: false, ageDays: 90, operatorCeiling: null })).toBe(
      25,
    );
  });

  it("never lets an operator ceiling lift an unproven team past the ladder", () => {
    expect(probationCeiling({ ...proven, clean: false, ageDays: 0, operatorCeiling: 5_000 })).toBe(
      25,
    );
  });

  it("graduates a proven team by age without any operator input", () => {
    expect(probationCeiling({ ...proven, ageDays: 3, operatorCeiling: null })).toBe(100);
    expect(probationCeiling({ ...proven, ageDays: 15, operatorCeiling: null })).toBe(200);
    expect(probationCeiling({ ...proven, ageDays: 45, operatorCeiling: null })).toBe(1_000);
  });

  it("uses an operator ceiling as typed on a proven team", () => {
    expect(probationCeiling({ ...proven, ageDays: 45, operatorCeiling: 50 })).toBe(50);
    expect(probationCeiling({ ...proven, ageDays: 45, operatorCeiling: 5_000 })).toBe(5_000);
  });

  it("still caps a young proven team at the ladder when the operator asks for more", () => {
    expect(probationCeiling({ ...proven, ageDays: 3, operatorCeiling: 5_000 })).toBe(100);
  });
});
