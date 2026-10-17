-- Expand the policy contract without rewriting legacy risk profiles or holds.
ALTER TABLE "user_signup_risk" DROP CONSTRAINT "user_signup_risk_version_check";
--> statement-breakpoint
ALTER TABLE "user_signup_risk" ADD CONSTRAINT "user_signup_risk_version_check" CHECK ("policy_version" IN (1,2));
--> statement-breakpoint
ALTER TABLE "user_signup_risk" ALTER COLUMN "policy_version" SET DEFAULT 2;
--> statement-breakpoint
ALTER TABLE "team_signup_risk" DROP CONSTRAINT "team_signup_risk_version_check";
--> statement-breakpoint
ALTER TABLE "team_signup_risk" ADD CONSTRAINT "team_signup_risk_version_check" CHECK ("policy_version" IN (1,2));
--> statement-breakpoint
ALTER TABLE "team_signup_risk" ALTER COLUMN "policy_version" SET DEFAULT 2;
--> statement-breakpoint
CREATE TABLE "signup_risk_review_requests" (
  "team_id" uuid PRIMARY KEY REFERENCES "teams"("id") ON DELETE CASCADE,
  "requested_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "context" text NOT NULL,
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_at" timestamptz,
  CONSTRAINT "signup_risk_review_requests_context_check" CHECK (length("context") BETWEEN 20 AND 500 AND "context" !~ '[[:cntrl:]]'),
  CONSTRAINT "signup_risk_review_requests_time_check" CHECK ("updated_at" >= "requested_at" AND ("resolved_at" IS NULL OR "resolved_at" >= "requested_at"))
);
--> statement-breakpoint
CREATE INDEX "signup_risk_review_requests_open_idx" ON "signup_risk_review_requests" ("requested_at") WHERE "resolved_at" IS NULL;
