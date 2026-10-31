import { describe, expect, it } from "vitest";
import { sendingAvailability } from "../src/server/sending-availability";

const own = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-01-02T00:00:00Z");
const policy = {
  version: 1,
  allowedTeamIds: [own],
  defaults: { transactional: "disabled", campaign: "disabled" },
  teams: { [own]: { transactional: "azure_smtp", campaign: "disabled" } },
  restoration: {
    teams: { [own]: { notBefore: "2026-01-01T00:00:00Z", senders: ["support@example.test"] } },
  },
};
function status(p: unknown = policy, extra: Record<string, unknown> = {}) {
  return sendingAvailability({
    teamId: own,
    sesPaused: true,
    relayConfigured: true,
    policyRaw: p === undefined ? undefined : JSON.stringify(p),
    now,
    ...extra,
  });
}
describe("team-scoped sending presentation never authorizes a message", () => {
  it("shows limited own relay scope while SES is paused", () =>
    expect(status()).toEqual({ state: "limited" }));
  it("does not show another team the own team's route", () =>
    expect(status(policy, { teamId: other })).toEqual({ state: "paused" }));
  it("keeps an operator pause closed", () =>
    expect(status({ ...policy, paused: true })).toEqual({ state: "paused" }));
  it("does not claim a route when relay configuration is absent", () =>
    expect(status(policy, { relayConfigured: false })).toEqual({ state: "paused" }));
  it("keeps a not-yet-active restoration closed", () =>
    expect(status(policy, { now: new Date("2025-12-31T00:00:00Z") })).toEqual({ state: "paused" }));
  it("keeps malformed JSON closed", () =>
    expect(
      sendingAvailability({
        teamId: own,
        sesPaused: true,
        relayConfigured: true,
        policyRaw: "{bad",
        now,
      }),
    ).toEqual({ state: "paused" }));
  it("validates closed-cohort policy instead of trusting arbitrary JSON", () =>
    expect(status({ ...policy, defaults: { transactional: "ses", campaign: "disabled" } })).toEqual(
      { state: "paused" },
    ));
  it("leaves an ordinary unpaused legacy deployment quiet", () =>
    expect(
      sendingAvailability({
        teamId: own,
        sesPaused: false,
        relayConfigured: false,
        policyRaw: undefined,
        now,
      }),
    ).toEqual({ state: "normal" }));
  it("does not expose credentials, sender lists or operator policy", () =>
    expect(Object.keys(status())).toEqual(["state"]));
});
