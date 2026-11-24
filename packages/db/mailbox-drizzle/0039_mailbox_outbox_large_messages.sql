-- The composer now sends real attachments (10 MiB each, 16 MiB per message): the
-- outbox keeps the approved message until SES accepts it, so it takes the same
-- 25 MiB ceiling as mailbox_items (0026). Only the ceilings change.
ALTER TABLE "mailbox_outbox" DROP CONSTRAINT IF EXISTS "mailbox_outbox_raw_bytes_check";
--> statement-breakpoint
ALTER TABLE "mailbox_outbox" ADD CONSTRAINT "mailbox_outbox_raw_bytes_check" CHECK ("raw_bytes" BETWEEN 1 AND 26214400);
--> statement-breakpoint
ALTER TABLE "mailbox_outbox" DROP CONSTRAINT "mailbox_outbox_payload_check";
--> statement-breakpoint
ALTER TABLE "mailbox_outbox" ADD CONSTRAINT "mailbox_outbox_payload_check" CHECK (("status" = 'accepted' AND "ciphertext" IS NULL AND "iv" IS NULL AND "wrapped_dek" IS NULL AND "key_version" IS NULL AND "provider_message_id" IS NOT NULL AND "accepted_at" IS NOT NULL) OR ("status" <> 'accepted' AND "ciphertext" IS NOT NULL AND "iv" IS NOT NULL AND "wrapped_dek" IS NOT NULL AND "key_version" >= 2000000 AND octet_length("iv") = 12 AND octet_length("ciphertext") BETWEEN 17 AND 26214416));
