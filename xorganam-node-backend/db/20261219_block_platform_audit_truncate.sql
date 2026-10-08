BEGIN;

CREATE TRIGGER platform_audit_log_no_truncate
  BEFORE TRUNCATE ON platform_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION reject_platform_audit_mutation();

COMMIT;
