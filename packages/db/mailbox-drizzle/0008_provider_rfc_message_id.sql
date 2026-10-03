ALTER TABLE "mailbox_outbox" ADD COLUMN "provider_rfc_message_id" text;
--> statement-breakpoint
ALTER TABLE "mailbox_outbox" ADD CONSTRAINT "mailbox_outbox_rfc_message_id_check" CHECK ("provider_rfc_message_id" is null or ("status" = 'accepted' and char_length("provider_rfc_message_id") between 5 and 512 and "provider_rfc_message_id" !~ '[[:space:][:cntrl:]]' and "provider_rfc_message_id" ~ '^<[^<>@]+@[^<>@]+>$'));
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_outbox_rfc_message_id_idx" ON "mailbox_outbox" ("mailbox_id", "provider_rfc_message_id") WHERE "provider_rfc_message_id" is not null;
