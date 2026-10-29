import { randomUUID } from "node:crypto";
import { hashRecipient } from "@millionsend/core";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb, createWebhookEndpoint } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { azureEmailEventStore, azureEventAuditId } from "../src/server/azure-email-event-store";
import { AZURE_EMAIL_SOURCE, handleAzureEmailEvents } from "../src/server/azure-email-events";

let fixture: Awaited<ReturnType<typeof createTestDb>>;
let team: string;
beforeAll(async () => {
  fixture = await createTestDb();
  team = await createTeam(fixture.db, "azure-operational");
  await createWebhookEndpoint(fixture.db, team, null);
});
afterAll(async () => fixture?.close());
const now = new Date();
const env = {
  AZURE_EMAIL_EVENT_TOKEN: "synthetic-public-fixture-never-a-live-credential",
  AZURE_EMAIL_EVENT_TOPIC: AZURE_EMAIL_SOURCE,
  AZURE_EMAIL_EVENT_TEAM_ID: "00000000-0000-4000-8000-000000000001",
  AZURE_EMAIL_EVENT_SUBSCRIPTION: "synthetic-operational",
  AZURE_EMAIL_EVENT_ALLOWED_RECIPIENTS: "pilot@example.invalid",
  AZURE_EMAIL_EVENT_OPERATIONAL: "1",
};
function event(receipt: string, status = "Delivered", id: string = randomUUID()) {
  return {
    id,
    topic: AZURE_EMAIL_SOURCE,
    eventType: "Microsoft.Communication.EmailDeliveryReportReceived",
    eventTime: now.toISOString(),
    dataVersion: "1.0",
    metadataVersion: "1",
    data: {
      messageId: receipt,
      recipient: `own+${receipt}@example.invalid`,
      status,
      deliveryAttemptTimestamp: now.toISOString(),
    },
  };
}
async function receive(events: ReturnType<typeof event>[]) {
  return handleAzureEmailEvents(
    new Request("https://fixture.invalid/api/provider-events/azure", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "aeg-event-type": "Notification",
        "aeg-subscription-name": env.AZURE_EMAIL_EVENT_SUBSCRIPTION,
        "x-mepmail-azure-event-token": env.AZURE_EMAIL_EVENT_TOKEN,
      },
      body: JSON.stringify(events),
    }),
    { env, store: () => azureEmailEventStore(fixture.db), now: () => now.getTime() },
  );
}
async function seed(receipt = randomUUID(), sentAt: Date | null = now) {
  const [row] = await fixture.db
    .insert(schema.emails)
    .values({
      teamId: team,
      from: "DoNotReply@example.invalid",
      to: [`own+${receipt}@example.invalid`],
      subject: "Synthetic operational fixture",
      sentAt,
      latestStatus: "queued",
      sesMessageId: sentAt ? `smtp-relay:azure:${receipt}` : null,
    })
    .returning();
  if (!row) throw new Error("seed failed");
  return { row, receipt };
}
async function count(
  table: typeof schema.emailEvents | typeof schema.webhookDeliveries | typeof schema.suppressions,
) {
  const [row] = await fixture.db.select({ n: sql<number>`count(*)::int` }).from(table);
  return row?.n ?? 0;
}
it("Delivery commits status, daily/hourly counters and webhook outbox once", async () => {
  const { row, receipt } = await seed();
  const before = await count(schema.webhookDeliveries);
  const callback = event(receipt);
  expect((await receive([callback])).status).toBe(200);
  expect((await receive([callback])).status).toBe(200);
  const [email] = await fixture.db.select().from(schema.emails).where(eq(schema.emails.id, row.id));
  expect(email?.latestStatus).toBe("delivered");
  expect(
    await fixture.db
      .select()
      .from(schema.emailEvents)
      .where(eq(schema.emailEvents.emailId, row.id)),
  ).toHaveLength(1);
  expect(await count(schema.webhookDeliveries)).toBe(before + 1);
  const usage = await fixture.db.execute(
    sql`select delivered from usage_counters where team_id=${team}`,
  );
  expect(JSON.stringify(usage)).toContain('"delivered":1');
  const hourly = await fixture.db.execute(
    sql`select sum(delivered)::int as delivered from usage_counters_hourly where team_id=${team}`,
  );
  expect(JSON.stringify(hourly)).toContain('"delivered":1');
});
it("hard bounce atomically suppresses and writes both outbox events", async () => {
  const { row, receipt } = await seed();
  const before = await count(schema.webhookDeliveries);
  const callback = event(receipt, "Bounced");
  expect((await receive([callback])).status).toBe(200);
  expect((await receive([callback])).status).toBe(200);
  const [suppression] = await fixture.db
    .select()
    .from(schema.suppressions)
    .where(eq(schema.suppressions.emailHash, hashRecipient(`own+${receipt}@example.invalid`)));
  expect(suppression).toMatchObject({ teamId: team, reason: "hard_bounce", sourceEmailId: row.id });
  expect(await count(schema.webhookDeliveries)).toBe(before + 2);
});
it.each(["FilteredSpam", "Suppressed"])(
  "%s never becomes a complaint or new bounce",
  async (status) => {
    const { row, receipt } = await seed();
    const before = await count(schema.suppressions);
    expect((await receive([event(receipt, status)])).status).toBe(200);
    const [email] = await fixture.db
      .select()
      .from(schema.emails)
      .where(eq(schema.emails.id, row.id));
    expect(email?.latestStatus).toBe("failed");
    const events = await fixture.db
      .select()
      .from(schema.emailEvents)
      .where(eq(schema.emailEvents.emailId, row.id));
    expect(events.map((e) => e.type)).toEqual(["failed"]);
    expect(await count(schema.suppressions)).toBe(before);
  },
);
it("early receipt returns 503 without consuming dedupe; retry succeeds after persistence", async () => {
  const { row, receipt } = await seed(randomUUID(), null);
  const callback = event(receipt);
  expect((await receive([callback])).status).toBe(503);
  expect(
    await fixture.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.id, azureEventAuditId(callback.id))),
  ).toHaveLength(0);
  await fixture.db
    .update(schema.emails)
    .set({ sentAt: now, sesMessageId: `smtp-relay:azure:${receipt}` })
    .where(eq(schema.emails.id, row.id));
  expect((await receive([callback])).status).toBe(200);
});
it("preempted audit actor rejects the entire batch including earlier valid effects", async () => {
  const first = await seed();
  const second = await seed();
  const a = event(first.receipt, "Delivered", "a-valid-batch");
  const b = event(second.receipt, "Delivered", "z-preempted-batch");
  await fixture.db.insert(schema.auditLog).values({
    id: azureEventAuditId(b.id),
    teamId: team,
    actorId: "other-actor",
    action: "sending.azure_delivery_report",
    data: {
      provider: "azure",
      messageId: second.receipt,
      eventId: b.id,
      status: "delivered",
      recipientHash: hashRecipient(`own+${second.receipt}@example.invalid`),
      eventTime: now.toISOString(),
      deliveryAttemptTime: now.toISOString(),
    },
  });
  const before = await count(schema.webhookDeliveries);
  expect((await receive([a, b])).status).toBe(409);
  expect(
    await fixture.db
      .select()
      .from(schema.emailEvents)
      .where(eq(schema.emailEvents.emailId, first.row.id)),
  ).toHaveLength(0);
  expect(await count(schema.webhookDeliveries)).toBe(before);
});
it("outbox failure rolls back audit, event, status, counters and suppression; retry recovers", async () => {
  const { row, receipt } = await seed();
  const callback = event(receipt, "Bounced");
  await fixture.db.execute(
    sql`alter table webhook_deliveries add constraint azure_fixture_failure check(event_type <> 'email.bounced') not valid`,
  );
  try {
    expect((await receive([callback])).status).toBe(503);
    expect(
      await fixture.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.id, azureEventAuditId(callback.id))),
    ).toHaveLength(0);
    expect(
      await fixture.db
        .select()
        .from(schema.emailEvents)
        .where(eq(schema.emailEvents.emailId, row.id)),
    ).toHaveLength(0);
    const [email] = await fixture.db
      .select()
      .from(schema.emails)
      .where(eq(schema.emails.id, row.id));
    expect(email?.latestStatus).toBe("queued");
  } finally {
    await fixture.db.execute(
      sql`alter table webhook_deliveries drop constraint azure_fixture_failure`,
    );
  }
  expect((await receive([callback])).status).toBe(200);
});
it("overlapping duplicate callbacks commit exactly once; conflicting payload returns 409", async () => {
  const { row, receipt } = await seed();
  const callback = event(receipt, "Bounced");
  const before = await count(schema.webhookDeliveries);
  expect(
    (await Promise.all([receive([callback]), receive([callback])])).map((r) => r.status),
  ).toEqual([200, 200]);
  expect(
    await fixture.db
      .select()
      .from(schema.emailEvents)
      .where(eq(schema.emailEvents.emailId, row.id)),
  ).toHaveLength(1);
  expect(await count(schema.webhookDeliveries)).toBe(before + 2);
  const [suppression] = await fixture.db
    .select()
    .from(schema.suppressions)
    .where(eq(schema.suppressions.emailHash, hashRecipient(`own+${receipt}@example.invalid`)));
  expect(suppression).toMatchObject({ teamId: team, reason: "hard_bounce", sourceEmailId: row.id });
  expect(
    (await receive([{ ...callback, data: { ...callback.data, status: "Delivered" } }])).status,
  ).toBe(409);
});
