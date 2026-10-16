import { describe, expect, it, vi } from "vitest";
import {
  auditedHeldReviewRead,
  validateHeldReviewRequest,
} from "../scripts/held-message-review-reader.js";

const now = new Date("2026-10-16T22:00:00.000Z");
const manifest = {
  schemaVersion: 1,
  teamId: "11111111-1111-4111-8111-111111111111",
  emailId: "22222222-2222-4222-8222-222222222222",
  operatorId: "synthetic-operator",
  audience: "held-message-review-staging",
  origin: "http://127.0.0.1:3186",
  stagingRevision: "a".repeat(40),
  productionRevision: "1f1b1d86b79235b21b1659bce5406c192448d269",
  productionBuildId: "B0p3pV58Z7_b0JFw1m7T3",
  helperSha256: "b".repeat(64),
  expiresAt: "2026-10-16T23:00:00.000Z",
};
const operationId = "33333333-3333-4333-8333-333333333333";
const request = {
  ...manifest,
  operationId,
  holdAt: "2026-10-15T00:00:00.000Z",
  issuedAt: now.toISOString(),
  expiresAt: "2026-10-16T22:30:00.000Z",
  reason: "payment_risk_review",
  justification: "Security review explicitly requested by the instance operator.",
};

describe("trusted held-review reader guards", () => {
  it("accepts only the authenticated operation's exact context", () => {
    expect(validateHeldReviewRequest(request, manifest, operationId, now)).toEqual(request);
    for (const key of [
      "teamId",
      "emailId",
      "operatorId",
      "stagingRevision",
      "helperSha256",
      "origin",
      "productionRevision",
    ])
      expect(() =>
        validateHeldReviewRequest({ ...request, [key]: "changed" }, manifest, operationId, now),
      ).toThrow();
    expect(() =>
      validateHeldReviewRequest(request, manifest, "44444444-4444-4444-8444-444444444444", now),
    ).toThrow();
  });

  it("rejects expired, future and overlong permissions", () => {
    for (const times of [
      { expiresAt: now.toISOString() },
      { issuedAt: "2026-10-16T22:01:00.000Z" },
      { expiresAt: "2026-10-16T22:30:00.001Z" },
    ])
      expect(() =>
        validateHeldReviewRequest({ ...request, ...times }, manifest, operationId, now),
      ).toThrow();
    expect(() =>
      validateHeldReviewRequest(
        request,
        { ...manifest, expiresAt: "2026-10-16T22:10:00.000Z" },
        operationId,
        now,
      ),
    ).toThrow();
  });

  it("does not decrypt if the durable start audit fails", async () => {
    const decrypt = vi.fn();
    await expect(
      auditedHeldReviewRead(async () => {
        throw new Error("audit unavailable");
      }, decrypt),
    ).rejects.toThrow();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("returns nothing if the read/completion transaction fails", async () => {
    const order: string[] = [];
    await expect(
      auditedHeldReviewRead(
        async () => {
          order.push("audit-committed");
        },
        async () => {
          order.push("decrypt");
          throw new Error("completion commit failed");
        },
      ),
    ).rejects.toThrow();
    expect(order).toEqual(["audit-committed", "decrypt"]);
  });
});
