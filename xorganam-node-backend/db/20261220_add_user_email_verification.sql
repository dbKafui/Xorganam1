BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

UPDATE users
   SET email_verified_at = COALESCE(last_login_at, created_at)
 WHERE email_verified_at IS NULL;

CREATE TABLE email_verification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT email_verification_token_hash_chk
    CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT email_verification_expiry_after_creation_chk
    CHECK (expires_at > created_at),
  CONSTRAINT email_verification_use_after_creation_chk
    CHECK (used_at IS NULL OR used_at >= created_at)
);

CREATE INDEX idx_email_verification_tokens_user_created
  ON email_verification_tokens (user_id, created_at DESC);
CREATE INDEX idx_email_verification_tokens_active_expiry
  ON email_verification_tokens (expires_at)
  WHERE used_at IS NULL;

COMMIT;
