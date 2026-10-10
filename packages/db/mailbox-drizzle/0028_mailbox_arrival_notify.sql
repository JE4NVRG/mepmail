-- Live updates: a message received now is announced on the "mailbox_arrivals"
-- channel (Postgres NOTIFY) so open Correio windows refresh at once instead of
-- waiting for their next poll. Only identifiers travel (team, mailbox), never
-- content. History imports (source imap:…, old created_at) stay quiet.
CREATE OR REPLACE FUNCTION mailbox_item_arrived() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'inbox'
    AND NEW.created_at > now() - interval '10 minutes'
    AND (NEW.source_id IS NULL OR NEW.source_id NOT LIKE 'imap:%') THEN
    PERFORM pg_notify(
      'mailbox_arrivals',
      json_build_object('t', NEW.team_id, 'm', NEW.mailbox_id)::text
    );
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER mailbox_items_arrived
AFTER INSERT ON mailbox_items
FOR EACH ROW EXECUTE FUNCTION mailbox_item_arrived();
