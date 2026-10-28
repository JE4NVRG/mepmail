import type { Db } from "@millionsend/db";
import { schema } from "@millionsend/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { parseSingleSender } from "./sender-address.js";

const reference = z
  .string()
  .trim()
  .min(3)
  .max(160)
  .refine(
    (s) => !s.includes("@") && !z.ipv4().safeParse(s).success && !z.ipv6().safeParse(s).success,
    "Use a masked record reference, not an email or complete IP address",
  );
export const campaignConsentEvidenceSchema = z
  .object({
    listReference: reference,
    source: z.string().trim().min(15).max(500),
    method: z.string().trim().min(10).max(300),
    formUrl: z
      .url()
      .max(500)
      .refine((s) => {
        const u = new URL(s);
        return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash;
      }, "Use a public HTTPS form URL without tokens or query parameters"),
    permissionText: z.string().trim().min(20).max(1000),
    permissionScope: z.string().trim().min(15).max(500),
    samples: z
      .array(
        z
          .object({
            reference,
            registeredAt: z.iso
              .datetime()
              .refine((s) => Date.parse(s) <= Date.now(), "Registration cannot be in the future"),
            ipAvailable: z.boolean(),
            ipReference: reference.optional(),
          })
          .strict()
          .refine(
            (s) => !s.ipAvailable || Boolean(s.ipReference),
            "Reference the retained IP evidence when it exists; do not upload the IP",
          ),
      )
      .min(1)
      .max(5),
  })
  .strict();

export type CampaignMessage = {
  broadcastId?: string | null | undefined;
  topicId?: string | null | undefined;
  to?: readonly string[] | undefined;
  cc?: readonly string[] | undefined;
  bcc?: readonly string[] | undefined;
  subject?: string | undefined;
  html?: string | null | undefined;
  text?: string | null | undefined;
  headers?: Record<string, string> | null | undefined;
};
/** Never trust a caller's marketing=false / transactional declaration. A
 * broadcast is always a campaign. Ordinary one-recipient password resets
 * without campaign signals remain transactional and use the existing quota,
 * signup-risk, domain and content gates. Classification is defense-in-depth,
 * not a substitute for content screening. */
export function campaignMessage(input: CampaignMessage): boolean {
  if (input.broadcastId || input.topicId) return true;
  if ((input.to?.length ?? 0) + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0) > 1) return true;
  if (Object.keys(input.headers ?? {}).some((h) => /^(list-unsubscribe|list-id)$/i.test(h)))
    return true;
  return /\b(newsletter|unsubscribe|descadastre|cancelar inscri[çc][aã]o|promo[çc][aã]o|oferta exclusiva|black friday|special offer|course spotlight|limited seats)\b/i.test(
    `${input.subject ?? ""} ${input.html ?? ""} ${input.text ?? ""}`,
  );
}

export async function latestCampaignConsent(db: Db, teamId: string) {
  const d = schema.campaignConsentDossiers;
  const [row] = await db
    .select()
    .from(d)
    .where(eq(d.teamId, teamId))
    .orderBy(desc(d.submittedAt), desc(d.id))
    .limit(1);
  return row ?? null;
}

