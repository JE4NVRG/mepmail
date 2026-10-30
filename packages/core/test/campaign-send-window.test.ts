import { describe, expect, it } from "vitest";
import { campaignSendWindowOpen, campaignSendWindowSchema } from "../src/campaign-send-window.js";

const window = { startsAt: "2026-11-01T12:00:00.000Z", endsAt: "2026-11-01T13:00:00.000Z" };
describe("operator-owned UTC campaign send window", () => {
  it.each([
    ["2026-11-01T11:59:59.999Z", false],
    [window.startsAt, true],
    ["2026-11-01T12:59:59.999Z", true],
    [window.endsAt, false],
    ["2026-11-01T13:00:00.001Z", false],
  ] as const)("uses [start, end), sampled from the injected clock: %s", (at, allowed) => {
    expect(campaignSendWindowOpen(window, new Date(at))).toBe(allowed);
  });
  it.each([
    undefined,
    {},
    { startsAt: window.startsAt },
    { startsAt: window.endsAt, endsAt: window.startsAt },
    { startsAt: window.startsAt, endsAt: window.startsAt },
    { ...window, startsAt: "2026-11-01T12:00:00+00:00" },
    { ...window, startsAt: "2026-02-30T12:00:00Z" },
    { ...window, startsAt: "2026-11-01T12:00:00.000001Z" },
  ])("rejects absent, invalid, offset or ambiguous-precision windows: %j", (invalid) => {
    expect(campaignSendWindowSchema.safeParse(invalid).success).toBe(false);
    expect(campaignSendWindowOpen(invalid, new Date(window.startsAt))).toBe(false);
  });
  it("holds invalid clocks", () => {
    expect(campaignSendWindowOpen(window, new Date(Number.NaN))).toBe(false);
  });
});
