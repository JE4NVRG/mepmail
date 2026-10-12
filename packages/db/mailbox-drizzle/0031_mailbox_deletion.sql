-- Excluir caixa (Jean 2026-10-11). A team admin deletes a mailbox by typing its address:
-- it is suspended at once (no mail in or out, no reading, no agents), stops holding a
-- seat, and can be restored for 30 days. Past delete_after the worker erases its mail,
-- folders and send records and then the row itself, which frees the address and its
-- aliases. status_before_deletion is what a restore puts back.
ALTER TABLE "mailboxes" ADD COLUMN "deletion_requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "deletion_requested_by" text REFERENCES "user"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "delete_after" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD COLUMN "status_before_deletion" text;
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_deletion_check" CHECK (("deletion_requested_at" IS NULL) = ("delete_after" IS NULL) AND ("delete_after" IS NULL) = ("status_before_deletion" IS NULL) AND ("delete_after" IS NULL OR ("status" = 'suspended' AND "status_before_deletion" IN ('planned', 'suspended') AND "delete_after" > "deletion_requested_at")));
--> statement-breakpoint
CREATE INDEX "mailboxes_delete_after_idx" ON "mailboxes" ("delete_after") WHERE "delete_after" IS NOT NULL;
