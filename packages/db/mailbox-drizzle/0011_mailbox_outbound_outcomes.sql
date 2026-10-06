ALTER TABLE "mailbox_outbox" ADD COLUMN "recipient_hashes" text[];
--> statement-breakpoint
ALTER TABLE "mailbox_outbox" ADD CONSTRAINT "mailbox_outbox_recipient_hashes_check" CHECK (
  recipient_hashes IS NULL OR (
    array_ndims(recipient_hashes) = 1 AND array_position(recipient_hashes, NULL) IS NULL AND cardinality(recipient_hashes) = recipient_count
    AND array_to_string(recipient_hashes, ',') ~ '^[a-f0-9]{64}(,[a-f0-9]{64}){0,19}$'
  )
);
--> statement-breakpoint
CREATE TABLE "mailbox_outbound_events" (
  "id" text PRIMARY KEY,
  "outbox_id" uuid NOT NULL REFERENCES "mailbox_outbox"("id") ON DELETE CASCADE,
  "attempt_id" uuid NOT NULL,
  "provider_message_id" text NOT NULL,
  "fingerprint" text NOT NULL,
  "outcome" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mailbox_outbound_events_hash_check" CHECK (id ~ '^[a-f0-9]{64}$' AND fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "mailbox_outbound_events_provider_check" CHECK (char_length(provider_message_id) BETWEEN 1 AND 512 AND provider_message_id !~ '[[:space:][:cntrl:]]'),
  CONSTRAINT "mailbox_outbound_events_outcome_check" CHECK (outcome IN ('send','delivered','soft_bounce','undetermined_bounce','delayed','hard_bounce','complaint','rejected','rendering_failed'))
);
--> statement-breakpoint
CREATE INDEX "mailbox_outbound_events_outbox_idx" ON "mailbox_outbound_events" ("outbox_id", "attempt_id");
--> statement-breakpoint
CREATE TABLE "mailbox_outbound_outcomes" (
  "event_id" text NOT NULL REFERENCES "mailbox_outbound_events"("id") ON DELETE CASCADE,
  "recipient_hash" text NOT NULL,
  PRIMARY KEY ("event_id", "recipient_hash"),
  CONSTRAINT "mailbox_outbound_outcomes_hash_check" CHECK (recipient_hash ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "mailbox_recipient_blocks" (
  "team_id" uuid NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "recipient_hash" text NOT NULL,
  "reason" text NOT NULL,
  "source_event_id" text NOT NULL,
  "blocked_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("team_id", "recipient_hash"),
  CONSTRAINT "mailbox_recipient_blocks_hash_check" CHECK (recipient_hash ~ '^[a-f0-9]{64}$' AND source_event_id ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "mailbox_recipient_blocks_reason_check" CHECK (reason IN ('hard_bounce','complaint'))
);
