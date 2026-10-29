import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSendingProviderPolicy } from "../../../packages/core/src/sending-provider-policy.js";
import { queueEmailAdmitted } from "../src/queue-admission.js";

const teamId = "11111111-1111-4111-8111-111111111111";
const ownId = "22222222-2222-4222-8222-222222222222";
const emailId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const createdAt = "2026-10-27T12:00:00.123456Z";
const cutoff = "2026-10-29T00:00:00Z";
const policy = parseSendingProviderPolicy(
  JSON.stringify({
    version: 1,
    allowedTeamIds: [teamId, ownId],
    defaults: { transactional: "disabled", campaign: "disabled" },
    teams: {
      [teamId]: { transactional: "disabled", campaign: "azure_smtp" },
      [ownId]: { transactional: "azure_smtp", campaign: "disabled" },
    },
    restoration: {
      teams: {
        [ownId]: {
          notBefore: cutoff,
          senders: Array.from({ length: 19 }, (_, i) => `own${i}@example.invalid`),
        },
      },
      campaignCohort: {
        teamId,
        from: "info@example.invalid",
        messages: [
          {
            emailId,
            createdAt,
            recipientHash: createHash("sha256").update("optin@example.invalid").digest("hex"),
          },
        ],
      },
    },
  }),
);
const admission = { policy, azureAvailable: true };
const row: Parameters<typeof queueEmailAdmitted>[0] = {
  id: emailId,
  teamId,
  createdAt: new Date(createdAt),
  from: "info@example.invalid",
  to: ["optin@example.invalid"],
  cc: null,
  bcc: [],
  sentAt: null,
  sesMessageId: null,
  latestStatus: "queued_quota",
  broadcastId: null,
  contactId: null,
  topicId: null,
};

describe("closed campaign queue admission", () => {
  it("admits the original parked row prospectively, without mutating it", () => {
    expect(queueEmailAdmitted(row, admission)).toBe(true);
    expect(row.latestStatus).toBe("queued_quota");
  });
  it.each([
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { from: "wrong@example.invalid" },
    { to: ["wrong@example.invalid"] },
    { cc: ["cc@example.invalid"] },
    { bcc: ["bcc@example.invalid"] },
    { createdAt: new Date("2026-10-27T12:00:00.124Z") },
    { sentAt: new Date() },
    { sesMessageId: "prior-accepted" },
  ])("holds unlisted or mismatched originals: %j", (patch) => {
    expect(queueEmailAdmitted({ ...row, ...patch }, admission)).toBe(false);
  });
  it("requires the adapter and preserves all nineteen own senders/cutoff", () => {
    expect(queueEmailAdmitted(row, { ...admission, azureAvailable: false })).toBe(false);
    for (let i = 0; i < 19; i++) {
      const own = {
        ...row,
        teamId: ownId,
        from: `own${i}@example.invalid`,
        createdAt: new Date(cutoff),
      };
      expect(queueEmailAdmitted(own, admission)).toBe(true);
      expect(queueEmailAdmitted({ ...own, createdAt: new Date(createdAt) }, admission)).toBe(false);
    }
  });
  it("does not change legacy/selfhost admission without restoration", () => {
    expect(queueEmailAdmitted(row, { policy: null, azureAvailable: false })).toBe(true);
  });
});
