BEGIN;

ALTER TABLE institution_financial_products
  ADD COLUMN loan_recovery_max_attempts INTEGER NOT NULL DEFAULT 0 CHECK (loan_recovery_max_attempts BETWEEN 0 AND 20),
  ADD COLUMN loan_recovery_interval_minutes INTEGER NOT NULL DEFAULT 1440 CHECK (loan_recovery_interval_minutes BETWEEN 15 AND 43200);

ALTER TABLE institution_financial_transactions
  ADD COLUMN created_by_system BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE institution_financial_transactions
  DROP CONSTRAINT IF EXISTS institution_financial_transactions_requester_check,
  DROP CONSTRAINT IF EXISTS institution_financial_transactions_approval_state_check,
  ADD CONSTRAINT institution_financial_transactions_requester_check CHECK (
    (created_by_staff_id IS NOT NULL)::int +
    (created_by_tenant_user_id IS NOT NULL)::int +
    created_by_system::int = 1
  ),
  ADD CONSTRAINT institution_financial_transactions_approval_state_check CHECK (
    (status = 'PENDING_APPROVAL' AND approved_at IS NULL AND approved_by_staff_id IS NULL)
    OR (status IN ('PENDING_GATEWAY', 'POSTED', 'FAILED') AND (
      (approved_at IS NOT NULL AND approved_by_staff_id IS NOT NULL)
      OR (created_by_tenant_user_id IS NOT NULL AND approved_at IS NULL AND approved_by_staff_id IS NULL)
      OR (created_by_system AND approved_at IS NULL AND approved_by_staff_id IS NULL)
    ))
    OR (status = 'REJECTED' AND approved_at IS NOT NULL AND approved_by_staff_id IS NOT NULL)
  );

CREATE TABLE institution_loan_recovery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id UUID NOT NULL,
  installment_id UUID NOT NULL REFERENCES institution_loan_installments(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  transaction_id UUID NOT NULL UNIQUE REFERENCES institution_financial_transactions(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (installment_id, attempt_number)
);

CREATE INDEX idx_institution_loan_recovery_attempts_installment
  ON institution_loan_recovery_attempts(institution_id, installment_id, attempt_number DESC);

COMMIT;