export async function submitCampaignConsent(
  db: Db,
  input: { teamId: string; actorId: string; evidence: unknown },
) {
  const evidence = campaignConsentEvidenceSchema.parse(input.evidence);
  return db.transaction(async (tx) => {
    // Team row serializes concurrent submissions/review, keeping the latest
    // dossier authoritative. Submitting new evidence never inherits approval.
    await tx
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(eq(schema.teams.id, input.teamId))
      .for("update");
    const [row] = await tx
      .insert(schema.campaignConsentDossiers)
      .values({
        teamId: input.teamId,
        evidence,
        submittedBy: input.actorId,
        // now() is transaction-start time, not lock-acquisition order. Keep
        // this marker strictly increasing under the team's existing row lock,
        // including equal timestamps and an older transaction acquiring last.
        submittedAt: sql`greatest(clock_timestamp(), coalesce((
          select max(submitted_at) + interval '1 microsecond'
          from ${schema.campaignConsentDossiers}
          where team_id = ${input.teamId}
        ), clock_timestamp()))`,
      })
      .returning();
    if (!row) throw new Error("consent_submission_failed");
    await tx.insert(schema.auditLog).values({
      teamId: input.teamId,
      actorId: `user:${input.actorId}`,
      action: "campaign.consent_submitted",
      target: `consent:${row.id}`,
      data: {
        listReference: evidence.listReference,
        sampleCount: evidence.samples.length,
        noQueueAction: true,
      },
    });
    return row;
  });
}

/** Caller must use the existing operatorProcedure; a team owner is not an
 * operator. Review never clears a hold, suspension or drains parked mail. */
export async function reviewCampaignConsent(
  db: Db,
  input: {
    teamId: string;
    dossierId: string;
    operatorId: string;
    decision: "approved" | "rejected" | "revoked";
    reason: string;
  },
) {
  const reason = z.string().trim().min(15).max(500).parse(input.reason);
  return db.transaction(async (tx) => {
    await tx
      .select({ id: schema.teams.id })
      .from(schema.teams)
      .where(eq(schema.teams.id, input.teamId))
      .for("update");
    const row = await latestCampaignConsent(tx as unknown as Db, input.teamId);
    if (!row || row.id !== input.dossierId) throw new Error("consent_not_current");
    if (row.submittedBy === input.operatorId)
      throw new Error("consent_independent_operator_required");
    if (
      (input.decision === "revoked" && row.status !== "approved") ||
      (input.decision !== "revoked" && row.status !== "pending")
    )
      throw new Error("consent_invalid_transition");
    campaignConsentEvidenceSchema.parse(row.evidence);
    const [updated] = await tx
      .update(schema.campaignConsentDossiers)
      .set({ status: input.decision, reviewedBy: input.operatorId, reviewedAt: new Date(), reason })
      .where(
        and(
          eq(schema.campaignConsentDossiers.id, row.id),
          eq(schema.campaignConsentDossiers.teamId, input.teamId),
          eq(schema.campaignConsentDossiers.status, row.status),
        ),
      )
      .returning();
    if (!updated) throw new Error("consent_review_conflict");
    await tx.insert(schema.auditLog).values({
      teamId: input.teamId,
      actorId: `user:${input.operatorId}`,
      action: `campaign.consent_${input.decision}`,
      target: `consent:${row.id}`,
      data: { reason, noQueueAction: true },
    });
    return updated;
  });
}

export function campaignDomainDnsReady(
  domain: Pick<
    typeof schema.domains.$inferSelect,
    | "name"
    | "status"
    | "dkimSelector"
    | "mailFromSubdomain"
    | "dnsRecords"
    | "dmarcPolicy"
    | "dmarcCheckedAt"
  >,
): boolean {
  if (
    domain.status !== "verified" ||
    !domain.dkimSelector ||
    !domain.dmarcCheckedAt ||
    !domain.dmarcPolicy
  )
    return false;
  const records = domain.dnsRecords ?? [];
  const normalize = (name: string) => name.toLowerCase().replace(/\.$/, "");
  const found = (group: string, type: string, name: string) =>
    records.some(
      (r) =>
        r.group === group &&
        r.type.toUpperCase() === type &&
        normalize(r.name) === normalize(name) &&
        r.status === "found",
    );
  const mailFrom = `${domain.mailFromSubdomain}.${domain.name}`;
  return (
    found("verification", "TXT", `${domain.dkimSelector}._domainkey.${domain.name}`) &&
    found("sending", "TXT", mailFrom) &&
    found("sending", "MX", mailFrom) &&
    // DMARC may legitimately be inherited from the organizational domain.
    // p=none is a valid policy; checkedAt records an actual verification pass.
    records.some(
      (r) =>
        r.group === "dmarc" &&
        r.type.toUpperCase() === "TXT" &&
        normalize(r.name).startsWith("_dmarc.") &&
        r.status === "found",
    ) &&
    records
      .filter((r) => ["verification", "sending", "dmarc"].includes(r.group))
      .every((r) => r.status === "found")
  );
}

