import { randomUUID } from "node:crypto";
import { reviewCampaignConsent, submitCampaignConsent } from "@millionsend/core";
import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, eq } from "drizzle-orm";

/** Persist the evidence a legitimate, independently reviewed sender now needs. */
export async function reviewedSender(db: Db, teamId: string, name: string, now = new Date()) {
  await db
    .update(schema.teams)
    .set({
      createdAt: new Date(now.getTime() - 40 * 86_400_000),
      sendReviewClearedAt: now,
      dailySendCeiling: 10_000,
    })
    .where(eq(schema.teams.id, teamId));
  await db
    .update(schema.domains)
    .set({
      dkimSelector: "test",
      mailFromSubdomain: "send",
      dmarcPolicy: "none",
      lastCheckedAt: now,
      dmarcCheckedAt: now,
      dnsRecords: [
        { group: "verification", name: `test._domainkey.${name}`, type: "TXT", status: "found" },
        { group: "sending", name: `send.${name}`, type: "TXT", status: "found" },
        { group: "sending", name: `send.${name}`, type: "MX", status: "found" },
        { group: "dmarc", name: `_dmarc.${name}`, type: "TXT", status: "found" },
      ],
    })
    .where(and(eq(schema.domains.teamId, teamId), eq(schema.domains.name, name)));
  const dossier = await submitCampaignConsent(db, {
    teamId,
    actorId: `owner-${randomUUID()}`,
    evidence: {
      listReference: "synthetic-first-party-list",
      source: "First party public registration form",
      method: "Explicit unchecked consent checkbox",
      formUrl: "https://example.test/signup",
      permissionText: "I agree to receive Example product updates.",
      permissionScope: "Example product announcements and offers",
      samples: [
        { reference: "record-***42", registeredAt: "2026-01-01T12:00:00.000Z", ipAvailable: false },
      ],
    },
  });
  await reviewCampaignConsent(db, {
    teamId,
    dossierId: dossier.id,
    operatorId: `operator-${randomUUID()}`,
    decision: "approved",
    reason: "Synthetic first party opt-in evidence independently reviewed",
  });
}

/** Real provider-confirmed messages and distinct outcomes, never counter-only reputation.
 * Replaces only this helper's synthetic snapshot when a test models recovery. */
export async function rollingHistory(
  db: Db,
  teamId: string,
  counts: { sent: number; hardBounced?: number; complained?: number },
  now = new Date(),
) {
  const subject = "Synthetic rolling reputation snapshot";
  await db
    .delete(schema.emails)
    .where(and(eq(schema.emails.teamId, teamId), eq(schema.emails.subject, subject)));
  const at = new Date(now.getTime() - 60_000);
  const rows = await db
    .insert(schema.emails)
    .values(
      Array.from({ length: counts.sent }, () => ({
        teamId,
        from: "sender@example.test",
        to: ["recipient@example.test"],
        subject,
        createdAt: at,
        sentAt: at,
        sesMessageId: `synthetic-${randomUUID()}`,
        latestStatus: "sent" as const,
      })),
    )
    .returning({ id: schema.emails.id });
  const events = rows.flatMap((row, i) => [
    ...(i < (counts.hardBounced ?? 0)
      ? [
          {
            emailId: row.id,
            type: "bounced" as const,
            bounceType: "Permanent" as const,
            occurredAt: at,
            createdAt: at,
            snsMessageId: randomUUID(),
            data: {},
          },
        ]
      : []),
    ...(i < (counts.complained ?? 0)
      ? [
          {
            emailId: row.id,
            type: "complained" as const,
            occurredAt: at,
            createdAt: at,
            snsMessageId: randomUUID(),
            data: {},
          },
        ]
      : []),
  ]);
  if (events.length) await db.insert(schema.emailEvents).values(events);
}
