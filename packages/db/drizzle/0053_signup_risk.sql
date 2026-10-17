CREATE TABLE IF NOT EXISTS "user_signup_risk" (
  "user_id" text PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  "captured_at" timestamptz NOT NULL DEFAULT now(),
  "source" text NOT NULL DEFAULT 'signup',
  "domain" text NOT NULL,
  "ip_key" text,
  "asn" bigint,
  "level" text NOT NULL DEFAULT 'sandbox',
  "policy_version" integer NOT NULL DEFAULT 1,
  "reasons" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "signals" jsonb NOT NULL,
  "verified_at" timestamptz,
  CONSTRAINT "user_signup_risk_source_check" CHECK ("source" IN ('signup','team_fallback')),
  CONSTRAINT "user_signup_risk_level_check" CHECK ("level" IN ('good','sandbox','hold')),
  CONSTRAINT "user_signup_risk_version_check" CHECK ("policy_version" = 1),
  CONSTRAINT "user_signup_risk_ip_check" CHECK ("ip_key" IS NULL OR "ip_key" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "user_signup_risk_asn_check" CHECK ("asn" IS NULL OR "asn" BETWEEN 1 AND 4294967295),
  CONSTRAINT "user_signup_risk_json_check" CHECK (jsonb_typeof("reasons") = 'array' AND jsonb_typeof("signals") = 'object')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_signup_risk_domain_time_idx" ON "user_signup_risk" ("domain", "captured_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_signup_risk_ip_time_idx" ON "user_signup_risk" ("ip_key", "captured_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_signup_risk_asn_time_idx" ON "user_signup_risk" ("asn", "captured_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_signup_risk" (
  "team_id" uuid PRIMARY KEY REFERENCES "teams"("id") ON DELETE CASCADE,
  "principal_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "level" text NOT NULL DEFAULT 'sandbox',
  "policy_version" integer NOT NULL DEFAULT 1,
  "reasons" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "signals" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "cleared_at" timestamptz,
  "cleared_by" text,
  "cleared_reason" text,
  CONSTRAINT "team_signup_risk_level_check" CHECK ("level" IN ('good','sandbox','hold')),
  CONSTRAINT "team_signup_risk_version_check" CHECK ("policy_version" = 1),
  CONSTRAINT "team_signup_risk_json_check" CHECK (jsonb_typeof("reasons") = 'array' AND jsonb_typeof("signals") = 'object'),
  CONSTRAINT "team_signup_risk_clear_check" CHECK (("cleared_at" IS NULL AND "cleared_by" IS NULL AND "cleared_reason" IS NULL) OR ("cleared_at" IS NOT NULL AND "cleared_by" IS NOT NULL AND "cleared_reason" IS NOT NULL AND length(trim("cleared_reason")) > 0))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_signup_risk_principal_idx" ON "team_signup_risk" ("principal_user_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "preserve_signup_risk_principal"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.principal_user_id IS DISTINCT FROM OLD.principal_user_id THEN
    IF NOT (NEW.principal_user_id IS NULL AND OLD.principal_user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "user" WHERE id = OLD.principal_user_id)) THEN
      RAISE EXCEPTION 'signup_risk_principal_immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "team_signup_risk_principal_immutable" BEFORE UPDATE ON "team_signup_risk"
FOR EACH ROW EXECUTE FUNCTION "preserve_signup_risk_principal"();
