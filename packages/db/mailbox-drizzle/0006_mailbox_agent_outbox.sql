-- Existing owner approvals retain their human authorization contract.
ALTER TABLE "mailbox_outbox" ADD COLUMN "approval_kind" text DEFAULT 'human' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mailbox_outbox" ADD COLUMN "agent_key_id" uuid;
--> statement-breakpoint
ALTER TABLE "mailbox_outbox" ADD CONSTRAINT "mailbox_outbox_approval_check" CHECK (("approval_kind" = 'human' AND "agent_key_id" IS NULL) OR ("approval_kind" = 'agent' AND "agent_key_id" IS NOT NULL));
--> statement-breakpoint
-- No credential FK: its deletion leaves the machine provenance intact and unusable.
-- In particular, ON DELETE SET NULL must never turn an agent approval into a human one.
CREATE FUNCTION "mailbox_outbox_authorization_immutable"() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."approval_kind" IS DISTINCT FROM OLD."approval_kind"
     OR NEW."agent_key_id" IS DISTINCT FROM OLD."agent_key_id"
     OR NEW."approved_by" IS DISTINCT FROM OLD."approved_by"
     OR NEW."approved_membership_id" IS DISTINCT FROM OLD."approved_membership_id"
     OR NEW."team_id" IS DISTINCT FROM OLD."team_id"
     OR NEW."mailbox_id" IS DISTINCT FROM OLD."mailbox_id" THEN
    RAISE EXCEPTION 'Mailbox outbox authorization is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "mailbox_outbox_authorization_immutable_trigger" BEFORE UPDATE OF "approval_kind", "agent_key_id", "approved_by", "approved_membership_id", "team_id", "mailbox_id" ON "mailbox_outbox" FOR EACH ROW EXECUTE FUNCTION "mailbox_outbox_authorization_immutable"();
