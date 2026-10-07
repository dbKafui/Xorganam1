BEGIN;
ALTER TABLE users
  ADD CONSTRAINT chk_branch_manager_requires_merchant
  CHECK (role <> 'TENANT_BRANCH_MANAGER' OR merchant_id IS NOT NULL);
COMMIT;
