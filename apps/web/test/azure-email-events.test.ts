import { createHash } from "node:crypto";
import { schema } from "@millionsend/db";
import { createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/provider-events/azure/route";
import { azureEmailEventStore, azureEventAuditId } from "../src/server/azure-email-event-store";
import {
  AZURE_EMAIL_SOURCE,
  AZURE_EVENT_MAX_BYTES,
  handleAzureEmailEvents,
} from "../src/server/azure-email-events";

const { getDb } = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@millionsend/db", async (original) => ({
  ...(await original<typeof import("@millionsend/db")>()),
  getDb,
}));

// Deliberately synthetic fixture, NEVER a credential for any live endpoint.
const env = {
  NODE_ENV: "test" as const,
  AZURE_EMAIL_EVENT_TOKEN: "synthetic-only-azure-event-token-not-a-real-secret",
  AZURE_EMAIL_EVENT_TOPIC: AZURE_EMAIL_SOURCE,
  AZURE_EMAIL_EVENT_TEAM_ID: "c2c23da1-544c-4c3b-8a84-f2e9bb3cfa4e",
  AZURE_EMAIL_EVENT_SUBSCRIPTION: "mepmail-own-pilot-fixture",
  AZURE_EMAIL_EVENT_ALLOWED_RECIPIENTS: "own-pilot@example.invalid",
};
const now = Date.parse("2026-10-28T12:00:00.000Z");
function event(id = "event-1", status = "Delivered") {
  return {
    id,
    topic: AZURE_EMAIL_SOURCE,
    eventType: "Microsoft.Communication.EmailDeliveryReportReceived",
    eventTime: new Date(now).toISOString(),
    dataVersion: "1.0",
    metadataVersion: "1",
    subject: "DROP-ME-SUBJECT",
    data: {
      recipient: "own-pilot@example.invalid",
      messageId: "message-fixture-1",
      status,
      deliveryAttemptTimeStamp: new Date(now - 1000).toISOString(),
      deliveryStatusDetails: { statusMessage: "DROP-ME-DIAGNOSTIC" },
      body: "DROP-ME-BODY",
      teamId: "untrusted-team",
    },
  };
}
function request(
  body: unknown,
  headers: Record<string, string> = {},
  url = "https://fixture.invalid/api/provider-events/azure",
) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "aeg-event-type": "Notification",
      "aeg-subscription-name": env.AZURE_EMAIL_EVENT_SUBSCRIPTION,
      "x-mepmail-azure-event-token": env.AZURE_EMAIL_EVENT_TOKEN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("own-pilot Azure Event Grid receiver", () => {
  let fixture: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    fixture = await createTestDb();
    getDb.mockReturnValue(fixture.db);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await fixture?.close();
  });
  const noStore = vi.fn(() => {
    throw new Error("unexpected persistence");
  });
  const reject = (req: Request, configuration: NodeJS.ProcessEnv = env) =>
    handleAzureEmailEvents(req, { env: configuration, store: noStore, now: () => now });
  const accept = (req: Request) =>
    handleAzureEmailEvents(req, {
      env,
      store: () => azureEmailEventStore(fixture.db),
      now: () => now,
    });

  it("fails closed for every missing config and malformed server config before persistence", async () => {
    for (const key of Object.keys(env).filter((name) => name.startsWith("AZURE_EMAIL_EVENT_"))) {
      expect((await reject(request([event()]), { ...env, [key]: undefined })).status).toBe(503);
    }
    for (const patch of [
      { AZURE_EMAIL_EVENT_TOKEN: "short" },
      { AZURE_EMAIL_EVENT_TOPIC: "/other/resource" },
      { AZURE_EMAIL_EVENT_TEAM_ID: "bad" },
      { AZURE_EMAIL_EVENT_ALLOWED_RECIPIENTS: "not-email" },
      { AZURE_EMAIL_EVENT_SUBSCRIPTION: "invalid subscription" },
    ])
      expect((await reject(request([event()]), { ...env, ...patch })).status).toBe(503);
    expect(noStore).not.toHaveBeenCalled();
  });

  it("rejects missing/wrong notification tokens and query credentials", async () => {
    for (const token of ["", "incorrect-token", "x".repeat(4097)]) {
      expect(
        (await reject(request([event()], { "x-mepmail-azure-event-token": token }))).status,
      ).toBe(401);
    }
    const missing = request([event()]);
    missing.headers.delete("x-mepmail-azure-event-token");
    expect((await reject(missing)).status).toBe(401);
    expect(
      (
        await reject(
          request(
            [event()],
            {},
            "https://fixture.invalid/api/provider-events/azure?token=synthetic",
          ),
        )
      ).status,
    ).toBe(400);
    expect(noStore).not.toHaveBeenCalled();
  });

  it("rejects wrong resource/subscription/recipient/type/version/status and stale/future timestamps", async () => {
    const base = event();
    for (const patch of [
      { topic: "/another-resource" },
      { eventType: "Microsoft.Communication.EmailEngagementTrackingReportReceived" },
      { dataVersion: "2.0" },
      { metadataVersion: "2" },
      { eventTime: "not-a-date" },
      { eventTime: new Date(now - 27 * 3600000).toISOString() },
      { eventTime: new Date(now + 301000).toISOString() },
      { data: { ...base.data, recipient: "customer@example.invalid" } },
      { data: { ...base.data, status: "Complaint" } },
      { data: { ...base.data, deliveryAttemptTimeStamp: "invalid" } },
      { data: { ...base.data, messageId: "x".repeat(257) } },
    ])
      expect((await reject(request([{ ...base, ...patch }]))).status).toBeGreaterThanOrEqual(400);
    expect((await reject(request([base], { "aeg-subscription-name": "other" }))).status).toBe(403);
    expect((await reject(request([base], { "aeg-event-type": "Other" }))).status).toBe(400);
    expect(noStore).not.toHaveBeenCalled();
  });

  it("bounds bytes/array and rejects malformed JSON without persistence", async () => {
    for (const body of [[], {}, Array.from({ length: 51 }, () => event())]) {
      expect((await reject(request(body))).status).toBe(400);
    }
    expect(
      (await reject(request([event()], { "content-length": String(AZURE_EVENT_MAX_BYTES + 1) })))
        .status,
    ).toBe(413);
    expect((await reject(request("x".repeat(AZURE_EVENT_MAX_BYTES)))).status).toBe(413);
    expect((await reject(request([event()], { "content-type": "text/plain" }))).status).toBe(415);
    const bad = request([event()]);
    const malformed = new Request(bad.url, { method: "POST", headers: bad.headers, body: "[" });
    expect((await reject(malformed)).status).toBe(400);
    expect(noStore).not.toHaveBeenCalled();
  });

  it("requires token for synchronous challenge without DB or external fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
    const challenge = {
      ...event(),
      eventType: "Microsoft.EventGrid.SubscriptionValidationEvent",
      dataVersion: "1",
      data: {
        validationCode: "synthetic-challenge",
        validationUrl: "http://169.254.169.254/forbidden",
      },
    };
    const req = request([challenge], { "aeg-event-type": "SubscriptionValidation" });
    const missing = request([challenge], { "aeg-event-type": "SubscriptionValidation" });
    missing.headers.delete("x-mepmail-azure-event-token");
    expect((await reject(missing)).status).toBe(401);
    expect(
      (
        await reject(
          request([challenge], {
            "aeg-event-type": "SubscriptionValidation",
            "x-mepmail-azure-event-token": "incorrect-token",
          }),
        )
      ).status,
    ).toBe(401);
    const response = await reject(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ validationResponse: "synthetic-challenge" });
    expect(
      (
        await reject(
          request([challenge], {
            "aeg-event-type": "SubscriptionValidation",
            "aeg-subscription-name": "other",
          }),
        )
      ).status,
    ).toBe(403);
    // Real Azure provisioning metadata is not the delivery-report source.
    // Auth and exact subscription remain mandatory; this cannot persist data.
    const provisioned = await reject(
      request([{ ...challenge, topic: "/control-plane/validation" }], {
        "aeg-event-type": "SubscriptionValidation",
      }),
    );
    expect(provisioned.status).toBe(200);
    expect(await provisioned.json()).toEqual({ validationResponse: "synthetic-challenge" });
    const unauthenticated = request([{ ...challenge, topic: "/control-plane/validation" }], {
      "aeg-event-type": "SubscriptionValidation",
    });
    unauthenticated.headers.delete("x-mepmail-azure-event-token");
    expect((await reject(unauthenticated)).status).toBe(401);
    expect(
      (await reject(request([{ ...event(), topic: "/control-plane/validation" }]))).status,
    ).toBe(403);
    expect(
      (await reject(request([challenge, event()], { "aeg-event-type": "SubscriptionValidation" })))
        .status,
    ).toBe(400);
    expect((await reject(request([challenge]))).status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(noStore).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("persists one audit across concurrent/restarted delivery, with exact metadata projection", async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => accept(request([event("concurrent")]))),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect((await accept(request([event("concurrent")]))).status).toBe(200);
    const rows = await fixture.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.id, azureEventAuditId("concurrent")));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.teamId).toBe(env.AZURE_EMAIL_EVENT_TEAM_ID);
    expect(rows[0]?.data).toEqual({
      provider: "azure",
      eventId: "concurrent",
      messageId: "message-fixture-1",
      status: "delivered",
      recipientHash: createHash("sha256").update("own-pilot@example.invalid").digest("hex"),
      eventTime: new Date(now).toISOString(),
      deliveryAttemptTime: new Date(now - 1000).toISOString(),
    });
    expect(JSON.stringify(rows)).not.toMatch(/DROP-ME|own-pilot@|untrusted-team|synthetic-only/);
  });

  it("rejects conflicting immutable ID and rolls back the entire batch", async () => {
    expect((await accept(request([event("conflict")]))).status).toBe(200);
    expect(
      (await accept(request([event("conflict", "Bounced"), event("atomic-new")]))).status,
    ).toBe(409);
    expect(
      await fixture.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.id, azureEventAuditId("atomic-new"))),
    ).toHaveLength(0);
    expect(
      (await accept(request([event("same-batch"), event("same-batch", "Suppressed")]))).status,
    ).toBe(409);
    expect(
      await fixture.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.id, azureEventAuditId("same-batch"))),
    ).toHaveLength(0);
  });

  it("normalizes hard bounce/suppressed and never calls spam filtering a complaint", async () => {
    for (const [providerStatus, normalized] of [
      ["Bounced", "hard_bounce"],
      ["Suppressed", "suppressed"],
      ["FilteredSpam", "filtered_spam"],
      ["Failed", "failed"],
      ["Quarantined", "quarantined"],
      ["Expanded", "expanded"],
    ]) {
      const id = `normal-${providerStatus}`;
      expect((await accept(request([event(id, providerStatus)]))).status).toBe(200);
      const [row] = await fixture.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.id, azureEventAuditId(id)));
      expect(row?.data?.status).toBe(normalized);
    }
    expect(await fixture.db.select().from(schema.suppressions)).toHaveLength(0);
    expect(await fixture.db.select().from(schema.emails)).toHaveLength(0);
  });

  it("real migration trigger rejects UPDATE and DELETE (negative controls)", async () => {
    await expect(
      fixture.db
        .update(schema.auditLog)
        .set({ action: "tampered" })
        .where(eq(schema.auditLog.id, azureEventAuditId("concurrent"))),
    ).rejects.toThrow();
    await expect(
      fixture.db
        .delete(schema.auditLog)
        .where(eq(schema.auditLog.id, azureEventAuditId("concurrent"))),
    ).rejects.toThrow();
  });

  it("exercises actual Next POST binding and fails persistence closed", async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect((await POST(request([event("route-binding")]))).status).toBe(200);
    expect(getDb).toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(
      (
        await handleAzureEmailEvents(request([event()]), {
          env,
          now: () => now,
          store: () => ({
            append: async () => {
              throw new Error("private DB details");
            },
          }),
        })
      ).status,
    ).toBe(503);
  });
});
