BEGIN;

ALTER TABLE tenant_email_config
  ADD COLUMN IF NOT EXISTS sender_verification_token_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS sender_verification_requested_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenant_email_config_verification_hash_chk'
  ) THEN
    ALTER TABLE tenant_email_config
      ADD CONSTRAINT tenant_email_config_verification_hash_chk
        CHECK (sender_verification_token_hash IS NULL OR sender_verification_token_hash ~ '^[a-f0-9]{64}$');
  END IF;
END;
$$;

COMMIT;