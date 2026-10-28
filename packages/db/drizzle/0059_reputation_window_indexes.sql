-- Shared-pool reputation query: bound candidate work to the actual rolling window.
-- Existing large installations may prebuild these indexes concurrently through
-- their release owner before the transactional migrator runs. No data is changed.
CREATE INDEX IF NOT EXISTS emails_team_sent_window_idx
  ON emails (team_id, sent_at) WHERE sent_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_events_reputation_window_idx
  ON email_events (occurred_at, email_id)
  WHERE type IN ('sent', 'delivered', 'bounced', 'complained', 'delivery_delayed');
