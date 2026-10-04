BEGIN;

DO $$
DECLARE constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'institution_financial_transactions'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%PENDING_APPROVAL%'
  LOOP
    EXECUTE format('ALTER TABLE institution_financial_transactions DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE institution_financial_transactions
  ADD CONSTRAINT institution_financial_transactions_approval_state_check CHECK (
    (status = 'PENDING_APPROVAL' AND approved_at IS NULL AND approved_by_staff_id IS NULL)
    OR (status IN ('PENDING_GATEWAY', 'POSTED', 'FAILED') AND (
      (approved_at IS NOT NULL AND approved_by_staff_id IS NOT NULL)
      OR (created_by_tenant_user_id IS NOT NULL AND approved_at IS NULL AND approved_by_staff_id IS NULL)
    ))
    OR (status = 'REJECTED' AND approved_at IS NOT NULL AND approved_by_staff_id IS NOT NULL)
  );

COMMIT;
