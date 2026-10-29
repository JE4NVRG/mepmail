import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { claimAzureSend } from "../src/azure-send-claim.js";
import {
  parseSendingProviderPolicy,
  resolveSendingProvider,
} from "../src/sending-provider-policy.js";

let fixture: Awaited<ReturnType<typeof createTestDb>>;
let team: string;
let other: string;
beforeAll(async () => {
  fixture = await createTestDb();
  team = await createTeam(fixture.db, "azure-claim");
  other = await createTeam(fixture.db, "azure-other");
});
afterAll(async () => fixture?.close());
async function seed(teamId = team, sentAt: Date | null = null) {
  const [email] = await fixture.db
    .insert(schema.emails)
    .values({
      teamId,
      from: "system@example.invalid",
      to: ["own@example.invalid"],
      subject: "Synthetic claim",
      latestStatus: "queued",
      sentAt,
    })
    .returning();
  if (!email) throw new Error("seed failed");
  return email;
}
it("claim is tenant-bound and old sentAt is never reset", async () => {
  const email = await seed();
  expect(
    await claimAzureSend(fixture.db, { emailId: email.id, teamId: other, recipients: 1 }),
  ).toBe("skipped");
  const old = await seed(team, new Date("2026-01-01T00:00:00Z"));
  expect(await claimAzureSend(fixture.db, { emailId: old.id, teamId: team, recipients: 1 })).toBe(
    "skipped",
  );
  const [stored] = await fixture.db
    .select()
    .from(schema.emails)
    .where(eq(schema.emails.id, old.id));
  expect(stored?.sentAt).toEqual(old.sentAt);
});
it("global quota spans tenants and overlapping transactions; claim is monotonic", async () => {
  const a = await seed();
  const b = await seed(other);
  const results = await Promise.all([
    claimAzureSend(fixture.db, { emailId: a.id, teamId: team, recipients: 20 }),
    claimAzureSend(fixture.db, { emailId: b.id, teamId: other, recipients: 20 }),
  ]);
  expect(results.sort()).toEqual(["claimed", "quota"]);
  const accepted = results[0] === "claimed" ? a : b;
  // A duplicate never acquires another claim, even when capacity is still available.
  const rows = await fixture.db.select().from(schema.emails);
  const claimed = rows.find((e) => e.sentAt && [a.id, b.id].includes(e.id));
  expect(claimed).toBeDefined();
  expect(
    await claimAzureSend(fixture.db, {
      emailId: claimed?.id ?? accepted.id,
      teamId: claimed?.teamId ?? accepted.teamId,
      recipients: 1,
    }),
  ).toBe("skipped");
  const result = await fixture.db.execute(
    sql`select sum((data->>'units')::int)::int as units from audit_log where action='sending.azure_quota_reserved'`,
  );
  expect(JSON.stringify(result)).toContain('"units":20');
});
it("audit failure rolls back the claim", async () => {
  const email = await seed();
  await fixture.db.execute(
    sql`alter table audit_log add constraint azure_claim_fixture_failure check(action <> 'sending.azure_quota_reserved') not valid`,
  );
  try {
    await expect(
      claimAzureSend(fixture.db, { emailId: email.id, teamId: team, recipients: 1 }),
    ).rejects.toThrow();
  } finally {
    await fixture.db.execute(
      sql`alter table audit_log drop constraint azure_claim_fixture_failure`,
    );
  }
  const [stored] = await fixture.db
    .select()
    .from(schema.emails)
    .where(eq(schema.emails.id, email.id));
  expect(stored?.sentAt).toBeNull();
});
it("restoration fences invalid date, old backlog, campaign and unowned From; exact boundary passes", () => {
  const notBefore = "2026-10-29T12:00:00Z";
  const policy = parseSendingProviderPolicy(
    JSON.stringify({
      version: 1,
      allowedTeamIds: [team],
      defaults: { transactional: "disabled", campaign: "disabled" },
      teams: { [team]: { transactional: "azure_smtp", campaign: "disabled" } },
      restoration: { teams: { [team]: { notBefore, senders: ["system@example.invalid"] } } },
    }),
  );
  const input = {
    teamId: team,
    messageClass: "transactional" as const,
    fromAddress: "system@example.invalid",
    createdAt: new Date(notBefore),
    legacyProvider: "ses" as const,
    availableProviders: new Set(["azure_smtp", "ses"]),
  };
  expect(resolveSendingProvider(policy, input).kind).toBe("selected");
  for (const patch of [
    { createdAt: new Date("invalid") },
    { createdAt: new Date("2026-10-29T11:59:59.999Z") },
    { messageClass: "campaign" as const },
    { fromAddress: "other@example.invalid" },
    { teamId: other },
  ])
    expect(resolveSendingProvider(policy, { ...input, ...patch }).kind).toBe("held");
});
