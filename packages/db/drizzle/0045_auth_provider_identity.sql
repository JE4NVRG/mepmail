-- Paired Better Auth >=1.7.3 provider identity; keep issuer data and legacy index.
-- Run through the existing migrateLocked/Drizzle transaction, never concurrently.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '30s';
--> statement-breakpoint
LOCK TABLE "public"."account" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $auth_provider_identity$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "public"."account"
    GROUP BY "provider_id", "account_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'auth_provider_account_duplicates_present';
  END IF;
END
$auth_provider_identity$;
--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_account_id_idx" ON "public"."account" USING btree ("provider_id", "account_id");
--> statement-breakpoint
ALTER TABLE "public"."account" ALTER COLUMN "issuer" DROP NOT NULL;
