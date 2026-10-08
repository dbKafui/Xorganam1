BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_password_change_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS password_reset_required BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE institution_staff
  ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  institution_staff_id UUID REFERENCES institution_staff(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  token_version INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent TEXT,
  ip_address INET,
  CONSTRAINT chk_sessions_exact_principal CHECK (
    (user_id IS NOT NULL AND institution_staff_id IS NULL) OR
    (user_id IS NULL AND institution_staff_id IS NOT NULL)
  )
);

CREATE INDEX idx_sessions_user_created ON sessions (user_id, created_at DESC);
CREATE INDEX idx_sessions_institution_staff_created ON sessions (institution_staff_id, created_at DESC);
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);
CREATE INDEX idx_sessions_active_user_token_version
  ON sessions (user_id, token_version, revoked_at)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_active_institution_token_version
  ON sessions (institution_staff_id, token_version, revoked_at)
  WHERE revoked_at IS NULL;

CREATE TABLE password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(128) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_password_reset_tokens_token_hash ON password_reset_tokens (token_hash);
CREATE INDEX idx_password_reset_tokens_user_created ON password_reset_tokens (user_id, created_at DESC);

CREATE TABLE platform_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_institution_staff_id UUID REFERENCES institution_staff(id) ON DELETE SET NULL,
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  merchant_id UUID REFERENCES merchants(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address INET,
  user_agent TEXT,
  request_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_platform_audit_tenant_created ON platform_audit_log (tenant_id, created_at DESC);
CREATE INDEX idx_platform_audit_actor_created ON platform_audit_log (actor_user_id, created_at DESC);
CREATE INDEX idx_platform_audit_institution_actor_created
  ON platform_audit_log (actor_institution_staff_id, created_at DESC);
CREATE INDEX idx_platform_audit_resource ON platform_audit_log (resource_type, resource_id, created_at DESC);
CREATE INDEX idx_platform_audit_action_created ON platform_audit_log (action, created_at DESC);

COMMIT;
