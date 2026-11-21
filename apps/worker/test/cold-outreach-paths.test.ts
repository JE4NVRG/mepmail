import { randomBytes } from "node:crypto";
import { deriveUnsubscribeKey, EnvKeyring, findDisguise } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { createTeam, createTestDb } from "@millionsend/test-utils";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { screenPreSendContent } from "../../../packages/core/src/pre-send-content-policy.js";
import { type BroadcastDeps, sendBroadcast } from "../src/handlers/send-broadcast.js";

/**
 * The cold-outreach gate on the two fan-out surfaces, with real rows rather than
 * mocks: a real team, a verified domain, real contacts, a real broadcast row.
 *
 * What it pins today:
 *  - the policy itself holds prospecting copy (`cold_outreach`) before any send;
 *  - the broadcast path never consults that policy, so the same copy reaches the
 *    fan-out. That is the gap A148 names: the gate is wired for mailbox and
 *    transactional sends, not for campaigns.
 */
let db: Db;
let close: () => Promise<void>;
const keyring = EnvKeyring.fromBase64(randomBytes(32).toString("base64"));
const secretKey = deriveUnsubscribeKey(randomBytes(32));

const PROSPECT_FROM = "Parcerias <parcerias@sender.dev>";
const PROSPECT_SUBJECT = "Sponsorship opportunity for your blog";
const PROSPECT_TEXT =
  "Hi, we would love a paid placement on your site. Unsubscribe: {{{UNSUBSCRIBE_URL}}}";

async function seedTeam(label: string): Promise<string> {
  const teamId = await createTeam(db, label);
  // Past the new-sender screen, so what this file observes is the content gate
  // and nothing else: the operator already cleared a review for this team.
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
  });
  await db.insert(schema.contacts).values([
    { teamId, email: `a@${label}.example.com` },
    { teamId, email: `b@${label}.example.com` },
  ]);
  return teamId;
}

async function insertBroadcast(teamId: string): Promise<string> {
  const [row] = await db
    .insert(schema.broadcasts)
    .values({
      teamId,
      from: PROSPECT_FROM,
      subject: PROSPECT_SUBJECT,
      html: `<p>Hi</p><a href="{{{UNSUBSCRIBE_URL}}}">bye</a>`,
      text: PROSPECT_TEXT,
      status: "scheduled",
      scheduledAt: new Date(Date.now() - 1000),
    })
    .returning({ id: schema.broadcasts.id });
  if (!row) throw new Error("broadcast insert failed");
  return row.id;
}

function makeDeps(): { deps: BroadcastDeps; enqueued: string[] } {
  const enqueued: string[] = [];
  const deps: BroadcastDeps = {
    keyring,
    unsubscribeSecretKey: secretKey,
    unsubscribeBaseUrl: "https://app.example.com",
    isCloud: true,
    enqueueEmailSends: async (batch) => {
      for (const job of batch) enqueued.push(job.emailId);
    },
    reschedule: async () => undefined,
  };
  return { deps, enqueued };
}

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

it("a politica segura a copy de prospeccao fria antes de qualquer envio", async () => {
  const teamId = await seedTeam("gate-policy");
  const verdict = await screenPreSendContent(db, {
    teamId,
    from: PROSPECT_FROM,
    subject: PROSPECT_SUBJECT,
    html: `<p>Hi</p>`,
    text: PROSPECT_TEXT,
  });
  expect(verdict).toMatchObject({ action: "hold", code: "cold_outreach" });
  // The hold parks the team, which is the documented way back to it.
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  expect(team?.sendReviewAt).not.toBeNull();
});

it("o caminho de broadcast nao consulta o gate de prospeccao fria", async () => {
  const teamId = await seedTeam("gate-broadcast");
  const broadcastId = await insertBroadcast(teamId);
  const { deps } = makeDeps();

  // O handler roda de verdade sobre a linha real do broadcast...
  const outcome = await sendBroadcast(db, deps, { broadcastId });
  expect(["sent", "deferred"]).toContain(outcome);

  // ...e nada nele vem da politica de conteudo: nenhum hold com motivo de
  // conteudo, nenhuma flag dessa politica. O que o broadcast consulta hoje e
  // disfarce, imitacao de marca e remetente novo, e a copy de prospeccao passa
  // por todos os tres.
  const [team] = await db.select().from(schema.teams).where(eq(schema.teams.id, teamId));
  expect(team?.sendReviewReason ?? null).not.toBe("content");
  expect(findDisguise({ from: PROSPECT_FROM, subject: PROSPECT_SUBJECT })).toBeNull();

  // A mesma copy no gate que o correio e o transacional usam: hold.
  expect(
    await screenPreSendContent(db, {
      teamId,
      from: PROSPECT_FROM,
      subject: PROSPECT_SUBJECT,
      html: "<p>Hi</p>",
      text: PROSPECT_TEXT,
    }),
  ).toMatchObject({ action: "hold", code: "cold_outreach" });
});
