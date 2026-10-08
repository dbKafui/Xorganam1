BEGIN;

ALTER TABLE platform_audit_log
  ADD CONSTRAINT platform_audit_log_at_most_one_actor_chk
  CHECK (
    (actor_user_id IS NOT NULL)::integer
    + (actor_institution_staff_id IS NOT NULL)::integer
    <= 1
  );

CREATE INDEX IF NOT EXISTS idx_platform_audit_actor_type_created
  ON platform_audit_log (actor_user_id, actor_institution_staff_id, created_at DESC);

COMMIT;
