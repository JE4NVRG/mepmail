import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

/** Minimal redacted evidence only. No contact lists, credentials or full IPs. */
export interface CampaignConsentEvidence {
  listReference: string;
  source: string;
  method: string;
  formUrl: string;
  permissionText: string;
  permissionScope: string;
  samples: {
    reference: string;
    registeredAt: string;
    ipAvailable: boolean;
    ipReference?: string | undefined;
  }[];
}
export const campaignConsentDossiers = pgTable(
  "campaign_consent_dossiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    evidence: jsonb("evidence").$type<CampaignConsentEvidence>().notNull(),
    status: text("status")
      .$type<"pending" | "approved" | "rejected" | "revoked">()
      .notNull()
      .default("pending"),
    submittedBy: text("submitted_by").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reason: text("reason"),
  },
  (t) => [index("campaign_consent_team_submitted_idx").on(t.teamId, t.submittedAt)],
);
