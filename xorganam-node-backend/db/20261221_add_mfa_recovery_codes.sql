BEGIN;

CREATE TABLE mfa_recovery_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  institution_staff_id UUID REFERENCES institution_staff(id) ON DELETE CASCADE,
  code_hash CHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at TIMESTAMPTZ,
  CONSTRAINT mfa_recovery_code_principal_chk CHECK (
    (user_id IS NOT NULL AND institution_staff_id IS NULL) OR
    (user_id IS NULL AND institution_staff_id IS NOT NULL)
  ),
  CONSTRAINT mfa_recovery_code_hash_chk CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT mfa_recovery_code_use_after_creation_chk CHECK (used_at IS NULL OR used_at >= created_at)
);

CREATE INDEX idx_mfa_recovery_codes_active_user
  ON mfa_recovery_codes (user_id, created_at DESC) WHERE used_at IS NULL;
CREATE INDEX idx_mfa_recovery_codes_active_institution
  ON mfa_recovery_codes (institution_staff_id, created_at DESC) WHERE used_at IS NULL;

COMMIT;
