-- Extra addresses that deliver into an existing mailbox on the same domain
-- (support@ -> jean@). An address is a mailbox or an alias, never both: the
-- app checks both tables under the domain lock before writing either.
CREATE TABLE "mailbox_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL,
  "mailbox_id" uuid NOT NULL,
  "domain_id" uuid NOT NULL,
  "address" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "mailbox_aliases_box_team_fk" FOREIGN KEY ("mailbox_id","team_id") REFERENCES "mailboxes"("id","team_id") ON DELETE cascade,
  CONSTRAINT "mailbox_aliases_domain_team_fk" FOREIGN KEY ("domain_id","team_id") REFERENCES "domains"("id","team_id") ON DELETE cascade,
  CONSTRAINT "mailbox_aliases_address_check" CHECK ("address" = lower("address") AND length("address") BETWEEN 3 AND 254)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_aliases_address_idx" ON "mailbox_aliases" ("address");
--> statement-breakpoint
CREATE INDEX "mailbox_aliases_mailbox_idx" ON "mailbox_aliases" ("mailbox_id");
