BEGIN;

ALTER TABLE platform_audit_log
  DROP CONSTRAINT platform_audit_log_actor_user_id_fkey,
  DROP CONSTRAINT platform_audit_log_actor_institution_staff_id_fkey,
  DROP CONSTRAINT platform_audit_log_tenant_id_fkey,
  DROP CONSTRAINT platform_audit_log_merchant_id_fkey;

COMMIT;
