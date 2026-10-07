BEGIN;
ALTER TABLE institution_dispute
  ADD COLUMN raised_by_tenant_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
COMMIT;
