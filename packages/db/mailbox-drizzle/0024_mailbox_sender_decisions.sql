-- Aprovação de remetentes: the owner's allow/block answer per sender of one
-- mailbox. No address in the clear: sender_key is an HMAC of the normalized
-- address scoped to the mailbox (for lookups at listing and receipt), and the
-- address itself is sealed like message content (bound envelope) so the owner
-- can review and undo decisions.
CREATE TABLE "mailbox_sender_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL,
  "mailbox_id" uuid NOT NULL,
  "sender_key" bytea NOT NULL,
  "decision" text NOT NULL,
  "address_ciphertext" bytea NOT NULL,
  "address_iv" bytea NOT NULL,
  "address_wrapped_dek" bytea NOT NULL,
  "address_key_version" integer NOT NULL,
  "decided_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mailbox_sender_decisions_box_team_fk" FOREIGN KEY ("mailbox_id", "team_id") REFERENCES "mailboxes"("id", "team_id") ON DELETE CASCADE,
  CONSTRAINT "mailbox_sender_decisions_decision_check" CHECK ("decision" IN ('allow','block')),
  CONSTRAINT "mailbox_sender_decisions_key_check" CHECK (octet_length("sender_key") = 32),
  CONSTRAINT "mailbox_sender_decisions_address_check" CHECK ("address_key_version" >= 2000000 AND octet_length("address_iv") = 12 AND octet_length("address_ciphertext") BETWEEN 17 AND 1100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_sender_decisions_box_sender_idx" ON "mailbox_sender_decisions" USING btree ("mailbox_id","sender_key");
--> statement-breakpoint
CREATE INDEX "mailbox_sender_decisions_box_updated_idx" ON "mailbox_sender_decisions" USING btree ("mailbox_id","updated_at");
