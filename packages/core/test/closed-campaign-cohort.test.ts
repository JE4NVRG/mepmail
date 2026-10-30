import { createHash } from "node:crypto";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { claimAzureSend } from "../src/azure-send-claim.js";
import { campaignMessage } from "../src/campaign-consent.js";
import {
  parseSendingProviderPolicy,
  resolveSendingProvider,
} from "../src/sending-provider-policy.js";

let fixture: Awaited<ReturnType<typeof createTestDb>>;
let own: string;
let client: string;
const cutoff = "2026-10-29T18:00:43.173181Z";
const originalAt = "2026-10-27T12:34:56.123456Z";
const recipient = "subscriber@example.invalid";
const recipientHash = createHash("sha256").update(recipient).digest("hex");
beforeAll(async () => {
  fixture = await createTestDb();
  own = await createTeam(fixture.db, "closed-own");
  client = await createTeam(fixture.db, "closed-client");
});
afterAll(async () => fixture?.close());
async function seed() {
  const [row] = await fixture.db
    .insert(schema.emails)
    .values({
      teamId: client,
      from: "Business <news@example.invalid>",
      to: [recipient],
      cc: [],
      bcc: [],
      subject: "Subscriber training",
      latestStatus: "queued",
    })
    .returning();
  if (!row) throw new Error("seed failed");
  await fixture.db.execute(
    sql`update emails set created_at=${originalAt}::timestamptz where id=${row.id}`,
  );
  return row;
}
function policy(emailId: string) {
  return parseSendingProviderPolicy(
    JSON.stringify({
      version: 1,
      allowedTeamIds: [own, client],
      defaults: { transactional: "disabled", campaign: "disabled" },
      teams: {
        [own]: { transactional: "azure_smtp", campaign: "disabled" },
        [client]: { transactional: "disabled", campaign: "azure_smtp" },
      },
      restoration: {
        teams: { [own]: { notBefore: cutoff, senders: ["system@example.invalid"] } },
        campaignCohort: {
          sendWindow: { startsAt: "2000-01-01T00:00:00Z", endsAt: "2100-01-01T00:00:00Z" },
          teamId: client,
          from: "news@example.invalid",
          messages: [{ emailId, createdAt: originalAt, recipientHash }],
        },
      },
    }),
  );
}
function input(emailId: string) {
  return {
    teamId: client,
    emailId,
    messageClass: "campaign" as const,
    createdAt: new Date(originalAt),
    fromAddress: "news@example.invalid",
    to: [recipient],
    cc: [],
    bcc: [],
    sentAt: null,
    sesMessageId: null,
    latestStatus: "queued",
    legacyProvider: "ses" as const,
    availableProviders: new Set(["azure_smtp", "ses"]),
  };
}
it("admits only the original closed API campaign ID and keeps all own cutoff bytes", async () => {
  const row = await seed();
  const p = policy(row.id);
  expect(resolveSendingProvider(p, input(row.id)).kind).toBe("selected");
  expect(p?.restoration?.teams[own]?.notBefore).toBe(cutoff);
  expect(JSON.stringify(p)).not.toContain(recipient);
  for (const patch of [
    { emailId: own },
    { messageClass: "transactional" as const },
    { teamId: own },
    { sentAt: new Date() },
    { sesMessageId: "accepted" },
    { latestStatus: "queued_quota" },
    { cc: [recipient] },
    { bcc: [recipient] },
    { to: [recipient, recipient] },
    { to: ["other@example.invalid"] },
    { createdAt: new Date("2026-10-27T12:34:56.124Z") },
    { availableProviders: new Set(["ses"]) },
  ])
    expect(resolveSendingProvider(p, { ...input(row.id), ...patch }).kind).toBe("held");
  expect(
    resolveSendingProvider(p, {
      ...input(row.id),
      teamId: own,
      messageClass: "transactional",
      fromAddress: "system@example.invalid",
    }).kind,
  ).toBe("held");
  expect(
    resolveSendingProvider(p, {
      ...input(row.id),
      teamId: own,
      messageClass: "transactional",
      fromAddress: "system@example.invalid",
      createdAt: new Date(cutoff),
    }).kind,
  ).toBe("selected");
});
it("rejects a sixth cohort entry, duplicates and a cohort that overlaps own", async () => {
  const row = await seed();
  const p = policy(row.id);
  if (!p?.restoration?.campaignCohort) throw new Error("missing policy");
  const duplicated = structuredClone(p);
  duplicated.restoration!.campaignCohort!.messages.push({
    ...duplicated.restoration!.campaignCohort!.messages[0]!,
  });
  expect(() => parseSendingProviderPolicy(JSON.stringify(duplicated))).toThrow();
  const six = structuredClone(p);
  six.restoration!.campaignCohort!.messages = Array.from({ length: 6 }, () => ({
    ...six.restoration!.campaignCohort!.messages[0]!,
  }));
  expect(() => parseSendingProviderPolicy(JSON.stringify(six))).toThrow();
  const overlap = structuredClone(p);
  overlap.restoration!.campaignCohort!.teamId = own;
  expect(() => parseSendingProviderPolicy(JSON.stringify(overlap))).toThrow();
});
it("claims real jsonb recipients with the exact six-fraction timestamp and never replays a released attempt", async () => {
  const row = await seed();
  const request = {
    emailId: row.id,
    teamId: client,
    recipients: 1,
    campaignSnapshot: {
      sendWindow: { startsAt: "2000-01-01T00:00:00Z", endsAt: "2100-01-01T00:00:00Z" },
      createdAt: originalAt,
      from: row.from,
      to: [recipient],
    },
  };
  expect(await claimAzureSend(fixture.db, request)).toBe("claimed");
  await fixture.db.update(schema.emails).set({ sentAt: null }).where(eq(schema.emails.id, row.id));
  expect(await claimAzureSend(fixture.db, request)).toBe("skipped");
  const audits = await fixture.db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.teamId, client));
  expect(
    audits.filter(
      (a) => a.action === "sending.restoration_campaign_claimed" && a.data?.emailId === row.id,
    ),
  ).toHaveLength(1);
});
it("refuses a one-microsecond mutation without taking a claim", async () => {
  const row = await seed();
  await fixture.db.execute(
    sql`update emails set created_at=created_at+interval '1 microsecond' where id=${row.id}`,
  );
  expect(
    await claimAzureSend(fixture.db, {
      emailId: row.id,
      teamId: client,
      recipients: 1,
      campaignSnapshot: {
        sendWindow: { startsAt: "2000-01-01T00:00:00Z", endsAt: "2100-01-01T00:00:00Z" },
        createdAt: originalAt,
        from: row.from,
        to: [recipient],
      },
    }),
  ).toBe("skipped");
  const [stored] = await fixture.db
    .select()
    .from(schema.emails)
    .where(eq(schema.emails.id, row.id));
  expect(stored?.sentAt).toBeNull();
});
it("an internal declaration only adds campaign consent classification", () => {
  expect(
    campaignMessage({ declaredCampaign: true, to: [recipient], subject: "Subscriber training" }),
  ).toBe(true);
  expect(campaignMessage({ to: [recipient], subject: "Verification code" })).toBe(false);
});
