-- =====================================================================
-- Migration: Add merchant_id and permission_type to users table for
-- merchant-specific user isolation and permission-based access control.
-- =====================================================================

-- Add merchant_id to users table (nullable - NULL means tenant-level user)
ALTER TABLE users ADD COLUMN merchant_id UUID REFERENCES merchants (id) ON DELETE CASCADE;

-- Create constraint: if merchant_id is not null, it must belong to the same tenant
ALTER TABLE users ADD CONSTRAINT fk_users_merchant_tenant
  FOREIGN KEY (tenant_id, merchant_id)
  REFERENCES merchants (tenant_id, id)
  ON DELETE CASCADE;

-- Add index for efficient merchant user lookups
CREATE INDEX idx_users_merchant ON users (merchant_id);
CREATE INDEX idx_users_tenant_merchant ON users (tenant_id, merchant_id);

-- =====================================================================
-- Create user_permissions table for permission-based access control
-- =====================================================================
CREATE TABLE user_permissions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    tenant_id           UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    
    permission_type     VARCHAR(100) NOT NULL,
    
    -- resource_id can be merchant_id, transaction_id, etc. depending on permission_type
    -- NULL means the permission applies globally at tenant level
    resource_id         UUID,
    
    granted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    granted_by_user_id  UUID REFERENCES users (id) ON DELETE SET NULL,
    
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    CONSTRAINT uq_user_permission UNIQUE (user_id, permission_type, resource_id)
);

CREATE INDEX idx_user_permissions_user ON user_permissions (user_id);
CREATE INDEX idx_user_permissions_tenant ON user_permissions (tenant_id);
CREATE INDEX idx_user_permissions_tenant_type ON user_permissions (tenant_id, permission_type);

-- =====================================================================
-- Add created_at trigger for user_permissions if needed
-- =====================================================================
CREATE TRIGGER trg_user_permissions_updated_at BEFORE UPDATE ON user_permissions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
