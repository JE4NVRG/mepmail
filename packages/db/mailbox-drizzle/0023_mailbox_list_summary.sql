-- A sealed list summary per item (subject, sender, short preview, date,
-- attachment count) so a list page opens a few hundred bytes per row instead of
-- decrypting and parsing the whole message. It is a cache: written the first
-- time a row is listed, cleared when a draft's content changes, and the list
-- falls back to the message whenever it is missing or does not open. Sealed
-- like the body (AES-GCM, bound to the row under its own row namespace).
ALTER TABLE "mailbox_items" ADD COLUMN "summary_ciphertext" bytea;
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD COLUMN "summary_iv" bytea;
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD COLUMN "summary_wrapped_dek" bytea;
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD COLUMN "summary_key_version" integer;
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD CONSTRAINT "mailbox_items_summary_check" CHECK (("summary_ciphertext" IS NULL AND "summary_iv" IS NULL AND "summary_wrapped_dek" IS NULL AND "summary_key_version" IS NULL) OR ("summary_key_version" >= 2000000 AND octet_length("summary_iv") = 12 AND octet_length("summary_ciphertext") BETWEEN 17 AND 8208 AND "summary_wrapped_dek" IS NOT NULL));
