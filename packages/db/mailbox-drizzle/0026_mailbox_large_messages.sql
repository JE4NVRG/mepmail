-- Received and imported mail can be large: messages and attachments up to 25 MiB
-- (Gmail's ceiling, under SES's 40 MB). The 1 MiB pilot cap made the receiver
-- refuse any email with a photo or a PDF. Only the ceilings change; the composer
-- keeps its own, smaller limit in code.
ALTER TABLE "mailbox_items" DROP CONSTRAINT "mailbox_items_raw_bytes_check";
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD CONSTRAINT "mailbox_items_raw_bytes_check" CHECK ("raw_bytes" BETWEEN 1 AND 26214400);
--> statement-breakpoint
ALTER TABLE "mailbox_items" DROP CONSTRAINT "mailbox_items_envelope_check";
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD CONSTRAINT "mailbox_items_envelope_check" CHECK ("key_version" >= 2000000 AND octet_length("iv") = 12 AND octet_length("ciphertext") BETWEEN 17 AND 26214416);
