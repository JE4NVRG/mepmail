import { randomBytes, randomUUID } from "node:crypto";
import { EnvKeyring, encryptWebhookSecret, generateWebhookSecret, utcDay } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sweepNotifications } from "../src/handlers/notify.js";
import * as notificationTemplates from "../src/notifications/templates.js";

let db: Db;
let close: () => Promise<void>;
let teamId: string;
let sends: { to: string; subject: string; text: string }[];
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  teamId = await createTeam(db, "deliverability-recovery-fixture");
  await db.insert(schema.user).values({ id: "owner", name: "Owner", email: "owner@example.com" });
  await db.insert(schema.teamMembers).values({ teamId, userId: "owner", role: "owner" });
  const id = randomUUID();
  const secret = generateWebhookSecret();
  const encrypted = await encryptWebhookSecret(secret, keyring, { teamId, rowId: id });
  await db.insert(schema.webhookEndpoints).values({
    id,
    teamId,
    url: "https://receiver.example.com/hook",
    secretCiphertext: encrypted.ciphertext,
    secretIv: encrypted.iv,
    secretWrappedDek: encrypted.wrappedDek,
    secretKeyVersion: encrypted.keyVersion,
    secretLast4: secret.slice(-4),
    events: null,
  });
  sends = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});

const deps = () => ({
  isCloud: true,
  mailer: {
    send: async (to: string, message: { subject: string; text: string }) => {
      sends.push({ to, subject: message.subject, text: message.text });
    },
  },
  enqueueWebhook: async () => {},
  appBaseUrl: "https://mepmail.dev",
});

async function counters(values: Partial<typeof schema.usageCounters.$inferInsert>) {
  await db.insert(schema.usageCounters).values({ teamId, day: utcDay(), ...values });
}

async function deliveries() {
  return db.select({ type: schema.webhookDeliveries.eventType }).from(schema.webhookDeliveries);
}

it("a failed preparation leaves no claim or dispatch and a later sweep safely retries", async () => {
  await counters({ sent: 200, complained: 3 });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(notificationTemplates, "deliverabilityPausedMail").mockImplementationOnce(() => {
    throw new Error("fixture preparation failure");
  });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });
  expect(sends).toHaveLength(0);
  expect(await deliveries()).toHaveLength(0);
  expect(
    await db
      .select()
      .from(schema.teamNotifications)
      .where(eq(schema.teamNotifications.teamId, teamId)),
  ).toHaveLength(0);

  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  expect(sends).toHaveLength(1);
  expect(await deliveries()).toHaveLength(1);
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });
});

it("an existing pause claim is preserved and never replays a previously delivered notice", async () => {
  const alreadySent = new Date("2026-10-05T09:10:00.000Z");
  await db.insert(schema.teamNotifications).values({
    teamId,
    kind: "deliverability",
    periodKey: "paused",
    sentAt: alreadySent,
  });
  await counters({ sent: 200, complained: 3 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });
  expect(sends).toHaveLength(0);
  expect(await deliveries()).toHaveLength(0);
  const [claim] = await db.select().from(schema.teamNotifications);
  expect(claim).toMatchObject({
    teamId,
    kind: "deliverability",
    periodKey: "paused",
    sentAt: alreadySent,
  });
});

it("partial owner delivery retains the episode claim instead of replaying accepted or ambiguous sends", async () => {
  await db
    .insert(schema.user)
    .values({ id: "second-owner", name: "Second", email: "second@example.com" });
  await db.insert(schema.teamMembers).values({ teamId, userId: "second-owner", role: "owner" });
  await counters({ sent: 200, complained: 3 });
  const attempts: string[] = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  const partial = {
    ...deps(),
    mailer: {
      send: async (to: string, m: { subject: string; text: string }) => {
        attempts.push(to);
        if (to === "second@example.com") throw new Error("fixture unknown dispatch outcome");
        sends.push({ to, subject: m.subject, text: m.text });
      },
    },
  };
  expect(await sweepNotifications(db, partial)).toEqual({ sent: 1 });
  expect(sends).toHaveLength(1);
  expect(attempts).toHaveLength(2);
  expect(await sweepNotifications(db, partial)).toEqual({ sent: 0 });
  expect(sends).toHaveLength(1);
  expect(attempts).toHaveLength(2);
  expect(await deliveries()).toHaveLength(1);
});

it("a legitimate deliverability opt-out is not treated as a failure to retry", async () => {
  await db
    .update(schema.user)
    .set({ mailOptOuts: ["deliverability"] })
    .where(eq(schema.user.id, "owner"));
  await counters({ sent: 200, complained: 3 });
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 1 });
  expect(sends).toHaveLength(0);
  expect(await deliveries()).toHaveLength(1);
  const [claim] = await db.select().from(schema.teamNotifications);
  expect(claim).toMatchObject({ teamId, kind: "deliverability", periodKey: "paused" });

  await db.update(schema.user).set({ mailOptOuts: [] }).where(eq(schema.user.id, "owner"));
  expect(await sweepNotifications(db, deps())).toEqual({ sent: 0 });
  expect(sends).toHaveLength(0);
  expect(await deliveries()).toHaveLength(1);
});
