-- A broadcast can wait on its own without stopping the team.
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS held_reason text;
--> statement-breakpoint
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS held_at timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS broadcasts_held_idx
  ON broadcasts (held_at) WHERE held_at IS NOT NULL;
