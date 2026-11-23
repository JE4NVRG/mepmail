-- Accounts kept out of the operator metrics without being deleted.
-- Additive and nullable: nothing changes for rows nobody flags.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS metrics_excluded_at timestamptz;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS metrics_excluded_reason text;

CREATE INDEX IF NOT EXISTS user_metrics_excluded_idx
  ON "user" (metrics_excluded_at)
  WHERE metrics_excluded_at IS NOT NULL;
