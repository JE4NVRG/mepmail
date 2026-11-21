import { randomBytes, randomUUID } from "node:crypto";
import { deriveUnsubscribeKey, EnvKeyring } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  reviewCampaignConsent,
  submitCampaignConsent,
} from "../../../packages/core/src/campaign-consent.js";
import { screenPreSendContent } from "../../../packages/core/src/pre-send-content-policy.js";
import { type BroadcastDeps, sendBroadcast } from "../src/handlers/send-broadcast.js";

/**
 * The cold-outreach gate on the campaign surface, with real rows: a real team,
 * a verified domain with DNS proof, real contacts, a real consent dossier and a
 * real broadcast row. No mocks, no send.
 *
 * What it pins: a campaign whose copy is prospecting is refused before a single
 * row fans out, and the team lands in the review queue. Before A148 the campaign
 * path ran only disguise, brand and new-sender screens, so the same copy went
 * straight to the fan-out.
 */
let db: Db;
let close: () => Promise<void>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const secretKey = deriveUnsubscribeKey(randomBytes(32));
const OPERATOR_ID = "operator-fixture";

const PROSPECT_SUBJECT = "Sponsorship opportunity for your blog";
const PROSPECT_TEXT =
  "Hi, we would love a paid placement on your site. Unsubscribe: {{{UNSUBSCRIBE_URL}}}";

function campaignDns(name: string) {
  const now = new Date();
  return {
    dkimSelector: "fixture",
    mailFromSubdomain: "send",
    dmarcPolicy: "none" as const,
    dmarcCheckedAt: now,
    lastCheckedAt: now,
    dnsRecords: [
      { group: "verification", type: "TXT", name: `fixture._domainkey.${name}`, status: "found" },
      { group: "sending", type: "TXT", name: `send.${name}`, status: "found" },
      { group: "sending", type: "MX", name: `send.${name}`, status: "found" },
      { group: "dmarc", type: "TXT", name: `_dmarc.${name}`, status: "found" },
    ],
  };
}

async function seedTeam(label: string): Promise<{ teamId: string; from: string }> {
  const teamId = await createTeam(db, label);
  const ownerId = randomUUID();
  await db.insert(schema.user).values({
    id: ownerId,
    name: "Owner",
    email: `${ownerId}@example.test`,
    emailVerified: true,
  });
  await db.insert(schema.teamMembers).values({ teamId, userId: ownerId, role: "owner" });
  await db
    .update(schema.teams)
    .set({ sendReviewClearedAt: new Date(Date.now() - 60_000) })
    .where(eq(schema.teams.id, teamId));
  await db.insert(schema.domains).values({
    teamId,
    name: `${label}.dev`,
    region: "us-east-1",
    status: "verified",
    verifiedAt: new Date(),
    sesConfigurationSet: "ms-set",
    ...campaignDns(`${label}.dev`),
  });
  await db.insert(schema.contacts).values([
    { teamId, email: `a@${label}.example.com` },
    { teamId, email: `b@${label}.example.com` },
  ]);
  // A campaign only reaches the fan-out with approved consent; without it the
  // handler parks earlier and the content gate would never be exercised.
  const dossier = await submitCampaignConsent(db, {
    teamId,
    actorId: ownerId,
    evidence: {
      listReference: "synthetic-opt-in-list",
      source: "First party public registration form",
      method: "Explicit unchecked opt-in checkbox",
      formUrl: "https://example.test/signup",
      permissionText: "I agree to receive Example product messages.",
      permissionScope: "Example product updates",
      samples: [
        {
          reference: "masked-registration-1",
          registeredAt: "2026-01-01T12:00:00.000Z",
          ipAvailable: false,
        },
      ],
    },
  });
  await reviewCampaignConsent(db, {
    teamId,
    dossierId: dossier.id,
    operatorId: OPERATOR_ID,
    decision: "approved",
    reason: "Independent operator verified synthetic first-party opt-in evidence",
  });
  return { teamId, from: `parcerias@${label}.dev` };
}

async function insertBroadcast(teamId: string, from: string): Promise<string> {
  const [row] = await db
    .insert(schema.broadcasts)
    .values({
      teamId,
      from,
      subject: PROSPECT_SUBJECT,
      html: '<p>Hi</p><a href="{{{UNSUBSCRIBE_URL}}}">bye</a>',
      text: PROSPECT_TEXT,
      status: "scheduled",
      scheduledAt: new Date(Date.now() - 1000),
    })
    .returning({ id: schema.broadcasts.id });
  if (!row) throw new Error("broadcast insert failed");
  return row.id;
}

function makeDeps(): BroadcastDeps {
  return {
    keyring,
    unsubscribeSecretKey: secretKey,
    unsubscribeBaseUrl: "https://app.example.com",
    isCloud: true,
    enqueueEmailSends: async () => undefined,
    reschedule: async () => undefined,
  };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(schema.user).values({
    id: OPERATOR_ID,
    name: "Operator",
    email: "op@example.test",
    emailVerified: true,
  });
});
afterAll(() => close());

it("a politica segura a copy de prospeccao fria antes de qualquer envio", async () => {
  const { teamId, from } = await seedTeam("gate-policy");
  const verdict = await screenPreSendContent(db, {
    teamId,
    from,
    subject: PROSPECT_SUBJECT,
    html: "<p>Hi</p>",
    text: PROSPECT_TEXT,
  });
  expect(verdict).toMatchObject({ action: "hold", code: "cold_outreach" });
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  expect(team?.sendReviewAt).not.toBeNull();
});

it("o caminho de broadcast segura a copy de prospeccao fria antes do fan-out", async () => {
  const { teamId, from } = await seedTeam("gate-broadcast");
  const broadcastId = await insertBroadcast(teamId, from);

  expect(await sendBroadcast(db, makeDeps(), { broadcastId })).toBe("deferred");

  // Nada fanou: nenhuma linha de e-mail nasceu para este broadcast.
  const rows = await db
    .select({ id: schema.emails.id })
    .from(schema.emails)
    .where(eq(schema.emails.broadcastId, broadcastId));
  expect(rows).toHaveLength(0);

  // E o time fica retido com o motivo do conteudo, que e a fila de revisao.
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  expect(team?.sendReviewAt).not.toBeNull();
  expect(team?.sendReviewReason).toBe("content");
});
