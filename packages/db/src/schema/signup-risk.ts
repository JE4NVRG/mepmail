import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { teams } from "./teams.js";

export type SignupRiskLevel = "good" | "sandbox" | "hold";
/** Private metadata only; never an address, raw IP, user agent or message. */
export interface SignupRiskSnapshot {
  domain: string;
  disposable: boolean;
  mx: "present" | "null" | "absent" | "unknown";
  domainAgeDays: number | null;
  catchAll: "unknown";
  randomLocal: boolean;
  ipKey: string | null;
  asn: number | null;
  signupsIp1h: number;
  signupsDomain24h: number;
  signupsAsn1h: number;
  rapidFullKey?: boolean;
  verificationSeconds?: number | null;
  genericTeamName?: boolean;
}

export const userSignupRisk = pgTable(
  "user_signup_risk",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    source: text("source").$type<"signup" | "team_fallback">().notNull().default("signup"),
    domain: text("domain").notNull(),
    ipKey: text("ip_key"),
    asn: bigint("asn", { mode: "number" }),
    level: text("level").$type<SignupRiskLevel>().notNull().default("sandbox"),
    policyVersion: integer("policy_version").notNull().default(2),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    signals: jsonb("signals").$type<SignupRiskSnapshot>().notNull(),
    // Set by a verification callback, or by a newly created verified social user.
    // A legacy fallback capture must not invent its historical verification time.
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (t) => [
    index("user_signup_risk_domain_time_idx").on(t.domain, t.capturedAt),
    index("user_signup_risk_ip_time_idx").on(t.ipKey, t.capturedAt),
    index("user_signup_risk_asn_time_idx").on(t.asn, t.capturedAt),
    check("user_signup_risk_source_check", sql`${t.source} in ('signup','team_fallback')`),
    check("user_signup_risk_level_check", sql`${t.level} in ('good','sandbox','hold')`),
    check("user_signup_risk_version_check", sql`${t.policyVersion} in (1,2)`),
    check("user_signup_risk_ip_check", sql`${t.ipKey} is null or ${t.ipKey} ~ '^[a-f0-9]{64}$'`),
    check("user_signup_risk_asn_check", sql`${t.asn} is null or ${t.asn} between 1 and 4294967295`),
    check(
      "user_signup_risk_json_check",
      sql`jsonb_typeof(${t.reasons}) = 'array' and jsonb_typeof(${t.signals}) = 'object'`,
    ),
  ],
);

export const teamSignupRisk = pgTable(
  "team_signup_risk",
  {
    teamId: uuid("team_id")
      .primaryKey()
      .references(() => teams.id, { onDelete: "cascade" }),
    // Immutable original principal. Deletion sets NULL and remains unsafe.
    principalUserId: text("principal_user_id").references(() => user.id, { onDelete: "set null" }),
    level: text("level").$type<SignupRiskLevel>().notNull().default("sandbox"),
    policyVersion: integer("policy_version").notNull().default(2),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    signals: jsonb("signals").$type<SignupRiskSnapshot>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    clearedBy: text("cleared_by"),
    clearedReason: text("cleared_reason"),
  },
  (t) => [
    index("team_signup_risk_principal_idx").on(t.principalUserId),
    check("team_signup_risk_level_check", sql`${t.level} in ('good','sandbox','hold')`),
    check("team_signup_risk_version_check", sql`${t.policyVersion} in (1,2)`),
    check(
      "team_signup_risk_json_check",
      sql`jsonb_typeof(${t.reasons}) = 'array' and jsonb_typeof(${t.signals}) = 'object'`,
    ),
    check(
      "team_signup_risk_clear_check",
      sql`(${t.clearedAt} is null and ${t.clearedBy} is null and ${t.clearedReason} is null) or (${t.clearedAt} is not null and ${t.clearedBy} is not null and ${t.clearedReason} is not null and length(trim(${t.clearedReason})) > 0)`,
    ),
  ],
);

/** Private use context, readable only by the team's admins and instance operator.
 * Never copy context to audit, logs, notifications or digest payloads. */
export const signupRiskReviewRequests = pgTable(
  "signup_risk_review_requests",
  {
    teamId: uuid("team_id")
      .primaryKey()
      .references(() => teams.id, { onDelete: "cascade" }),
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
    context: text("context").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    index("signup_risk_review_requests_open_idx")
      .on(t.requestedAt)
      .where(sql`${t.resolvedAt} is null`),
    check(
      "signup_risk_review_requests_context_check",
      sql`length(${t.context}) between 20 and 500 and ${t.context} !~ '[[:cntrl:]]'`,
    ),
    check(
      "signup_risk_review_requests_time_check",
      sql`${t.updatedAt} >= ${t.requestedAt} and (${t.resolvedAt} is null or ${t.resolvedAt} >= ${t.requestedAt})`,
    ),
  ],
);
