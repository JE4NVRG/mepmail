-- A judge attempt retains the immutable team UUID after team erasure, just as
-- it retains message_id after source erasure. Counters and late settlement
-- still need the intact ledger; new attempts must still reference a live team.
CREATE FUNCTION public.sending_judge_live_team_on_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- Serialize new admission with deletion using the same parent lock strength
  -- as a foreign key. No update to the historical UUID is permitted.
  PERFORM id FROM public.teams WHERE id = NEW.team_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE foreign_key_violation USING
      MESSAGE = 'Judge attempt requires an existing team at admission',
      CONSTRAINT = 'sending_judge_attempts_live_team_on_insert';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sending_judge_attempts_live_team_on_insert
  BEFORE INSERT ON public.sending_judge_attempts
  FOR EACH ROW EXECUTE FUNCTION public.sending_judge_live_team_on_insert();
--> statement-breakpoint
ALTER TABLE public.sending_judge_attempts DROP CONSTRAINT sending_judge_attempts_team_id_fkey;
