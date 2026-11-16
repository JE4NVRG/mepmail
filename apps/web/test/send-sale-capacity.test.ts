import { describe, expect, it } from "vitest";
import { evaluateSendSaleCapacity } from "../../../packages/billing/src/send-sale-capacity.js";

const now = Date.parse("2026-11-15T00:00:00Z");
const receipt = {
  version: 1,
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 240000).toISOString(),
  globalDaily: 53802,
  globalPerMinute: 840,
  tenantPerMinute: 1,
  judgePerMinute: 3,
  commercial: {
    judgeTokensPerMinute: 60000,
    judgeDailyTokens: 86400000,
    worstCaseTokensPerAdmission: 1000,
    creditDailyUsd: 100,
    worstCaseCostUsd: 0.001,
  },
};
describe("authoritative sale capacity", () => {
  it("missing/malformed/stale/future/budgetless receipt closes sales", () => {
    for (const r of [
      null,
      {},
      { ...receipt, expiresAt: new Date(now).toISOString() },
      { ...receipt, issuedAt: new Date(now + 1).toISOString() },
      { ...receipt, commercial: undefined },
    ])
      expect(() => evaluateSendSaleCapacity(r, now, 100, [], 0, 0)).toThrow("capacity_unknown");
  });
  it("one RPM cannot sell 110K immediate daily use; three global RPM cannot sell 1.1M", () => {
    expect(() => evaluateSendSaleCapacity(receipt, now, 3667, [], 0, 0)).toThrow(
      "capacity_insufficient",
    );
    expect(() =>
      evaluateSendSaleCapacity({ ...receipt, tenantPerMinute: 3 }, now, 36667, [], 0, 0),
    ).toThrow("capacity_insufficient");
  });
  it("finite room passes, commitments, fresh meter, TPM and credit each constrain it", () => {
    expect(() => evaluateSendSaleCapacity(receipt, now, 100, [], 0, 0)).not.toThrow();
    for (const [r, commit, used, minute] of [
      [receipt, [4300], 0, 0],
      [receipt, [], 53802, 0],
      [receipt, [], 0, 3],
      [{ ...receipt, commercial: { ...receipt.commercial, judgeTokensPerMinute: 999 } }, [], 0, 0],
      [{ ...receipt, commercial: { ...receipt.commercial, creditDailyUsd: 0.001 } }, [], 0, 0],
    ] as const)
      expect(() => evaluateSendSaleCapacity(r, now, 100, commit, used, minute)).toThrow(
        "capacity_insufficient",
      );
  });
  it("caps all commitments by the shared minute token ceiling, not just daily tokens", () => {
    const r = {
      ...receipt,
      tenantPerMinute: 3,
      commercial: {
        ...receipt.commercial,
        judgeTokensPerMinute: 2000,
      },
    };
    expect(() => evaluateSendSaleCapacity(r, now, 1440, [1440], 0, 0)).not.toThrow();
    expect(() => evaluateSendSaleCapacity(r, now, 1500, [1500], 0, 0)).toThrow(
      "capacity_insufficient",
    );
  });
  it("does not confuse another tenant's global minute usage with the applicant's tenant cap", () => {
    expect(() => evaluateSendSaleCapacity(receipt, now, 100, [], 0, 1)).not.toThrow();
    expect(() => evaluateSendSaleCapacity(receipt, now, 100, [], 0, 3)).toThrow(
      "capacity_insufficient",
    );
  });
});
