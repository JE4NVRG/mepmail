import { randomBytes, randomUUID } from "node:crypto";
import { EnvKeyring, generateApiKey } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createApi } from "../../api/src/app";
import { sendBroadcast } from "../../worker/src/handlers/send-broadcast";
import { createCaller } from "../src/server/routers";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  vi.stubEnv("IS_CLOUD", "true");
  ({ db, close } = await createTestDb());
});
afterAll(async () => {
  await close?.();
  vi.unstubAllEnvs();
});
const evidence = {
  listReference: "list-***test",
  source: "Direct signup from our own product site",
  method: "Explicit unchecked opt-in checkbox",
  formUrl: "https://example.test/signup",
  permissionText: "I agree to receive the Example monthly newsletter.",
  permissionScope: "Monthly product news from Example only",
  samples: [
    { reference: "signup-***42", registeredAt: "2026-01-01T12:00:00.000Z", ipAvailable: false },
  ],
};
it("real API/router/fanout reject absent consent and API imports work only after independent approval", async () => {
  const teamId = await createTeam(db, randomUUID());
  const key = generateApiKey();
  await db.insert(schema.user).values([
    {
      id: "synthetic-independent-operator",
      name: "Synthetic operator",
      email: "operator@example.test",
      emailVerified: true,
      createdAt: new Date("2025-01-01T00:00:00Z"),
    },
    {
      id: "synthetic-owner",
      name: "Synthetic owner",
      email: "owner@example.test",
      emailVerified: true,
    },
  ]);
  await db.insert(schema.teamMembers).values({ teamId, userId: "synthetic-owner", role: "owner" });
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "synthetic",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  await db
    .update(schema.teams)
    .set({ sendReviewClearedAt: new Date() })
    .where(eq(schema.teams.id, teamId));
  const dnsRecords = [
    {
      group: "verification",
      name: "test._domainkey.consent.example.test",
      type: "TXT",
      status: "found" as const,
    },
    { group: "sending", name: "send.consent.example.test", type: "TXT", status: "found" as const },
    { group: "sending", name: "send.consent.example.test", type: "MX", status: "found" as const },
    { group: "dmarc", name: "_dmarc.consent.example.test", type: "TXT", status: "found" as const },
  ];
  await db.insert(schema.domains).values({
    teamId,
    name: "consent.example.test",
    dkimSelector: "test",
    region: "eu-west-1",
    status: "verified",
    dmarcPolicy: "none",
    dmarcCheckedAt: new Date(),
    dnsRecords,
  });
  const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
  const app = createApi({
    db,
    keyring,
    isCloud: true,
    enqueueEmailSend: async () => {},
    appBaseUrl: "https://example.test",
  });
  const call = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${key.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await call("/contacts", { email: "synthetic@example.test" })).status).toBe(403);
  expect((await call("/contacts/batch", [{ email: "synthetic@example.test" }])).status).toBe(403);
  const caller = createCaller({
    db,
    session: { user: { id: "synthetic-owner", email: "owner@example.test", name: "Synthetic" } },
    teamId,
    role: "owner",
  });
  const operator = createCaller({
    db,
    session: {
      user: {
        id: "synthetic-independent-operator",
        email: "operator@example.test",
        name: "Synthetic operator",
      },
    },
    teamId: null,
    role: null,
  });
  await expect(
    caller.audience.contacts.addMany({ rows: [{ email: "synthetic@example.test" }] }),
  ).rejects.toThrow("opt-in");
  await expect(
    caller.audience.consent.review({
      teamId,
      dossierId: randomUUID(),
      decision: "approved",
      reason: "Owner must never approve self",
    }),
  ).rejects.toThrow();
  const [broadcast] = await db
    .insert(schema.broadcasts)
    .values({
      teamId,
      from: "service@consent.example.test",
      subject: "Reset password",
      text: "Newsletter",
      status: "scheduled",
    })
    .returning();
  if (!broadcast) throw new Error("Synthetic broadcast insert failed");
  const enqueueEmailSends = vi.fn();
  expect(
    await sendBroadcast(
      db,
      {
        keyring,
        unsubscribeSecretKey: randomBytes(32),
        unsubscribeBaseUrl: "https://example.test",
        isCloud: true,
        enqueueEmailSends,
      },
      { broadcastId: broadcast.id },
    ),
  ).toBe("deferred");
  expect(enqueueEmailSends).not.toHaveBeenCalled();
  await db
    .update(schema.broadcasts)
    .set({ status: "draft" })
    .where(eq(schema.broadcasts.id, broadcast.id));
  expect(
    (await call(`/broadcasts/${broadcast.id}/send`, { marketing: false, transactional: true }))
      .status,
  ).toBe(403);
  const row = await caller.audience.consent.submit(evidence);
  const otherTeam = await createTeam(db, randomUUID());
  const foreignCaller = createCaller({
    db,
    session: { user: { id: "synthetic-owner", email: "owner@example.test", name: "Synthetic" } },
    teamId: otherTeam,
    role: "owner",
  });
  await expect(foreignCaller.audience.consent.status()).rejects.toThrow();
  await expect(foreignCaller.audience.consent.submit(evidence)).rejects.toThrow();
  expect((await call("/contacts", { email: "synthetic@example.test" })).status).toBe(403);
  await operator.audience.consent.review({
    teamId,
    dossierId: row.id,
    decision: "approved",
    reason: "Verified original synthetic consent records",
  });
  expect((await call("/contacts", { email: "synthetic@example.test" })).status).toBe(200);
  await operator.audience.consent.review({
    teamId,
    dossierId: row.id,
    decision: "revoked",
    reason: "Customer revoked the permission scope",
  });
  expect((await call("/contacts", { email: "second@example.test" })).status).toBe(403);
});
