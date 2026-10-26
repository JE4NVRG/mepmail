-- Separate the automatic signup allowance from intentional operator limits.
-- Do not guess the origin of legacy daily_send_ceiling values or alter holds.
ALTER TABLE "teams" ADD COLUMN "beta_daily_send_ceiling" integer;
