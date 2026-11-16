import type { GetAccountResponse } from "@aws-sdk/client-sesv2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CommandCodeMeter,
  getCommandCodeMeter,
  hasCommandCodeWindowHeadroomProof,
} from "../src/graduated-commandcode-meter.js";
import {
  createRuntimeCapacityObserver,
  fundedCreditUnits,
} from "../src/runtime-capacity-observation.js";

const START = 1800000000000;
// Synthetic metadata only. No recorded balances, credentials or model calls.
function payload() {
  return {
    data: {
      credits: {
        monthlyCredits: 30,
        purchasedCredits: 0,
        freeCredits: 0,
        belowThreshold: false,
      },
      windowLimits: {
        limited: true,
        exceeded: null as unknown,
        fiveHour: { exceeded: false, used: 1, cap: 100, resetAt: START + 3600000 },
        weekly: { exceeded: false, used: 2, cap: 200, resetAt: START + 7200000 },
      },
    },
  };
}
type Payload = ReturnType<typeof payload>;
function capturingGet(body: unknown, now: () => number = () => START) {
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(body), { status: 200 }),
  );
  const read = () =>
    getCommandCodeMeter({
      apiKey: "fixture-not-a-provider-key",
      orgId: "fixture/org",
      fetch: fetcher,
      now,
    });
  return { read, fetcher };
}
const healthy = (): GetAccountResponse => ({
  SendingEnabled: true,
  ProductionAccessEnabled: true,
  EnforcementStatus: "HEALTHY",
  SendQuota: { Max24HourSend: 100000, SentLast24Hours: 100, MaxSendRate: 14 },
});
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("real provider forbidden");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CommandCode observed null aggregate: original adapter custody", () => {
  it("preserves raw null and typed local proof through the real meter, funding and observer", async () => {
    const { read, fetcher } = capturingGet(payload());
    const readAccount = vi.fn(async () => healthy());
    const observe = createRuntimeCapacityObserver({ now: () => START, readAccount });
    const observed = await observe(read);
    const m = observed.meter;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.commandcode.ai/alpha/billing/credits?orgId=fixture%2Forg",
    );
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(readAccount).toHaveBeenCalledTimes(2);
    expect(m.windowExceeded).toBeNull();
    expect(m.windowHeadroomProof).toEqual({
      policy: "explicit-limited-dual-window-headroom.v1",
      aggregateExceeded: null,
      limited: true,
      fiveHourExceeded: false,
      weeklyExceeded: false,
    });
    expect(hasCommandCodeWindowHeadroomProof(m)).toBe(true);
    expect(fundedCreditUnits(m, START)).toBe(25000000000);
    expect(observed.remainingCreditUnits).toBe(25000000000);
    expect(observed.regionalCapacity["us-east-1"]?.buffers.modelCreditUnitsAfterSafetyFloor).toBe(
      25000000000,
    );
    expect(observed.expiresAtMs).toBe(START + 5000);
    expect(JSON.parse(JSON.stringify(m)).windowExceeded).toBeNull();
    expect(await observe(read)).toBe(observed);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  const denied: [string, (p: Payload) => void][] = [
    [
      "missing limited",
      (p) => {
        Reflect.deleteProperty(p.data.windowLimits, "limited");
      },
    ],
    [
      "false limited",
      (p) => {
        p.data.windowLimits.limited = false;
      },
    ],
    [
      "string limited",
      (p) => {
        Object.assign(p.data.windowLimits, { limited: "true" });
      },
    ],
    [
      "missing fiveHour flag",
      (p) => {
        Reflect.deleteProperty(p.data.windowLimits.fiveHour, "exceeded");
      },
    ],
    [
      "missing weekly flag",
      (p) => {
        Reflect.deleteProperty(p.data.windowLimits.weekly, "exceeded");
      },
    ],
    [
      "contradictory fiveHour true",
      (p) => {
        p.data.windowLimits.fiveHour.exceeded = true;
      },
    ],
    [
      "contradictory weekly true",
      (p) => {
        p.data.windowLimits.weekly.exceeded = true;
      },
    ],
    [
      "string subwindow flag",
      (p) => {
        Object.assign(p.data.windowLimits.weekly, { exceeded: "false" });
      },
    ],
    [
      "null subwindow flag",
      (p) => {
        Object.assign(p.data.windowLimits.fiveHour, { exceeded: null });
      },
    ],
    [
      "top true",
      (p) => {
        p.data.windowLimits.exceeded = true;
      },
    ],
    [
      "top string",
      (p) => {
        p.data.windowLimits.exceeded = "false";
      },
    ],
    [
      "top number",
      (p) => {
        p.data.windowLimits.exceeded = 0;
      },
    ],
    [
      "top missing",
      (p) => {
        Reflect.deleteProperty(p.data.windowLimits, "exceeded");
      },
    ],
    [
      "top object",
      (p) => {
        p.data.windowLimits.exceeded = {};
      },
    ],
    [
      "fiveHour at cap",
      (p) => {
        p.data.windowLimits.fiveHour.used = 100;
      },
    ],
    [
      "weekly above cap",
      (p) => {
        p.data.windowLimits.weekly.used = 201;
      },
    ],
    [
      "zero cap",
      (p) => {
        p.data.windowLimits.weekly.cap = 0;
      },
    ],
    [
      "negative used",
      (p) => {
        p.data.windowLimits.fiveHour.used = -1;
      },
    ],
    [
      "string used",
      (p) => {
        Object.assign(p.data.windowLimits.fiveHour, { used: "1" });
      },
    ],
    [
      "expired reset",
      (p) => {
        p.data.windowLimits.weekly.resetAt = START;
      },
    ],
    [
      "string reset",
      (p) => {
        Object.assign(p.data.windowLimits.weekly, { resetAt: String(START + 1) });
      },
    ],
    [
      "below safety floor",
      (p) => {
        p.data.credits.monthlyCredits = 4;
      },
    ],
    [
      "insufficient full frame above floor",
      (p) => {
        p.data.credits.monthlyCredits = 5.1;
      },
    ],
    [
      "provider belowThreshold",
      (p) => {
        p.data.credits.belowThreshold = true;
      },
    ],
  ];
  it.each(denied)("denies %s through the imported adapter and observer", async (_name, mutate) => {
    const p = payload();
    mutate(p);
    const { read, fetcher } = capturingGet(p);
    const observe = createRuntimeCapacityObserver({
      now: () => START,
      readAccount: async () => healthy(),
    });
    await expect(observe(read)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("denies absent, copied and JSON-forged proofs without converting raw null to false", async () => {
    const m = await capturingGet(payload()).read();
    const noProof = { ...m };
    delete noProof.windowHeadroomProof;
    const forged = JSON.parse(JSON.stringify(m)) as CommandCodeMeter;
    const copied = { ...m };
    for (const untrusted of [noProof, forged, copied]) {
      expect(untrusted.windowExceeded).toBeNull();
      expect(hasCommandCodeWindowHeadroomProof(untrusted)).toBe(false);
      expect(() => fundedCreditUnits(untrusted, START)).toThrow("capacity_unavailable");
    }
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.windowHeadroomProof)).toBe(true);
    expect(Object.isFrozen(m.windows)).toBe(true);
    expect(Object.isFrozen(m.windows.fiveHour)).toBe(true);
    expect(Object.isFrozen(m.credits)).toBe(true);
    expect(Reflect.set(m, "availableCredits", 999999)).toBe(false);
    expect(Reflect.set(m.windows.fiveHour, "used", 100)).toBe(false);
  });

  it("does not accept an HTTP-supplied proof in place of required raw flags", async () => {
    const legitimate = await capturingGet(payload()).read();
    const p = payload();
    Reflect.deleteProperty(p.data.windowLimits.weekly, "exceeded");
    Object.assign(p.data, { windowHeadroomProof: legitimate.windowHeadroomProof });
    await expect(capturingGet(p).read()).rejects.toThrow();
  });

  it("expires original null proof at five seconds and never renews a slow GET", async () => {
    const m = await capturingGet(payload()).read();
    expect(() => fundedCreditUnits(m, START + 4999)).not.toThrow();
    expect(() => fundedCreditUnits(m, START + 5000)).toThrow("capacity_unavailable");
    let calls = 0;
    const { read } = capturingGet(payload(), () => (calls++ === 0 ? START : START + 5000));
    await expect(read()).rejects.toThrow();
  });

  it("denies a reset that expires after valid proof issuance", async () => {
    const p = payload();
    p.data.windowLimits.fiveHour.resetAt = START + 1;
    const m = await capturingGet(p).read();
    expect(() => fundedCreditUnits(m, START)).not.toThrow();
    expect(() => fundedCreditUnits(m, START + 1)).toThrow("capacity_unavailable");
  });

  it("keeps legacy explicit false compatible only without supplied contradictions", async () => {
    const p = payload();
    p.data.windowLimits.exceeded = false;
    Reflect.deleteProperty(p.data.windowLimits, "limited");
    Reflect.deleteProperty(p.data.windowLimits.fiveHour, "exceeded");
    Reflect.deleteProperty(p.data.windowLimits.weekly, "exceeded");
    const m = await capturingGet(p).read();
    expect(m.windowExceeded).toBe(false);
    expect(m.windowHeadroomProof).toBeUndefined();
    expect(fundedCreditUnits(m, START)).toBe(25000000000);
    p.data.windowLimits.weekly.exceeded = true;
    await expect(capturingGet(p).read()).rejects.toThrow();
  });
});
