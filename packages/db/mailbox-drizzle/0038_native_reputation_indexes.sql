-- Parent registers the final migration number/journal; existing private tables only.
CREATE INDEX IF NOT EXISTS mailbox_outbox_team_accepted_idx ON mailbox_outbox(team_id, accepted_at, id) WHERE status = 'accepted';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mailbox_outbound_events_occurrence_idx ON mailbox_outbound_events(occurred_at, received_at, outbox_id);
