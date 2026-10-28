import { randomUUID } from "node:crypto";
import { type Db, schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import { reviewCampaignConsent, submitCampaignConsent } from "../src/campaign-consent.js";

export function verifiedDns(name: string) {
  return {
    dkimSelector: "test",
    mailFromSubdomain: "send",
    dmarcPolicy: "none" as const,
    dmarcCheckedAt: new Date(),
    dnsRecords: [
      {
        group: "verification",
        name: `test._domainkey.${name}`,
        type: "TXT",
        status: "found" as const,
      },
      { group: "sending", name: `send.${name}`, type: "TXT", status: "found" as const },
      { group: "sending", name: `send.${name}`, type: "MX", status: "found" as const },
      { group: "dmarc", name: `_dmarc.${name}`, type: "TXT", status: "found" as const },
    ],
  };
}

export async function independentOperator(db: Db) {
  const id = randomUUID();
  await db.insert(schema.user).values({
    id,
    name: "Synthetic independent operator",
    email: `${id}@operator.example.test`,
    emailVerified: true,
  });
  return id;
}

export async function approveCampaignFixture(
  db: Db,
  teamId: string,
  actorId: string,
  name: string,
) {
  const operatorId = await independentOperator(db);
  await db.update(schema.domains).set(verifiedDns(name)).where(eq(schema.domains.teamId, teamId));
  await db
    .update(schema.teams)
    .set({ sendReviewClearedAt: new Date() })
    .where(eq(schema.teams.id, teamId));
  const dossier = await submitCampaignConsent(db, {
    teamId,
    actorId,
    evidence: {
      listReference: "synthetic-first-party-list",
      source: "Direct first-party signup on our public website",
      method: "Explicit unchecked opt-in checkbox",
      formUrl: "https://example.test/signup",
      permissionText: "I agree to receive Example product news.",
      permissionScope: "Monthly Example product news only",
      samples: [
        { reference: "record-***42", registeredAt: "2026-01-01T12:00:00.000Z", ipAvailable: false },
      ],
    },
  });
  await reviewCampaignConsent(db, {
    teamId,
    dossierId: dossier.id,
    operatorId,
    decision: "approved",
    reason: "Synthetic independent review of explicit opt-in evidence",
  });
}
