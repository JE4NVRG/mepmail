import { createRequire } from "node:module";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import {
  auditedHeldReviewRead,
  privateAudit,
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

  it("stores readable JSONB proof objects with the raw postgres.js serializers", async () => {
    const validatedRequest = validateHeldReviewRequest(request, manifest, operationId, now);
    const loadFromDb = createRequire(new URL("../../db/package.json", import.meta.url));
    const connect = loadFromDb("postgres") as (options: object) => {
      options: { serializers: Record<number, (value: unknown) => string> };
      end(): Promise<void>;
    };
    // Never execute a driver query: its real serializers run against PostgreSQL in memory.
    // Drizzle replaces JSON serializers and would mask the manual reader's regression.
    const driver = connect({
      host: "127.0.0.1",
      port: 1,
      username: "fixture",
      password: "fixture",
      database: "fixture",
      prepare: false,
    });
    const db = new PGlite({ serializers: driver.options.serializers });
    try {
      await db.exec(`create table audit_log (
        team_id uuid, actor_id text, action text, target text, data jsonb
      )`);
      // This control reproduces the broken raw-driver binding, not a JSON.parse mock.
      const broken = await db.query<{ kind: string; operation_id: string | null }>(
        "select jsonb_typeof($1::jsonb) as kind, $1::jsonb->>'operationId' as operation_id",
        [JSON.stringify(request)],
      );
      expect(broken.rows).toEqual([{ kind: "string", operation_id: null }]);

      const tx = async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.reduce(
          (text, part, index) => text + (index ? `$${index}` : "") + part,
          "",
        );
        return (await db.query<Record<string, unknown>>(query, values)).rows;
      };
      for (const action of [
        "console.held_message_review_started",
        "console.held_message_review_prepared",
      ]) {
        await privateAudit(
          tx as Parameters<typeof privateAudit>[0],
          validatedRequest,
          action,
          validatedRequest,
        );
      }
      const stored = await db.query<{
        kind: string;
        data: typeof request;
        operation_id: string;
        actor_id: string;
        target: string;
      }>(`select jsonb_typeof(data) as kind, data, data->>'operationId' as operation_id,
        actor_id, target from audit_log where team_id is null order by action`);
      expect(stored.rows).toEqual(
        Array.from({ length: 2 }, () => ({
          kind: "object",
          data: request,
          operation_id: operationId,
          actor_id: `user:${request.operatorId}`,
          target: `email:${request.emailId}`,
        })),
      );
      const proof = await db.query<{ count: number }>(
        `select count(*)::int as count from audit_log where team_id is null
          and actor_id=$1 and target=$2 and action='console.held_message_review_prepared'
          and data->>'operationId'=$3`,
        [`user:${request.operatorId}`, `email:${request.emailId}`, operationId],
      );
      expect(proof.rows).toEqual([{ count: 1 }]);
    } finally {
      await db.close();
      await driver.end();
    }
  });
});
