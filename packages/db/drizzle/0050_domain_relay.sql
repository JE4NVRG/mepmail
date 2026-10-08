ALTER TABLE "domains" ADD COLUMN IF NOT EXISTS "relay_enabled_at" timestamp with time zone;
