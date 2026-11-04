import { describe, expect, it } from "vitest";
import {
  parseSendingProviderPolicy,
  resolveSendingProvider,
  restorationSenderAllowed,
} from "./sending-provider-policy.js";

const team = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const notBefore = "2026-01-01T00:00:00Z";

function policy() {
  return parseSendingProviderPolicy(
    JSON.stringify({
      version: 1,
      allowedTeamIds: [team, other],
      defaults: { transactional: "disabled", campaign: "disabled" },
      teams: { [team]: { transactional: "azure_smtp", campaign: "disabled" } },
      restoration: { teams: { [team]: { notBefore, senders: ["donotreply@acme.dev"] } } },
    }),
  );
}

describe("restorationSenderAllowed", () => {
  it("admits only the cohort's listed senders, case-insensitively", () => {
    const p = policy();
    expect(restorationSenderAllowed(p, team, "donotreply@acme.dev")).toBe(true);
    expect(restorationSenderAllowed(p, team, " DoNotReply@Acme.dev ")).toBe(true);
    expect(restorationSenderAllowed(p, team, "other@acme.dev")).toBe(false);
    expect(restorationSenderAllowed(p, team, "")).toBe(false);
    expect(restorationSenderAllowed(p, team, null)).toBe(false);
  });

  it("does not fence a team outside restoration.teams, or without restoration", () => {
    expect(restorationSenderAllowed(policy(), other, "anyone@else.dev")).toBe(true);
    expect(restorationSenderAllowed(null, team, "anyone@else.dev")).toBe(true);
    expect(restorationSenderAllowed(undefined, team, "anyone@else.dev")).toBe(true);
    const plain = parseSendingProviderPolicy(JSON.stringify({ version: 1 }));
    expect(restorationSenderAllowed(plain, team, "anyone@else.dev")).toBe(true);
  });

  it("is the rule resolveSendingProvider applies to the cohort sender", () => {
    const p = policy();
    const route = (fromAddress: string) =>
      resolveSendingProvider(p, {
        teamId: team,
        messageClass: "transactional",
        createdAt: new Date("2026-02-01T00:00:00Z"),
        fromAddress,
        legacyProvider: "ses",
        availableProviders: new Set(["azure_smtp"]),
      });
    for (const from of ["donotreply@acme.dev", "other@acme.dev", "DONOTREPLY@ACME.DEV"]) {
      expect(route(from).kind === "selected").toBe(restorationSenderAllowed(p, team, from));
    }
    expect(route("other@acme.dev")).toEqual({ kind: "held", reason: "restoration_fenced" });
  });
});
