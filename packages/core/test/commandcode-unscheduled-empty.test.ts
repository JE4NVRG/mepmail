import { SESv2Client } from "@aws-sdk/client-sesv2";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { type CommandCodeMeter, getCommandCodeMeter } from "../src/graduated-commandcode-meter.js";
import { getGraduatedSendingContext } from "../src/graduated-sending-context.js";
import {
  createRuntimeCapacityObserver,
  fundedCreditUnits,
} from "../src/runtime-capacity-observation.js";

const { epoch } = vi.hoisted(() => {
  const epoch = 1794909144895;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(epoch);
  return { epoch };
});
const healthy = () => ({
  SendingEnabled: true,
  ProductionAccessEnabled: true,
  EnforcementStatus: "HEALTHY",
  SendQuota: { Max24HourSend: 54900, SentLast24Hours: 5, MaxSendRate: 14 },
});
function payload() {
  return {
    credits: {
      monthlyCredits: 39.6801103917,
      purchasedCredits: 0,
      freeCredits: 0,
      belowThreshold: false,
    },
    windowLimits: {
      limited: true,
      exceeded: null as unknown,
      fiveHour: { used: 0, cap: 14, resetAt: 0, exceeded: false },
      weekly: { used: 20.9629819327, cap: 35, resetAt: epoch + 200000000, exceeded: false },
    },
  };
}
function fixture(p = payload()) {
  const fetcher = vi.fn(async (url: unknown, input?: RequestInit) => {
    expect(String(url)).toBe("https://api.commandcode.ai/alpha/billing/credits");
    expect(input?.method).toBe("GET");
    return Response.json(p);
  });
  const read = () =>
    getCommandCodeMeter({ apiKey: "fixture-only", fetch: fetcher as typeof fetch });
  return { read, fetcher };
}
function ctx(p = payload()) {
  const { fetcher } = fixture(p);
  return getGraduatedSendingContext({ fetch: fetcher as typeof fetch });
}
beforeEach(() => {
  vi.setSystemTime(epoch);
  vi.stubEnv(
    "SENDING_PROVIDER_POLICY_JSON",
    JSON.stringify({
      version: 1,
      graduated: true,
      defaults: { transactional: "ses", campaign: "disabled" },
    }),
  );
  vi.stubEnv("ABUSE_JUDGE", "openai");
  vi.stubEnv("ABUSE_JUDGE_MODEL", "deepseek/deepseek-v4.1-flash");
  vi.stubEnv("ABUSE_JUDGE_BASE_URL", "https://api.commandcode.ai/provider/v1");
  vi.stubEnv("ABUSE_JUDGE_API_KEY", "fixture-only");
  vi.spyOn(SESv2Client.prototype, "send").mockImplementation((async (command: object) => {
    expect(command.constructor.name).toBe("GetAccountCommand");
    return healthy();
  }) as never);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("UNDECLARED_NETWORK");
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(() => vi.useRealTimers());
it("captured zero reaches original context with finite observed inventory, not a reset guarantee", async () => {
  const { read, fetcher } = fixture();
  const m = await read();
  expect(m.windows.fiveHour).toEqual({
    used: 0,
    cap: 14,
    remaining: 14,
    resetAtMs: 0,
    resetState: "unscheduled-empty",
  });
  expect(m.windowExceeded).toBeNull();
  expect(m.availableCredits).toBe(14);
  expect(fundedCreditUnits(m, epoch)).toBe(9000000000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const c = await ctx();
  expect(c.judgeEnvelope).toMatchObject({
    accountKey: "commandcode-primary",
    remainingCreditUnits: 9000000000,
    reservedCreditUnits: 302457600,
    meterAt: new Date(epoch).toISOString(),
    meterExpiresAt: new Date(epoch + 5000).toISOString(),
  });
  expect(c.capacityReceipt?.buffers.modelFramesBeforeLocalCommitments).toBe(
    Math.floor(9000000000 / 302457600),
  );
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("independently bounded dual zero observations keep both raw zeros", async () => {
  const p = payload();
  p.windowLimits.weekly.used = 0;
  p.windowLimits.weekly.resetAt = 0;
  p.windowLimits.exceeded = false;
  const m = await fixture(p).read();
  for (const w of Object.values(m.windows)) {
    expect(w.resetAtMs).toBe(0);
  }
  expect(fundedCreditUnits(m, epoch)).toBe(9000000000);
});
it("valid scheduled future keeps existing behavior and issues no zero proof", async () => {
  const p = payload();
  p.windowLimits.fiveHour.resetAt = epoch + 10000;
  const m = await fixture(p).read();
  expect(m.windows.fiveHour.resetState).toBeUndefined();
  expect(fundedCreditUnits(m, epoch)).toBe(9000000000);
  expect(() => fundedCreditUnits(m, epoch + 5000)).toThrow();
});
it("missing, string zero, negative, NaN, infinity, past nonzero stay denied", async () => {
  for (const value of [undefined, "0", -1, NaN, Infinity, epoch - 1]) {
    const p = payload();
    Object.assign(p.windowLimits.fiveHour, { resetAt: value });
    await expect(ctx(p)).rejects.toThrow();
  }
});
it("zero never hides use, empty caps or missing/contradictory explicit flags", async () => {
  const mutations: ((p: ReturnType<typeof payload>) => void)[] = [
    (p) => {
      p.windowLimits.fiveHour.used = 0.01;
    },
    (p) => {
      p.windowLimits.fiveHour.cap = 0;
    },
    (p) => {
      p.windowLimits.fiveHour.exceeded = true;
    },
    (p) => {
      Reflect.deleteProperty(p.windowLimits.fiveHour, "exceeded");
    },
    (p) => {
      Reflect.deleteProperty(p.windowLimits.weekly, "exceeded");
    },
    (p) => {
      p.windowLimits.limited = false;
    },
    (p) => {
      Reflect.deleteProperty(p.windowLimits, "limited");
    },
    (p) => {
      p.windowLimits.exceeded = true;
    },
    (p) => {
      p.windowLimits.exceeded = "false";
    },
  ];
  for (const change of mutations) {
    const p = payload();
    p.windowLimits.exceeded = false;
    change(p);
    await expect(ctx(p)).rejects.toThrow();
  }
});
it("the other window remains independently validated, including final reset expiry", async () => {
  for (const value of [epoch - 1, "0", undefined]) {
    const p = payload();
    Object.assign(p.windowLimits.weekly, { resetAt: value });
    await expect(ctx(p)).rejects.toThrow();
  }
  const p = payload();
  p.windowLimits.weekly.resetAt = epoch + 1;
  const m = await fixture(p).read();
  expect(() => fundedCreditUnits(m, epoch + 1)).toThrow();
});
it("unknown custody, HTTP errors and malformed responses fail closed without fallback", async () => {
  const { fetcher } = fixture();
  await expect(
    getCommandCodeMeter({ apiKey: undefined, fetch: fetcher as typeof fetch }),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
  for (const response of [
    new Response("{}", { status: 401 }),
    Response.json({}),
    new Response("not-json"),
  ]) {
    await expect(
      getCommandCodeMeter({
        apiKey: "fixture",
        fetch: vi.fn(async () => response) as typeof fetch,
      }),
    ).rejects.toThrow();
  }
});
it("clones, JSON, copied windows and shaped flags cannot acquire zero authority even with aggregate false", async () => {
  for (const exceeded of [false, null]) {
    const p = payload();
    p.windowLimits.exceeded = exceeded;
    const m = await fixture(p).read();
    const copies = [
      { ...m },
      JSON.parse(JSON.stringify(m)) as CommandCodeMeter,
      { ...m, windows: { ...m.windows } },
    ];
    for (const clone of copies) {
      expect(() => fundedCreditUnits(clone, epoch)).toThrow();
    }
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.windows.fiveHour)).toBe(true);
    expect(Reflect.set(m.windows.fiveHour, "resetAtMs", epoch + 50000)).toBe(false);
  }
});
it("cache reuse never restamps origin and an expired original proof stays expired after refresh", async () => {
  const { read, fetcher } = fixture();
  const observe = createRuntimeCapacityObserver({ readAccount: async () => healthy() });
  const first = await observe(read);
  vi.setSystemTime(epoch + 4999);
  const second = await observe(read);
  expect(second).toBe(first);
  expect(second.requestStartedAtMs).toBe(epoch);
  expect(fetcher).toHaveBeenCalledTimes(1);
  vi.setSystemTime(epoch + 5000);
  expect(() => fundedCreditUnits(first.meter, Date.now())).toThrow();
  const third = await observe(read);
  expect(third.requestStartedAtMs).toBe(epoch + 5000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(() => fundedCreditUnits(first.meter, Date.now())).toThrow();
});
it("safety floor, finite worst frame and slow original GET remain strict", async () => {
  for (const monthly of [0, 4, 5, 5.1]) {
    const p = payload();
    p.credits.monthlyCredits = monthly;
    await expect(ctx(p)).rejects.toThrow();
  }
  const p = payload();
  p.credits.belowThreshold = true;
  await expect(ctx(p)).rejects.toThrow();
  let count = 0;
  await expect(
    getCommandCodeMeter({
      apiKey: "fixture",
      now: () => (count++ === 0 ? epoch : epoch + 5000),
      fetch: fixture().fetcher as typeof fetch,
    }),
  ).rejects.toThrow();
});
