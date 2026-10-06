ALTER TABLE "mailbox_items" ADD COLUMN "delivery_folder" text DEFAULT 'inbox' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD COLUMN "inbound_assessment" jsonb;
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD CONSTRAINT "mailbox_items_folder_check" CHECK (
  delivery_folder IN ('inbox','spam','quarantine')
  AND (kind = 'inbox' OR (delivery_folder = 'inbox' AND inbound_assessment IS NULL))
);
--> statement-breakpoint
ALTER TABLE "mailbox_items" ADD CONSTRAINT "mailbox_items_quarantine_check" CHECK (
  COALESCE((delivery_folder = 'quarantine') = (inbound_assessment->>'decision' = 'quarantine'), delivery_folder <> 'quarantine')
);
--> statement-breakpoint
CREATE INDEX "mailbox_items_folder_created_idx" ON "mailbox_items" ("mailbox_id", "kind", "delivery_folder", "created_at", "id");
