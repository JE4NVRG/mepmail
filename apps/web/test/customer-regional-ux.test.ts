import type { Db } from "@millionsend/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recommendedDomainRegion } from "../src/lib/domain-region-recommendation";
import {
  createRegionalSendingProbe,
  sesPresentationPermitted,
  teamHasHealthySesRoute,
} from "../src/server/regional-sending-presentation";
import { createSystemRouter } from "../src/server/routers/system";
import { sendingAvailability } from "../src/server/sending-availability";
import { type Context, createCallerFactory, router } from "../src/server/trpc";

const teamId = "11111111-1111-4111-8111-111111111111";
const domainId = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const domain = {
  id: domainId,
  teamId,
  name: "example.test",
  region: "us-east-1",
  status: "verified",
  relayEnabledAt: null,
};
const binding = { teamId, domainId, domain: domain.name, region: "eu-west-1" };
const healthy = async (region: string) => region === "eu-west-1";
const topics = ["arn:aws:sns:eu-west-1:123456789012:private-events"];
function route(extra: Partial<Parameters<typeof teamHasHealthySesRoute>[0]> = {}) {
  return teamHasHealthySesRoute({
    teamId,
    domains: [domain],
    nativeDomainIds: new Set([domainId]),
    bindingsRaw: JSON.stringify([binding]),
    topics,
    healthy,
    ...extra,
  });
}
function presentation(healthySesRoute: boolean, policyRaw?: string) {
  return sendingAvailability({
    teamId,
    healthySesRoute,
    sesPaused: true,
    relayConfigured: false,
    policyRaw,
  });
}
vi.mock("@/server/request-membership", async () => import("./fixtures/legacy-router-membership"));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("US SHUTDOWN / EU HEALTHY customer projection", () => {
  it("keeps exact eligible Native scope limited, not globally normal", async () => {
    expect(presentation(await route())).toEqual({ state: "limited" });
    expect(domain.region).toBe("us-east-1");
  });
  it("keeps public US-only sending paused without a Native mailbox", async () => {
    expect(presentation(await route({ nativeDomainIds: new Set() }))).toEqual({ state: "paused" });
  });
  it("does not present a Native campaign bypass when transactional SES is disabled", async () => {
    expect(await route({ nativePermitted: false })).toBe(false);
    expect(
      sesPresentationPermitted(
        teamId,
        JSON.stringify({ version: 1, defaults: { transactional: "disabled", campaign: "ses" } }),
        "transactional",
      ),
    ).toBe(false);
  });
  it("accepts an own verified EU domain without borrowing Native bindings", async () => {
    expect(
      await route({
        domains: [{ ...domain, region: "eu-west-1" }],
        nativeDomainIds: new Set(),
        bindingsRaw: undefined,
      }),
    ).toBe(true);
  });
  it.each([
    { ...binding, teamId: other },
    { ...binding, domainId: other },
    { ...binding, domain: "wrong.test" },
    { ...binding, region: "unknown" },
  ])("refuses mismatched or unknown bindings %j", async (entry) => {
    expect(await route({ bindingsRaw: JSON.stringify([entry]) })).toBe(false);
  });
  it("fails closed on absent evidence, duplicate keys, missing domains or unverified identity", async () => {
    expect(await route({ topics: [] })).toBe(false);
    expect(await route({ domains: [] })).toBe(false);
    expect(await route({ domains: [{ ...domain, status: "pending" }] })).toBe(false);
    expect(await route({ domains: [{ ...domain, teamId: other }] })).toBe(false);
    expect(
      await route({
        bindingsRaw: JSON.stringify([binding]).replace(
          '"teamId":',
          `"teamId":"${other}","teamId":`,
        ),
      }),
    ).toBe(false);
  });
  it("fails closed on no healthy or unknown/error health", async () => {
    expect(await route({ healthy: async () => false })).toBe(false);
    expect(
      await route({
        healthy: async () => {
          throw new Error("unknown");
        },
      }),
    ).toBe(false);
  });
  it("honors policy pause, allowed-team exclusions, disabled and campaign-only gates", () => {
    for (const p of [
      { version: 1, paused: true },
      { version: 1, allowedTeamIds: [other] },
      { version: 1, defaults: { transactional: "disabled", campaign: "disabled" } },
    ]) {
      const raw = JSON.stringify(p);
      expect(sesPresentationPermitted(teamId, raw)).toBe(false);
      expect(presentation(true, raw)).toEqual({ state: "paused" });
    }
    expect(
      presentation(
        true,
        JSON.stringify({ version: 1, defaults: { transactional: "ses", campaign: "disabled" } }),
      ),
    ).toEqual({ state: "limited" });
  });
  it("cannot escape a closed restoration through healthy SES", () => {
    const raw = JSON.stringify({
      version: 1,
      allowedTeamIds: [teamId],
      defaults: { transactional: "disabled", campaign: "disabled" },
      teams: { [teamId]: { transactional: "azure_smtp", campaign: "disabled" } },
      restoration: {
        teams: {
          [teamId]: { notBefore: "2026-01-01T00:00:00Z", senders: ["support@example.test"] },
        },
      },
    });
    expect(sesPresentationPermitted(teamId, raw)).toBe(false);
    expect(presentation(true, raw)).toEqual({ state: "paused" });
    expect(
      sendingAvailability({
        teamId,
        healthySesRoute: true,
        sesPaused: true,
        relayConfigured: true,
        relayDomainNames: [],
        policyRaw: raw,
      }),
    ).toEqual({ state: "paused" });
  });
  it("exposes only the state, no bindings, policy, sender or account diagnostics", () => {
    expect(Object.keys(presentation(true))).toEqual(["state"]);
  });
});
describe("fresh fail-closed regional advisory and new-domain recommendation", () => {
  it("checks actual HEALTHY, production, capacity and rate, not region names", async () => {
    const probe = createRegionalSendingProbe((region) => ({
      async send() {
        return {
          SendingEnabled: true,
          ProductionAccessEnabled: true,
          EnforcementStatus: region === "us-east-1" ? "SHUTDOWN" : "HEALTHY",
          SendQuota: { Max24HourSend: 1000, SentLast24Hours: 0, MaxSendRate: 1 },
        };
      },
    }));
    expect(await probe("us-east-1", true)).toBe(false);
    expect(await probe("eu-west-1", true)).toBe(true);
    expect(await probe("sa-east-1", true)).toBe(true);
    expect(await probe("eu-west-1", false)).toBe(false);
  });
  it("does not keep a healthy stale answer on a failed refresh", async () => {
    vi.useFakeTimers();
    let fail = false;
    const probe = createRegionalSendingProbe(() => ({
      async send() {
        if (fail) throw new Error("offline");
        return {
          SendingEnabled: true,
          ProductionAccessEnabled: true,
          EnforcementStatus: "HEALTHY",
          SendQuota: { Max24HourSend: 1000, MaxSendRate: 1 },
        };
      },
    }));
    expect(await probe("eu-west-1", true)).toBe(true);
    fail = true;
    vi.advanceTimersByTime(60_001);
    expect(await probe("eu-west-1", true)).toBe(false);
  });
  it.each([
    {},
    { SendingEnabled: true, EnforcementStatus: "PROBATION" },
    { SendingEnabled: true, ProductionAccessEnabled: true, EnforcementStatus: "HEALTHY" },
  ])("never interprets incomplete account data as ready %j", async (answer) => {
    const probe = createRegionalSendingProbe(() => ({
      async send() {
        return answer;
      },
    }));
    expect(await probe("eu-west-1", true)).toBe(false);
  });
  it("recommends healthy permitted EU instead of first served US; preserves explicit/existing selection", () => {
    const regions = [
      { code: "us-east-1", production: true, sendingHealthy: false },
      { code: "eu-west-1", production: true, sendingHealthy: true },
    ];
    expect(recommendedDomainRegion(regions)).toBe("eu-west-1");
    expect(recommendedDomainRegion(regions, "us-east-1")).toBe("us-east-1");
    expect(recommendedDomainRegion(regions.map((r) => ({ ...r, sendingHealthy: false })))).toBe(
      "us-east-1",
    );
    expect(recommendedDomainRegion([])).toBe("");
  });
});

