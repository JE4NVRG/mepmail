-- Bind private outbox evidence without manufacturing public emails or deleting debt.
DO $$ BEGIN
 IF to_regclass('public.sending_judge_attempts') IS NULL THEN
  RAISE EXCEPTION 'Main graduated judge ledger migration0060 is required';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sending_judge_native_source_fk' AND conrelid='public.sending_judge_attempts'::regclass) THEN
  ALTER TABLE sending_judge_attempts ADD CONSTRAINT sending_judge_native_source_fk
   FOREIGN KEY(mailbox_outbox_id) REFERENCES mailbox_outbox(id) ON DELETE SET NULL;
 END IF;
END $$;
