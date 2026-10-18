-- Explicit human send delegation includes read and draft without widening existing grants.
ALTER TABLE "mailbox_grants" DROP CONSTRAINT IF EXISTS "mailbox_grants_permission_check";
--> statement-breakpoint
ALTER TABLE "mailbox_grants" ADD CONSTRAINT "mailbox_grants_permission_check" CHECK ("permission" IN ('read', 'draft', 'send'));
