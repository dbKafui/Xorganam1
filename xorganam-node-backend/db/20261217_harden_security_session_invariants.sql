BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_tenant_id_id
  ON users (tenant_id, id);

ALTER TABLE sessions
  ADD CONSTRAINT sessions_nonnegative_token_version_chk
    CHECK (token_version >= 0),
  ADD CONSTRAINT sessions_expiry_after_creation_chk
    CHECK (expires_at > created_at),
  ADD CONSTRAINT sessions_institution_has_no_tenant_chk
    CHECK (institution_staff_id IS NULL OR tenant_id IS NULL),
  ADD CONSTRAINT sessions_user_tenant_scope_fk
    FOREIGN KEY (tenant_id, user_id)
    REFERENCES users (tenant_id, id)
    ON DELETE CASCADE;

ALTER TABLE password_reset_tokens
  ADD CONSTRAINT password_reset_token_sha256_chk
    CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT password_reset_expiry_after_creation_chk
    CHECK (expires_at > created_at),
  ADD CONSTRAINT password_reset_use_after_creation_chk
    CHECK (used_at IS NULL OR used_at >= created_at);

CREATE OR REPLACE FUNCTION reject_platform_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_log is append-only'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER platform_audit_log_append_only
  BEFORE UPDATE OR DELETE ON platform_audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_platform_audit_mutation();

COMMIT;
