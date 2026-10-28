import { describe, expect, it } from "vitest";
import {
  parseSendingProviderPolicy,
  resolveSendingProvider,
} from "../src/sending-provider-policy.js";

const TEAM = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const availableProviders = new Set(["ses", "customer_smtp"]);
const input = {
  teamId: TEAM,
  messageClass: "transactional" as const,
  legacyProvider: "ses" as const,
  availableProviders,
};

describe("operator-owned sending provider policy", () => {
  it("preserves the existing route only when no policy is configured", () => {
    expect(parseSendingProviderPolicy(undefined)).toBeNull();
    expect(resolveSendingProvider(null, input)).toEqual({
      kind: "selected",
      provider: "ses",
      source: "legacy",
    });
  });
  it("a global operator pause holds every route, including an independent relay", () => {
    const policy = parseSendingProviderPolicy('{"version":1,"paused":true}');
    expect(resolveSendingProvider(policy, input)).toEqual({
      kind: "held",
      reason: "operator_paused",
    });
    expect(resolveSendingProvider(policy, { ...input, legacyProvider: "customer_smtp" })).toEqual({
      kind: "held",
      reason: "operator_paused",
    });
  });
  it("an empty allowlist admits nobody rather than disabling the fence", () => {
    expect(
      resolveSendingProvider(
        parseSendingProviderPolicy('{"version":1,"allowedTeamIds":[]}'),
        input,
      ),
    ).toEqual({ kind: "held", reason: "team_not_allowed" });
  });
  it("an explicit allowlist admits only that exact team", () => {
    const policy = parseSendingProviderPolicy(
      JSON.stringify({ version: 1, allowedTeamIds: [TEAM] }),
    );
    expect(resolveSendingProvider(policy, input).kind).toBe("selected");
    expect(resolveSendingProvider(policy, { ...input, teamId: OTHER })).toEqual({
      kind: "held",
      reason: "team_not_allowed",
    });
  });
  it("isolates message classes and gives the exact team route precedence", () => {
    const policy = parseSendingProviderPolicy(
      JSON.stringify({
        version: 1,
        defaults: { transactional: "ses", campaign: "customer_smtp" },
        teams: { [TEAM]: { campaign: "ses" } },
      }),
    );
    expect(resolveSendingProvider(policy, { ...input, messageClass: "campaign" })).toEqual({
      kind: "selected",
      provider: "ses",
      source: "team",
    });
    expect(
      resolveSendingProvider(policy, { ...input, teamId: OTHER, messageClass: "campaign" }),
    ).toEqual({ kind: "selected", provider: "customer_smtp", source: "default" });
    expect(resolveSendingProvider(policy, { ...input, teamId: OTHER })).toEqual({
      kind: "selected",
      provider: "ses",
      source: "default",
    });
  });
  it("does not use a domain's relay unless it is actually available and authorized", () => {
    const policy = parseSendingProviderPolicy(
      '{"version":1,"defaults":{"transactional":"customer_smtp"}}',
    );
    expect(
      resolveSendingProvider(policy, { ...input, availableProviders: new Set(["ses"]) }),
    ).toEqual({ kind: "held", reason: "provider_unavailable" });
  });
  it("a future provider name does not enable or register an adapter", () => {
    const policy = parseSendingProviderPolicy('{"version":1,"defaults":{"campaign":"smtp2go"}}');
    expect(resolveSendingProvider(policy, { ...input, messageClass: "campaign" })).toEqual({
      kind: "held",
      reason: "provider_unavailable",
    });
  });
  it("never falls back to SMTP when SES is blocked", () => {
    expect(resolveSendingProvider(null, { ...input, blockedProviders: new Set(["ses"]) })).toEqual({
      kind: "held",
      reason: "provider_paused",
    });
  });
  it("does not fallback after a selected relay is blocked", () => {
    const policy = parseSendingProviderPolicy(
      '{"version":1,"defaults":{"transactional":"customer_smtp"}}',
    );
    expect(
      resolveSendingProvider(policy, { ...input, blockedProviders: new Set(["customer_smtp"]) }),
    ).toEqual({ kind: "held", reason: "provider_paused" });
  });
  it.each([
    "{",
    '{"version":2}',
    '{"version":1,"paused":"false"}',
    '{"version":1,"allowAll":true}',
    '{"version":1,"teams":{"not-a-team":{"campaign":"ses"}}}',
    '{"version":1,"defaults":{"campaign":"https://host/secret"}}',
  ])("rejects malformed policy without returning legacy mode: %s", (raw) => {
    expect(() => parseSendingProviderPolicy(raw)).toThrow();
  });
  it("rejects duplicate team entries", () => {
    expect(() =>
      parseSendingProviderPolicy(JSON.stringify({ version: 1, allowedTeamIds: [TEAM, TEAM] })),
    ).toThrow("sending_provider_policy_duplicate_team");
  });
});
