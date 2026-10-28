import { randomUUID } from "node:crypto";
import { reviewCampaignConsent, submitCampaignConsent } from "@millionsend/core";
import { type Db, schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";

/** Synthetic operator-reviewed account, not an import guard override. */
export async function approveImportFixture(db: Db, teamId: string, domainId?: string) {
  const name = "cli-consent.example.test";
  if (!domainId) {
    const [domain] = await db
      .insert(schema.domains)
      .values({
        teamId,
        name,
        region: "us-east-1",
        dkimSelector: "cli",
      })
      .returning();
    if (!domain) throw new Error("Synthetic consent domain insert failed");
    domainId = domain.id;
  }
  const [domain] = await db
    .select()
    .from(schema.domains)
    .where(and(eq(schema.domains.teamId, teamId), eq(schema.domains.id, domainId)));
  if (!domain) throw new Error("Consent fixture cannot modify another tenant domain");
  const selector = domain.dkimSelector ?? "cli";
  const mailFrom = `${domain.mailFromSubdomain}.${domain.name}`;
  const required = [
    { group: "verification", type: "TXT", name: `${selector}._domainkey.${domain.name}` },
    { group: "sending", type: "TXT", name: mailFrom },
    { group: "sending", type: "MX", name: mailFrom },
    { group: "dmarc", type: "TXT", name: `_dmarc.${domain.name}` },
  ];
  await db
    .update(schema.domains)
    .set({
      status: "verified",
      dkimSelector: selector,
      dmarcPolicy: "none",
      dmarcCheckedAt: new Date(),
      dnsRecords: [...(domain.dnsRecords ?? []), ...required].map((r) => ({
        ...r,
        status: "found" as const,
      })),
    })
    .where(and(eq(schema.domains.teamId, teamId), eq(schema.domains.id, domain.id)));
  const actorId = `fixture-owner-${randomUUID()}`;
  const operatorId = `fixture-operator-${randomUUID()}`;
  const dossier = await submitCampaignConsent(db, {
    teamId,
    actorId,
    evidence: {
      listReference: "cli-synthetic-opt-in-list",
      source: "First-party synthetic customer signup records",
      method: "Explicit unchecked newsletter opt-in checkbox",
      formUrl: "https://example.test/signup",
      permissionText: "I agree to receive the Example product newsletter.",
      permissionScope: "Monthly Example product newsletter only",
      samples: [
        {
          reference: "synthetic-record-42",
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
    reason: "Independent synthetic operator reviewed the first-party opt-in records",
  });
  await db
    .update(schema.teams)
    .set({ sendReviewClearedAt: new Date() })
    .where(eq(schema.teams.id, teamId));
  return domain.id;
}