export type CampaignConsentVerdict =
  | { allowed: true; dossierId?: string }
  | {
      allowed: false;
      reason:
        | "campaign_consent_required"
        | "campaign_manual_review_required"
        | "campaign_domain_required"
        | "team_restricted";
    };
export const CAMPAIGN_CONSENT_MESSAGE =
  "Campaigns and contact imports require approved opt-in evidence, a verified sending domain and an independent operator review. Submit your evidence in Audience → Consent review. / Campanhas e importações exigem prova de opt-in aprovada, domínio verificado e revisão operacional independente. Envie em Público → Revisão de consentimento.";

/** Provider-independent. Call at API admission, fan-out (each page) AND
 * immediately before every provider delivery, including restored/parked rows.
 * Absence, pending, rejected and revoked fail closed. No automatic legacy pass. */
export async function checkCampaignConsent(
  db: Db,
  input: {
    teamId: string;
    from?: string | undefined;
    operation: "import" | "campaign";
    isCloud?: boolean | undefined;
  },
): Promise<CampaignConsentVerdict> {
  // Deployment configuration only, never a field accepted from an API caller.
  // A self-hosted operator owns their provider and does not join our shared pool.
  if (input.isCloud === false) return { allowed: true };
  const row = await latestCampaignConsent(db, input.teamId);
  if (
    row?.status !== "approved" ||
    !row.reviewedAt ||
    !row.reviewedBy ||
    row.reviewedBy === row.submittedBy ||
    !campaignConsentEvidenceSchema.safeParse(row.evidence).success
  )
    return { allowed: false, reason: "campaign_consent_required" };
  const [team] = await db
    .select({
      suspendedAt: schema.teams.suspendedAt,
      heldAt: schema.teams.sendReviewAt,
      clearedAt: schema.teams.sendReviewClearedAt,
      pausedAt: schema.teams.broadcastsPausedByOperatorAt,
    })
    .from(schema.teams)
    .where(eq(schema.teams.id, input.teamId));
  if (
    !team ||
    team.suspendedAt ||
    team.pausedAt ||
    (team.heldAt && (!team.clearedAt || team.heldAt > team.clearedAt))
  )
    return { allowed: false, reason: "team_restricted" };
  if (!team.clearedAt) return { allowed: false, reason: "campaign_manual_review_required" };
  const sender = input.from ? parseSingleSender(input.from) : null;
  if (input.from && !sender) return { allowed: false, reason: "campaign_domain_required" };
  const domains = await db
    .select()
    .from(schema.domains)
    .where(
      and(
        eq(schema.domains.teamId, input.teamId),
        ...(sender ? [eq(schema.domains.name, sender.domain)] : []),
      ),
    );
  const verified = domains.some(campaignDomainDnsReady);
  return verified
    ? { allowed: true, dossierId: row.id }
    : { allowed: false, reason: "campaign_domain_required" };
}

/** Worker contract: absence of campaign signals leaves legitimate operational
 * messages to existing gates. The stored broadcastId always wins over a false
 * client declaration. Recheck decrypted body/headers before any provider call. */
export async function checkCampaignMessage(
  db: Db,
  input: CampaignMessage & { teamId: string; from: string; isCloud?: boolean | undefined },
) {
  return campaignMessage(input)
    ? checkCampaignConsent(db, {
        teamId: input.teamId,
        from: input.from,
        operation: "campaign",
        isCloud: input.isCloud,
      })
    : { allowed: true as const };
}
