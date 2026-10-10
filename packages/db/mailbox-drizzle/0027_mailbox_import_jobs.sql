-- History import from another provider over IMAP. The job keeps where each folder
-- stands (UIDVALIDITY and the last UID imported) so it can resume, and never the
-- password: it lives only in the web process while the job runs, and a restart
-- leaves the job "interrupted" until the person types it again.
CREATE TABLE "mailbox_import_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "team_id" uuid NOT NULL,
  "mailbox_id" uuid NOT NULL,
  "created_by" text NOT NULL,
  "host" text NOT NULL,
  "port" integer NOT NULL,
  "username" text NOT NULL,
  "state" text DEFAULT 'running' NOT NULL,
  "folders" jsonb NOT NULL,
  "imported" integer DEFAULT 0 NOT NULL,
  "skipped" integer DEFAULT 0 NOT NULL,
  "failed" integer DEFAULT 0 NOT NULL,
  "bytes" bigint DEFAULT 0 NOT NULL,
  "error" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "mailbox_import_jobs_box_team_fk" FOREIGN KEY ("mailbox_id", "team_id") REFERENCES "mailboxes"("id", "team_id") ON DELETE CASCADE,
  CONSTRAINT "mailbox_import_jobs_state_check" CHECK ("state" IN ('running','done','failed','interrupted','canceled')),
  CONSTRAINT "mailbox_import_jobs_counts_check" CHECK ("imported" >= 0 AND "skipped" >= 0 AND "failed" >= 0 AND "bytes" >= 0 AND "port" = 993),
  CONSTRAINT "mailbox_import_jobs_error_check" CHECK ("error" IS NULL OR "error" IN ('login','network','protocol','blocked','quota','not_entitled','canceled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_import_jobs_running_idx" ON "mailbox_import_jobs" ("mailbox_id") WHERE "state" = 'running';
--> statement-breakpoint
CREATE INDEX "mailbox_import_jobs_box_idx" ON "mailbox_import_jobs" ("mailbox_id", "started_at");
