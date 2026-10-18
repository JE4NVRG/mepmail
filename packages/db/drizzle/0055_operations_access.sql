ALTER TABLE "team_members" ADD COLUMN "operations_access" jsonb;
--> statement-breakpoint
ALTER TABLE "team_invitations" ADD COLUMN "operations_access" jsonb;
--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_operations_access_check"
CHECK ("operations_access" IS NULL OR COALESCE((
  "role" = 'member' AND jsonb_typeof("operations_access") = 'object'
  AND "operations_access"->>'version' = '1'
  AND jsonb_typeof("operations_access"->'userDirectoryRead') = 'boolean'
  AND jsonb_typeof("operations_access"->'mailboxCreateDomainIds') = 'array'
  AND octet_length("operations_access"::text) <= 4096
), false));
--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_operations_access_check"
CHECK ("operations_access" IS NULL OR COALESCE((
  "role" = 'member' AND jsonb_typeof("operations_access") = 'object'
  AND "operations_access"->>'version' = '1'
  AND jsonb_typeof("operations_access"->'userDirectoryRead') = 'boolean'
  AND jsonb_typeof("operations_access"->'mailboxCreateDomainIds') = 'array'
  AND jsonb_typeof("operations_access"->'sendMailboxIds') = 'array'
  AND octet_length("operations_access"::text) <= 8192
), false));
--> statement-breakpoint
CREATE INDEX "team_members_operations_user_idx" ON "team_members" ("user_id")
WHERE "operations_access" IS NOT NULL;
