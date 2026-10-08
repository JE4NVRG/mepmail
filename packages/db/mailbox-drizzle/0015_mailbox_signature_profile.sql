ALTER TABLE "mailboxes" ADD COLUMN "signature_profile" jsonb;
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_signature_profile_check" CHECK ("signature_profile" IS NULL OR (jsonb_typeof("signature_profile") = 'object' AND octet_length("signature_profile"::text) <= 2048));
