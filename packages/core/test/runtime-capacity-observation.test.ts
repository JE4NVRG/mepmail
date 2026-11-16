import { GetAccountCommand, type GetAccountResponse, SESv2Client } from "@aws-sdk/client-sesv2";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandCodeMeter } from "../src/graduated-commandcode-meter.js";
import { getGraduatedSendingContext } from "../src/graduated-sending-context.js";
import {
  createRuntimeCapacityObserver,
  fundedCreditUnits,
} from "../src/runtime-capacity-observation.js";

const START = 1800000000000;
function meter(at = START, availableCredits = 100): CommandCodeMeter {
  return {
    schema: "mepmail.account-meter.v2",
    scope: "existing-key-personal-or-explicit-org-account-shared-not-exclusive",
    requestStartedAtMs: at,
    fetchedAtMs: at,
    latencyMs: 0,
    ttlMs: 5000,
    httpStatus: 200,
    credits: {
      monthlyRemaining: availableCredits,
      purchasedRemaining: 0,
      freeRemaining: 0,
      totalRemaining: availableCredits,
      belowThreshold: false,
    },
    windows: {
      fiveHour: { used: 0, cap: 100, remaining: 100, resetAtMs: at + 3600000 },
      weekly: { used: 0, cap: 100, remaining: 100, resetAtMs: at + 3600000 },
    },
    windowExceeded: false,
    availableCredits,
    autoReload: "unknown",
    exclusivity: "unknown",
  };
}
const healthy = (): GetAccountResponse => ({
  SendingEnabled: true,
  ProductionAccessEnabled: true,
  EnforcementStatus: "HEALTHY",
  SendQuota: { Max24HourSend: 100000, SentLast24Hours: 100, MaxSendRate: 14 },
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe("runtime capacity original-custody feed", () => {
  it("singleflights parallel reads; cache never restamps; renews beyond startup five minutes", async () => {
    let at = START;
    let reads = 0;
    const read = vi.fn(async () => meter(at));
    const observe = createRuntimeCapacityObserver({
      now: () => at,
      readAccount: async () => {
        reads++;
        return healthy();
      },
    });
    const [a, b] = await Promise.all([observe(read), observe(read)]);
    expect(a).toBe(b);
    expect(reads).toBe(2);
    expect(read).toHaveBeenCalledTimes(1);
    at += 4999;
    expect(await observe(read)).toBe(a);
    expect(a.expiresAtMs).toBe(START + 5000);
    at++;
    const c = await observe(read);
    expect(c).not.toBe(a);
    expect(c.requestStartedAtMs).toBe(at);
    at += 360000;
    expect((await observe(read)).requestStartedAtMs).toBe(at);
    expect(reads).toBe(6);
  });
  it("keeps healthy East when legacy Ireland is unknown", async () => {
    const observe = createRuntimeCapacityObserver({
      now: () => START,
      readAccount: async (region) => {
        if (region === "eu-west-1") throw Error("unknown");
        return healthy();
      },
    });
    const r = await observe(async () => meter());
    expect(r.regionalCapacity["eu-west-1"]).toBeNull();
    const east = r.regionalCapacity["us-east-1"]!;
    expect(east.globalDaily).toBeLessThanOrEqual(4320);
    expect(east.globalPerMinute).toBe(3);
    expect(east.commercial.worstCaseTokensPerAdmission).toBe(1002048);
    expect(east.commercial.worstCaseCostUsd).toBe(0.3024576);
    expect(east.observations.sesMax24HourSend).toBe(100000);
    expect(east.observations.sesSentLast24Hours).toBe(100);
    expect(east.buffers.sesRemaining24Hours).toBe(97900);
    expect(east.commercial.judgeTokensPerMinute).toBe(3006144);
    expect(east.buffers.modelCreditUnitsAfterSafetyFloor).toBe(95000000000);
    expect(east.dailySemantics).toBe("nominal-flow-ceiling-not-resource-guarantee");
  });
  it.each(["disabled", "sandbox", "enforcement", "quotaNaN", "rateNaN", "exhausted"])(
    "holds SES %s despite healthy model budget",
    async (kind) => {
      const a = healthy();
      if (kind === "disabled") a.SendingEnabled = false;
      if (kind === "sandbox") a.ProductionAccessEnabled = false;
      if (kind === "enforcement") a.EnforcementStatus = "UNKNOWN";
      if (kind === "quotaNaN") a.SendQuota!.Max24HourSend = NaN;
      if (kind === "rateNaN") a.SendQuota!.MaxSendRate = NaN;
      if (kind === "exhausted") a.SendQuota!.SentLast24Hours = 98000;
      const r = await createRuntimeCapacityObserver({
        now: () => START,
        readAccount: async () => a,
      })(async () => meter());
      expect(r.regionalCapacity["us-east-1"]).toBeNull();
    },
  );
  it("refuses origin five seconds stale without refreshing after I/O", async () => {
    let at = START;
    const observe = createRuntimeCapacityObserver({
      now: () => at,
      readAccount: async () => {
        at = START + 5000;
        return healthy();
      },
    });
    await expect(observe(async () => meter())).rejects.toThrow("capacity_unavailable");
  });
  it.each(["future", "fiveHour", "weekly", "credit", "unknownExceeded", "trueExceeded"])(
    "refuses model budget %s",
    (kind) => {
      const m = meter();
      if (kind === "future") m.requestStartedAtMs++;
      if (kind === "fiveHour") m.windows.fiveHour.remaining = 0;
      if (kind === "weekly") m.windows.weekly.remaining = 0;
      if (kind === "credit") m.availableCredits = 5.1;
      if (kind === "unknownExceeded") m.windowExceeded = null;
      if (kind === "trueExceeded") m.windowExceeded = true;
      expect(() => fundedCreditUnits(m, START)).toThrow("capacity_unavailable");
    },
  );
  it("keeps SES usage and remaining inventory separate from the nominal daily flow ceiling", async () => {
    const a = healthy();
    a.SendQuota = { Max24HourSend: 100, SentLast24Hours: 90, MaxSendRate: 1 };
    const r = await createRuntimeCapacityObserver({ now: () => START, readAccount: async () => a })(
      async () => meter(),
    );
    const east = r.regionalCapacity["us-east-1"]!;
    expect(east.globalDaily).toBe(98);
    expect(east.observations.sesUsefulNominalDaily).toBe(98);
    expect(east.observations.sesSentLast24Hours).toBe(90);
    expect(east.buffers.sesRemaining24Hours).toBe(8);
    // The nominal total ceiling is 98, not remaining=8 that would debit usage twice.
    expect(east.globalDaily - east.observations.sesSentLast24Hours).toBe(
      east.buffers.sesRemaining24Hours,
    );
  });
  it("does not turn sixteen currently funded frames into a permanent sixteen-per-day cap", async () => {
    let at = START;
    let accepted = 0;
    const credits = 5 + 16 * 0.3024576 + 0.00000001;
    const observe = createRuntimeCapacityObserver({
      now: () => at,
      readAccount: async () => ({
        ...healthy(),
        SendQuota: { Max24HourSend: 100000, SentLast24Hours: accepted, MaxSendRate: 14 },
      }),
    });
    const first = (await observe(async () => meter(at, credits))).regionalCapacity["us-east-1"]!;
    expect(first.globalDaily).toBe(4320);
    expect(first.buffers.modelFramesBeforeLocalCommitments).toBe(16);
    accepted = 16;
    at += 5000;
    const fresh = (await observe(async () => meter(at, credits))).regionalCapacity["us-east-1"]!;
    expect(fresh.globalDaily).toBe(first.globalDaily);
    expect(fresh.globalDaily).toBeGreaterThan(accepted);
    expect(fresh.buffers.modelFramesBeforeLocalCommitments).toBe(16);
    expect(fresh.buffers.sesRemaining24Hours).toBe(first.buffers.sesRemaining24Hours - 16);
    expect(fresh.commercial.nominalJudgeDailyTokens).toBe(first.commercial.nominalJudgeDailyTokens);
    expect(fresh.commercial).not.toHaveProperty("creditDailyUsd");
    expect(fresh.commercial).not.toHaveProperty("judgeDailyTokens");
  });
  it("does not settle pending reservations or local debt from a lower aggregate meter", async () => {
    let at = START;
    const observe = createRuntimeCapacityObserver({
      now: () => at,
      readAccount: async () => healthy(),
    });
    const a = (await observe(async () => meter(at, 20))).regionalCapacity["us-east-1"]!;
    at += 5000;
    const b = (await observe(async () => meter(at, 10))).regionalCapacity["us-east-1"]!;
    expect(b.globalDaily).toBe(a.globalDaily);
    expect(b.buffers.modelCreditUnitsAfterSafetyFloor).toBeLessThan(
      a.buffers.modelCreditUnitsAfterSafetyFloor,
    );
    expect(b.buffers.localCommitments).toBe("parent-ledger-required");
    expect(b.buffers).not.toHaveProperty("held");
    expect(b.buffers).not.toHaveProperty("spentDebt");
    expect(Object.isFrozen(b.buffers)).toBe(true);
  });
  it("refuses a fresh depleted model snapshot despite unchanged nominal throughput", async () => {
    let at = START;
    const observe = createRuntimeCapacityObserver({
      now: () => at,
      readAccount: async () => healthy(),
    });
    expect((await observe(async () => meter(at, 10))).regionalCapacity["us-east-1"]).not.toBeNull();
    at += 5000;
    await expect(observe(async () => meter(at, 5))).rejects.toThrow("capacity_unavailable");
  });
  it("holds a fresh SES-depleted region independently of healthy model resources", async () => {
    let at = START;
    let sent = 0;
    const observe = createRuntimeCapacityObserver({
      now: () => at,
      readAccount: async (region) => ({
        ...healthy(),
        SendQuota: {
          Max24HourSend: 100,
          SentLast24Hours: region === "us-east-1" ? sent : 0,
          MaxSendRate: 14,
        },
      }),
    });
    expect((await observe(async () => meter(at))).regionalCapacity["us-east-1"]).not.toBeNull();
    at += 5000;
    sent = 98;
    const fresh = await observe(async () => meter(at));
    expect(fresh.regionalCapacity["us-east-1"]).toBeNull();
    expect(fresh.regionalCapacity["eu-west-1"]).not.toBeNull();
  });
  it("default SDK invokes ONLY readonly GetAccount with original provider configuration", async () => {
    const commands: unknown[] = [];
    vi.spyOn(SESv2Client.prototype, "send").mockImplementation(async (command: unknown) => {
      commands.push(command);
      return healthy();
    });
    const r = await createRuntimeCapacityObserver({ now: () => START })(async () => meter());
    expect(r.regionalCapacity["us-east-1"]).not.toBeNull();
    expect(commands).toHaveLength(2);
    expect(commands.every((c) => c instanceof GetAccountCommand)).toBe(true);
  });
  it("actual admission context exposes typed separate resource buffers, not a daily credit allowance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    vi.stubEnv("SENDING_PROVIDER_POLICY_JSON", JSON.stringify({ graduated: true }));
    vi.spyOn(SESv2Client.prototype, "send").mockImplementation(async () => healthy());
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            credits: {
              monthlyCredits: 10,
              purchasedCredits: 0,
              freeCredits: 0,
              belowThreshold: false,
            },
            windowLimits: {
              exceeded: false,
              fiveHour: { used: 0, cap: 100, resetAt: START + 3600000 },
              weekly: { used: 0, cap: 100, resetAt: START + 3600000 },
            },
          }),
        ),
    );
    const r = await getGraduatedSendingContext({
      config: {
        provider: "openai",
        model: "deepseek/deepseek-v4.1-flash",
        baseUrl: "https://api.commandcode.ai/provider/v1",
        apiKey: "fixture-only",
      },
      fetch: transport as typeof fetch,
    });
    expect(r.capacityReceipt?.globalDaily).toBe(4320);
    expect(r.capacityReceipt?.buffers.modelFramesBeforeLocalCommitments).toBe(16);
    expect(r.capacityReceipt?.buffers.localCommitments).toBe("parent-ledger-required");
    expect(r.capacityReceipt?.dailySemantics).toBe("nominal-flow-ceiling-not-resource-guarantee");
    expect(r.regionalCapacity?.["us-east-1"]).toBe(r.capacityReceipt);
    expect(r.judgeEnvelope?.remainingCreditUnits).toBe(5000000000);
  });
  it("actual context judge purpose obtains only Coda, never SES", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    vi.stubEnv("SENDING_PROVIDER_POLICY_JSON", JSON.stringify({ graduated: true }));
    const ses = vi.spyOn(SESv2Client.prototype, "send").mockRejectedValue(Error("must not call"));
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            credits: {
              monthlyCredits: 100,
              purchasedCredits: 0,
              freeCredits: 0,
              belowThreshold: false,
            },
            windowLimits: {
              exceeded: false,
              fiveHour: { used: 0, cap: 100, resetAt: START + 3600000 },
              weekly: { used: 0, cap: 100, resetAt: START + 3600000 },
            },
          }),
        ),
    );
    const r = await getGraduatedSendingContext({
      purpose: "judge",
      config: {
        provider: "openai",
        model: "deepseek/deepseek-v4.1-flash",
        baseUrl: "https://api.commandcode.ai/provider/v1",
        apiKey: "fixture-only",
      },
      fetch: transport as typeof fetch,
    });
    expect(r.judgeEnvelope?.reservedCreditUnits).toBe(302457600);
    expect(r).not.toHaveProperty("capacityReceipt");
    expect(ses).not.toHaveBeenCalled();
    expect(transport.mock.calls).toHaveLength(1);
  });
});
