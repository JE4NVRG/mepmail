-- A broadcast can wait on its own without stopping the team.
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS held_reason text;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS held_at timestamptz;

CREATE INDEX IF NOT EXISTS broadcasts_held_idx
  ON broadcasts (held_at) WHERE held_at IS NOT NULL;
