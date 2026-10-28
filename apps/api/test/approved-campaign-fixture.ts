import { randomUUID } from "node:crypto";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { eq } from "drizzle-orm";
import {
  reviewCampaignConsent,
  submitCampaignConsent,
} from "../../../packages/core/src/campaign-consent.js";

/** Persisted successful DNS verification, never a mocked admission verdict. */
export function campaignDns(name: string) {
  const now = new Date();
  return {
    dkimSelector: "fixture",
    mailFromSubdomain: "send",
    dmarcPolicy: "none" as const,
    dmarcCheckedAt: now,
    lastCheckedAt: now,
    dnsRecords: [
      {
        group: "verification",
        type: "TXT",
        name: `fixture._domainkey.${name}`,
        value: "v=DKIM1; p=synthetic",
        status: "found",
      },
      {
        group: "sending",
        type: "TXT",
        name: `send.${name}`,
        value: "v=spf1 include:amazonses.com ~all",
        status: "found",
      },
      {
        group: "sending",
        type: "MX",
        name: `send.${name}`,
        value: "10 feedback-smtp.us-east-1.amazonses.com",
        status: "found",
      },
      {
        group: "dmarc",
        type: "TXT",
        name: `_dmarc.${name}`,
        value: "v=DMARC1; p=none",
        status: "found",
      },
    ] as schema.DomainDnsRecord[],
  };
}

/** Opt in only the named suite principal; unrelated teams remain unapproved. */
export async function approveCampaignFixture(db: Db, teamId: string, importDomain?: string) {
  const ownerId = randomUUID();
  const operatorId = randomUUID();
  await db.insert(schema.user).values([
    { id: ownerId, name: "Synthetic list owner", email: `${ownerId}@example.test` },
    {
      id: operatorId,
      name: "Synthetic independent operator",
      role: "admin",
      email: `${operatorId}@example.test`,
    },
  ]);
  await db.insert(schema.teamMembers).values({ teamId, userId: ownerId, role: "owner" });
  const dossier = await submitCampaignConsent(db, {
    teamId,
    actorId: ownerId,
    evidence: {
      listReference: "synthetic-api-opt-in-list",
      source: "First party public registration form",
      method: "Explicit unchecked opt-in checkbox",
      formUrl: "https://example.test/signup",
      permissionText: "I agree to receive Example product messages.",
      permissionScope: "Example product updates and announcements",
      samples: [
        {
          reference: "masked-registration-42",
          registeredAt: "2026-01-01T12:00:00.000Z",
          ipAvailable: false,
        },
      ],
    },
  });
  await reviewCampaignConsent(db, {
    teamId,
    dossierId: dossier.id,
    operatorId,
    decision: "approved",
    reason: "Independent operator verified synthetic first-party opt-in evidence",
  });
  await db
    .update(schema.teams)
    .set({ sendReviewClearedAt: new Date() })
    .where(eq(schema.teams.id, teamId));
  if (importDomain)
    await db.insert(schema.domains).values({
      teamId,
      name: importDomain,
      region: "us-east-1",
      status: "verified",
      verifiedAt: new Date(),
      ...campaignDns(importDomain),
    });
}
