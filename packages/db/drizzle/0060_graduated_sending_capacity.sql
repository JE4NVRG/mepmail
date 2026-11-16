CREATE TABLE sending_judge_account_debt (
 account_key text PRIMARY KEY, debt_units bigint NOT NULL DEFAULT 0 CHECK(debt_units>=0),
 last_meter_id text NOT NULL,last_meter_at timestamptz NOT NULL,last_remaining_units bigint NOT NULL CHECK(last_remaining_units>0)
);
-- Additive bounded judge ledger; audit_log is append-only and cannot index mutable pending status.
CREATE TABLE sending_judge_attempts (
 account_key text NOT NULL, attempt_id uuid NOT NULL, team_id uuid NOT NULL REFERENCES teams(id),
 message_kind text NOT NULL CHECK(message_kind IN ('email','mailbox')), message_id uuid NOT NULL,
 email_id uuid REFERENCES emails(id) ON DELETE SET NULL, mailbox_outbox_id uuid,
 CHECK((message_kind='email' AND mailbox_outbox_id IS NULL AND (email_id IS NULL OR email_id=message_id))
    OR (message_kind='mailbox' AND email_id IS NULL AND (mailbox_outbox_id IS NULL OR mailbox_outbox_id=message_id))),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'), reserved_tokens bigint NOT NULL CHECK(reserved_tokens>0), reserved_units bigint NOT NULL CHECK(reserved_units>0),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ambiguous','settled')), outcome text CHECK(outcome IN ('accepted','rejected','failed')),
 actual_units bigint CHECK(actual_units>=0 AND actual_units<=reserved_units), created_at timestamptz NOT NULL DEFAULT clock_timestamp(), reconciled_at timestamptz,
 PRIMARY KEY(account_key,attempt_id), CHECK((state='settled')=(reconciled_at IS NOT NULL AND actual_units IS NOT NULL AND outcome IS NOT NULL))
);
CREATE INDEX sending_judge_email_source_idx ON sending_judge_attempts(email_id) WHERE email_id IS NOT NULL;
CREATE INDEX sending_judge_native_source_idx ON sending_judge_attempts(mailbox_outbox_id) WHERE mailbox_outbox_id IS NOT NULL;
CREATE INDEX sending_judge_recent_idx ON sending_judge_attempts(account_key,created_at);
CREATE INDEX sending_judge_pending_idx ON sending_judge_attempts(account_key) WHERE state<>'settled';
CREATE INDEX sending_judge_settled_idx ON sending_judge_attempts(account_key,reconciled_at) WHERE state='settled';
CREATE UNIQUE INDEX audit_graduated_seen_idx ON audit_log(team_id,target) WHERE action='sending.graduated_recipient_seen';
CREATE INDEX audit_graduated_target_idx ON audit_log(action,team_id,target);
-- Reversal: retain ledger/audit business evidence. Disable callers first. Do not DROP a nonempty ledger.

-- Persistent identity survives source deletion; only nullable FK pointers clear.
CREATE FUNCTION sending_judge_subject_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF (NEW.message_kind='email' AND NEW.email_id IS NULL) OR (NEW.message_kind='mailbox' AND NEW.mailbox_outbox_id IS NULL) THEN
   RAISE EXCEPTION 'Judge attempt requires a concrete source witness' USING ERRCODE='23514';
  END IF;
 ELSIF (NEW.account_key,NEW.attempt_id,NEW.team_id,NEW.message_kind,NEW.message_id,NEW.fingerprint,NEW.reserved_tokens,NEW.reserved_units,NEW.created_at) IS DISTINCT FROM
       (OLD.account_key,OLD.attempt_id,OLD.team_id,OLD.message_kind,OLD.message_id,OLD.fingerprint,OLD.reserved_tokens,OLD.reserved_units,OLD.created_at) THEN
  RAISE EXCEPTION 'Judge subject identity is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sending_judge_subject_guard BEFORE INSERT OR UPDATE ON sending_judge_attempts
 FOR EACH ROW EXECUTE FUNCTION sending_judge_subject_guard();
-- Native table lives in the private migration set. Existing installations can bind now;
-- fresh installations bind after mailbox DDL through private migration0037.
DO $$ BEGIN
 IF to_regclass('public.mailbox_outbox') IS NOT NULL THEN
  ALTER TABLE sending_judge_attempts ADD CONSTRAINT sending_judge_native_source_fk
   FOREIGN KEY(mailbox_outbox_id) REFERENCES mailbox_outbox(id) ON DELETE SET NULL;
 END IF;
END $$;