describe("actual authenticated team presentation router (synthetic membership)", () => {
  it("projects US shutdown/EU healthy through exact current-team resources and minimal DTO", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture");
    vi.stubEnv("AWS_REGIONS", "us-east-1,eu-west-1");
    vi.stubEnv("IS_CLOUD", "true");
    vi.stubEnv("SNS_TOPIC_ARNS", topics.join(","));
    vi.stubEnv("SENDING_PROVIDER_POLICY_JSON", "");
    for (const c of [
      { domains: [domain], native: [domainId], bindings: [binding], expected: "limited" },
      { domains: [domain], native: [], bindings: [binding], expected: "paused" },
      {
        domains: [domain],
        native: [domainId],
        bindings: [{ ...binding, teamId: other }],
        expected: "paused",
      },
      {
        domains: [{ ...domain, region: "eu-west-1" }],
        native: [],
        bindings: [],
        expected: "limited",
      },
      { domains: [], native: [], bindings: [binding], expected: "paused" },
    ]) {
      vi.stubEnv("MAILBOX_SES_OUTBOUND_REGIONS", JSON.stringify(c.bindings));
      let query = 0;
      const db = {
        select: () => ({
          from: () => ({
            where: () =>
              Promise.resolve(query++ === 0 ? c.domains : c.native.map((id) => ({ domainId: id }))),
          }),
        }),
      } as unknown as Db;
      const make = createCallerFactory(
        router({
          system: createSystemRouter({
            accountClient: (region) => ({
              async send() {
                return {
                  SendingEnabled: true,
                  ProductionAccessEnabled: true,
                  EnforcementStatus: region === "us-east-1" ? "SHUTDOWN" : "HEALTHY",
                  SendQuota: { Max24HourSend: 1000, SentLast24Hours: 0, MaxSendRate: 1 },
                };
              },
            }),
          }),
        }),
      );
      const caller = make({
        db,
        teamId,
        role: "owner",
        session: { user: { id: "fixture", email: "fixture@example.test", name: "Fixture" } },
      } as Context);
      expect(await caller.system.sendingAvailability()).toEqual({ state: c.expected });
      expect((await caller.system.features()).regions).toEqual([
        { code: "us-east-1", production: true, sendingHealthy: false },
        { code: "eu-west-1", production: true, sendingHealthy: true },
      ]);
    }
  });
});
