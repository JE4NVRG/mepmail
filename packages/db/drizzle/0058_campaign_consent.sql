-- Deliberately no legacy approval/backfill. Apply through the existing migration owner.
CREATE TABLE campaign_consent_dossiers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
 evidence jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','revoked')),
 submitted_by text NOT NULL,
 submitted_at timestamptz NOT NULL DEFAULT now(),
 reviewed_by text,
 reviewed_at timestamptz,
 reason text,
 CONSTRAINT campaign_consent_review_audit CHECK (status = 'pending' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND length(reason) >= 15))
);
CREATE INDEX campaign_consent_team_submitted_idx ON campaign_consent_dossiers(team_id, submitted_at);
