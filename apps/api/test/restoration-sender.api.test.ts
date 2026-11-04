import { randomBytes } from "node:crypto";
import { EnvKeyring, generateApiKey, parseSendingProviderPolicy } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/app.js";
import { approveCampaignFixture, campaignDns } from "./approved-campaign-fixture.js";

// While a team's restoration cohort is active, the send lane only ever sends
// its listed senders; accept refuses any other From up front (403
// sender_not_allowed) instead of queueing mail that can only park.
let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApi>;
let cohortTeam: string;
let otherTeam: string;
const tokens: Record<string, string> = {};
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const enqueued: string[] = [];

async function seedTeam(name: string, domain: string): Promise<string> {
  const teamId = await createTeam(db, name);
  await approveCampaignFixture(db, teamId);
  await db.insert(schema.domains).values({
    teamId,
    name: domain,
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
    ...campaignDns(domain),
  });
  const key = generateApiKey();
  tokens[teamId] = key.token;
  await db.insert(schema.apiKeys).values({
    teamId,
    name: "t",
    tokenPrefix: key.tokenPrefix,
    keyHash: key.keyHash,
    last4: key.last4,
  });
  return teamId;
}

function send(teamId: string, path: "/emails" | "/emails/batch", body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens[teamId]}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const mail = (from: string, to = "r@example.com") => ({ from, to: [to], subject: "s", text: "t" });

async function rowsFor(teamId: string) {
  return db
    .select({ id: schema.emails.id })
    .from(schema.emails)
    .where(eq(schema.emails.teamId, teamId));
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  cohortTeam = await seedTeam("restoration-team", "acme.dev");
  otherTeam = await seedTeam("other-team", "other.dev");
  const policy = parseSendingProviderPolicy(
    JSON.stringify({
      version: 1,
      allowedTeamIds: [cohortTeam, otherTeam],
      defaults: { transactional: "disabled", campaign: "disabled" },
      teams: { [cohortTeam]: { transactional: "azure_smtp", campaign: "disabled" } },
      restoration: {
        teams: {
          [cohortTeam]: { notBefore: "2026-01-01T00:00:00Z", senders: ["donotreply@acme.dev"] },
        },
      },
    }),
  );
  app = createApi({
    db,
    keyring,
    isCloud: true,
    sendingProviderPolicy: policy,
    enqueueEmailSend: async (emailId) => {
      enqueued.push(emailId);
    },
  });
});
afterAll(() => close());

describe("restoration sender fence at accept", () => {
  it("403s POST /emails from a sender outside the cohort, storing nothing", async () => {
    const res = await send(cohortTeam, "/emails", mail("Elozi <hello@acme.dev>"));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { name: string; message: string };
    expect(body.name).toBe("sender_not_allowed");
    expect(body.message).toMatch(/sender address is not enabled/);
    expect(await rowsFor(cohortTeam)).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  it("accepts a listed sender, display name and case notwithstanding", async () => {
    const res = await send(cohortTeam, "/emails", mail("Elozi <DoNotReply@Acme.dev>"));
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(enqueued).toContain(id);
  });

  it("refuses a batch carrying an unlisted sender, accepting nothing", async () => {
    const before = (await rowsFor(cohortTeam)).length;
    const res = await send(cohortTeam, "/emails/batch", [
      mail("donotreply@acme.dev", "b1@example.com"),
      mail("billing@acme.dev", "b2@example.com"),
    ]);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { name: string }).name).toBe("sender_not_allowed");
    expect(await rowsFor(cohortTeam)).toHaveLength(before);
  });

  it("leaves a team without a restoration cohort unchanged", async () => {
    const res = await send(otherTeam, "/emails", mail("Anyone <anyone@other.dev>"));
    expect(res.status).toBe(200);
    const batch = await send(otherTeam, "/emails/batch", [mail("x@other.dev", "o@example.com")]);
    expect(batch.status).toBe(200);
  });
});
