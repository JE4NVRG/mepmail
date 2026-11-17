import { describe, expect, it } from "vitest";
import { createRuntimeCapacityObserver } from "../../core/src/runtime-capacity-observation.js";
import { evaluateRuntimeSendSaleCapacity } from "../src/send-sale-capacity.js";

const at = Date.parse("2026-11-17T00:00:00Z");
const frame = 302457600;
async function fixture() {
  const m = {
    requestStartedAtMs: at,
    fetchedAtMs: at,
    windowExceeded: false,
    credits: { belowThreshold: false },
    availableCredits: 6,
    windows: {
      fiveHour: { used: 1, cap: 14, remaining: 13, resetAtMs: at + 3600000 },
      weekly: { used: 17, cap: 35, remaining: 18, resetAtMs: at + 3600000 },
    },
  };
  const obs = await createRuntimeCapacityObserver({
    now: () => at,
    readAccount: async () => ({
      SendingEnabled: true,
      ProductionAccessEnabled: true,
      EnforcementStatus: "HEALTHY",
      SendQuota: { Max24HourSend: 54900, SentLast24Hours: 5, MaxSendRate: 14 },
    }),
  })(async () => m as never);
  const receipt = obs.regionalCapacity["us-east-1"]!;
  const context = {
    judgeEnvelope: {
      accountKey: "commandcode-primary",
      throughputMode: "bounded-concurrency",
      rpm: 120,
      tenantRpm: 120,
      tpm: 120245760,
      concurrency: 2,
      meterId: "fixture",
      meterAt: new Date(at).toISOString(),
      meterExpiresAt: new Date(at + 5000).toISOString(),
      maxInputTokens: 1000000,
      maxOutputTokens: 2048,
      reservedCreditUnits: frame,
      remainingCreditUnits: obs.remainingCreditUnits,
    },
  };
  return { receipt, context };
}
describe("current admission, not prefunded plan maxima", () => {
  it.each([3667, 36667])(
    "permits legitimate Starter/Pro entitlement %i with only current stock",
    async (daily) => {
      const { receipt, context } = await fixture();
      expect(() =>
        evaluateRuntimeSendSaleCapacity(
          receipt,
          context as never,
          at,
          daily,
          [51504, 36667],
          5,
          0,
          daily,
          0,
          0,
        ),
      ).not.toThrow();
    },
  );
  it("retains current credit, real SES, stale and unknown refusals", async () => {
    const { receipt, context } = await fixture();
    const run =
      (r = receipt, c = context, held = 0, debt = 0, daily = 36667) =>
      () =>
        evaluateRuntimeSendSaleCapacity(r, c as never, at, daily, [51504], 5, 0, daily, held, debt);
    expect(run(receipt, context, 3 * frame)).toThrow("capacity_insufficient");
    expect(run(receipt, context, 0, 3 * frame)).toThrow("capacity_insufficient");
    expect(run(receipt, context, 0, 0, 55000)).toThrow("capacity_insufficient");
    expect(run({ ...receipt, expiresAt: new Date(at).toISOString() })).toThrow("capacity_unknown");
    expect(run(null as never)).toThrow("capacity_unknown");
  });
});
